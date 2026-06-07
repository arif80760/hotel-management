-- =============================================================
-- 2026-06-07-booking-overlap-guard.sql
-- Double-booking guard inside the booking-write RPCs.
--
-- Adds an in-transaction availability check to BOTH paths that
-- create booking_rooms rows:
--   create_booking_with_rooms  — checks every room before inserting
--   add_room_to_booking        — was previously UNGUARDED
--
-- A room is considered taken if a non-cancelled, active booking
-- ('confirmed' | 'checked_in') overlaps the requested range using
-- the half-open rule daterange(check_in, COALESCE(actual_checkout,
-- check_out), '[)') — so same-day checkout→check-in is allowed.
-- On conflict the RPC RAISEs a clear "Room N is already booked"
-- error and the whole transaction rolls back (fails closed).
--
-- This supersedes the browser-side createBooking "step 2.5" check,
-- which (a) failed OPEN on query error, (b) did not cover
-- add_room_to_booking, and (c) ran outside the write transaction.
--
-- NOTE: the race-proof backstop is a GiST EXCLUDE constraint on
-- booking_rooms; it can only be added once existing overlapping
-- (test) rows are cleared, so it is deferred to pre-launch cleanup.
-- =============================================================

CREATE OR REPLACE FUNCTION public.create_booking_with_rooms(
  p_booking_ref text, p_primary_guest_id uuid, p_total_guests smallint,
  p_rooms jsonb, p_total_amount numeric, p_initial_payment numeric DEFAULT 0,
  p_payment_method text DEFAULT NULL::text, p_recorded_by uuid DEFAULT NULL::uuid,
  p_status text DEFAULT 'confirmed'::text
)
 RETURNS uuid LANGUAGE plpgsql
AS $function$
DECLARE
  v_booking_id UUID; v_room JSONB;
  v_first_room_id UUID; v_first_check_in DATE; v_first_check_out DATE; v_first_category TEXT;
  v_booking_status public.booking_status; v_physical_room_status public.room_status;
  v_expected_total NUMERIC;
BEGIN
  SELECT COALESCE(SUM((r->>'rate')::NUMERIC * (r->>'nights')::INTEGER),0)
  INTO v_expected_total FROM jsonb_array_elements(p_rooms) AS r;
  IF ABS(p_total_amount - v_expected_total) > 0.01 THEN
    RAISE EXCEPTION 'create_booking_with_rooms: total_amount mismatch — provided %, computed %.', p_total_amount, v_expected_total;
  END IF;
  IF p_status NOT IN ('confirmed','checked_in') THEN
    RAISE EXCEPTION 'Invalid p_status ''%''. Only ''confirmed'' or ''checked_in'' accepted.', p_status;
  END IF;

  -- ── Availability guard: reject if any room overlaps an active booking ──────
  FOR v_room IN SELECT value FROM jsonb_array_elements(p_rooms) LOOP
    IF EXISTS (
      SELECT 1 FROM public.booking_rooms x
      WHERE x.room_id = (v_room->>'room_id')::uuid
        AND x.status IN ('confirmed','checked_in')
        AND daterange(x.check_in_date, COALESCE(x.actual_checkout_date, x.check_out_date), '[)')
         && daterange((v_room->>'check_in_date')::date, (v_room->>'check_out_date')::date, '[)')
    ) THEN
      RAISE EXCEPTION 'Room % is already booked for % to %',
        (SELECT room_number FROM public.rooms WHERE id = (v_room->>'room_id')::uuid),
        (v_room->>'check_in_date'), (v_room->>'check_out_date');
    END IF;
  END LOOP;

  v_booking_status := p_status::public.booking_status;
  v_physical_room_status := CASE p_status WHEN 'checked_in' THEN 'occupied'::public.room_status ELSE 'reserved'::public.room_status END;

  v_first_room_id := (p_rooms->0->>'room_id')::UUID;
  v_first_check_in := (p_rooms->0->>'check_in_date')::DATE;
  v_first_check_out := (p_rooms->0->>'check_out_date')::DATE;
  v_first_category := (p_rooms->0->>'category');

  INSERT INTO public.bookings (
    booking_ref, primary_guest_id, total_guests, status, total_amount, paid_amount,
    payment_status, confirmed_at, checked_in_at, room_id, check_in_date, check_out_date, room_category_at_booking
  ) VALUES (
    p_booking_ref, p_primary_guest_id, p_total_guests, v_booking_status, p_total_amount, 0,
    'unpaid', NOW(), CASE WHEN p_status='checked_in' THEN NOW() ELSE NULL END,
    v_first_room_id, v_first_check_in, v_first_check_out, v_first_category
  ) RETURNING id INTO v_booking_id;

  FOR v_room IN SELECT value FROM jsonb_array_elements(p_rooms) LOOP
    INSERT INTO public.booking_rooms (
      booking_id, room_id, check_in_date, check_out_date, nights,
      room_category, booking_rate, status, confirmed_at, checked_in_at
    ) VALUES (
      v_booking_id, (v_room->>'room_id')::UUID, (v_room->>'check_in_date')::DATE,
      (v_room->>'check_out_date')::DATE, (v_room->>'nights')::SMALLINT, (v_room->>'category'),
      (v_room->>'rate')::NUMERIC, v_booking_status, NOW(),
      CASE WHEN p_status='checked_in' THEN NOW() ELSE NULL END
    );
    UPDATE public.rooms SET status = v_physical_room_status, updated_at = NOW()
    WHERE id = (v_room->>'room_id')::UUID;
  END LOOP;

  IF p_initial_payment > 0 AND p_payment_method IS NOT NULL THEN
    INSERT INTO public.payments (booking_id, amount, method, recorded_by)
    VALUES (v_booking_id, p_initial_payment, p_payment_method::public.payment_method, p_recorded_by);
  END IF;

  RETURN v_booking_id;
END;
$function$;


CREATE OR REPLACE FUNCTION public.add_room_to_booking(
  p_booking_id uuid, p_room_id uuid, p_check_in_date date, p_check_out_date date,
  p_nights smallint, p_category text, p_rate numeric, p_room_status public.booking_status
)
 RETURNS uuid LANGUAGE plpgsql
AS $function$
DECLARE
  v_room_row_id UUID; v_physical_status public.room_status;
BEGIN
  -- ── Availability guard ────────────────────────────────────────────────────
  IF EXISTS (
    SELECT 1 FROM public.booking_rooms x
    WHERE x.room_id = p_room_id
      AND x.status IN ('confirmed','checked_in')
      AND daterange(x.check_in_date, COALESCE(x.actual_checkout_date, x.check_out_date), '[)')
       && daterange(p_check_in_date, p_check_out_date, '[)')
  ) THEN
    RAISE EXCEPTION 'Room % is already booked for % to %',
      (SELECT room_number FROM public.rooms WHERE id = p_room_id), p_check_in_date, p_check_out_date;
  END IF;

  INSERT INTO public.booking_rooms (
    booking_id, room_id, check_in_date, check_out_date, nights,
    room_category, booking_rate, status, confirmed_at, checked_in_at
  ) VALUES (
    p_booking_id, p_room_id, p_check_in_date, p_check_out_date, p_nights,
    p_category, p_rate, p_room_status, NOW(),
    CASE WHEN p_room_status='checked_in' THEN NOW() ELSE NULL END
  ) RETURNING id INTO v_room_row_id;

  PERFORM public.update_booking_total(p_booking_id);

  v_physical_status := CASE p_room_status
    WHEN 'confirmed' THEN 'reserved'::public.room_status
    WHEN 'checked_in' THEN 'occupied'::public.room_status
    ELSE 'reserved'::public.room_status END;
  UPDATE public.rooms SET status = v_physical_status, updated_at = NOW() WHERE id = p_room_id;

  RETURN v_room_row_id;
END;
$function$;

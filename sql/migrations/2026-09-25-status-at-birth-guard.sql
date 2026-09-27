-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-09-25 — Status-at-birth guard: no booking (or room row) may be BORN
-- checked_in with a future check-in date. RECORD OF LIVE STATE — applied by
-- Arif in the Supabase SQL editor on 2026-09-25 and probe-verified same day.
--
-- Incident BK-1915: the New Booking form accepted status = Checked In with
-- check_in_date two days in the future (created_at, confirmed_at and
-- checked_in_at all identical; dates Sep 27 → Oct 1). Room 405 went
-- physically occupied for a guest not present. The Check In BUTTON's date
-- restriction was fine — creation bypassed it by setting the status
-- directly, and create_booking_with_rooms validated date order, total and
-- overlap but never date-vs-status.
--
-- Fix at both layers (standing doctrine):
--   • Client: New Booking form validate() rejects Checked In + future
--     check-in per room row, Dhaka-local ("Check-in date is in the future —
--     save as Confirmed, or correct the date for a walk-in"). BookingsClient
--     is the ONLY create surface (FrontDesk has no create path; the
--     RoomBoard ?room= deep link lands in the same form).
--   • Server (this file): both RPCs below reject checked_in with
--     check_in_date > (now() AT TIME ZONE 'Asia/Dhaka')::date, fail-loud,
--     so no other caller can recreate BK-1915.
--
-- Back-dated check-ins stay allowed (late entry is legitimate — only
-- FUTURE check-ins are impossible to be standing at the desk for).
--
-- add_room_to_booking: the client always passes p_room_status='confirmed'
-- (bookingsService), so its gap was not UI-reachable — guarded anyway
-- because the RPC accepted checked_in with any future date.
--
-- Bodies otherwise verbatim from live (fetched via pg_get_functiondef
-- 2026-09-25); the guards are the only additions.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.create_booking_with_rooms(p_booking_ref text, p_primary_guest_id uuid, p_total_guests smallint, p_rooms jsonb, p_total_amount numeric, p_initial_payment numeric DEFAULT 0, p_payment_method text DEFAULT NULL::text, p_recorded_by uuid DEFAULT NULL::uuid, p_status text DEFAULT 'confirmed'::text)
 RETURNS uuid
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_booking_id           UUID;
  v_booking_ref          TEXT;
  v_room                 JSONB;
  v_first_room_id        UUID;
  v_first_check_in       DATE;
  v_first_check_out      DATE;
  v_first_category       TEXT;
  v_booking_status       public.booking_status;
  v_physical_room_status public.room_status;
  v_expected_total       NUMERIC;
BEGIN
  -- NIGHTS ARE DERIVED FROM THE DATES (2026-08-17). The client's JSON
  -- 'nights' key is IGNORED (BK-1400) — see 2026-08-17 migration.
  FOR v_room IN SELECT value FROM jsonb_array_elements(p_rooms) LOOP
    IF ((v_room->>'check_out_date')::DATE - (v_room->>'check_in_date')::DATE) < 1 THEN
      RAISE EXCEPTION 'create_booking_with_rooms: check_out_date must be after check_in_date for room % (got % to %).',
        (SELECT room_number FROM public.rooms WHERE id = (v_room->>'room_id')::UUID),
        (v_room->>'check_in_date'), (v_room->>'check_out_date');
    END IF;
  END LOOP;

  SELECT COALESCE(SUM( (r->>'rate')::NUMERIC * ((r->>'check_out_date')::DATE - (r->>'check_in_date')::DATE) ), 0)
  INTO v_expected_total FROM jsonb_array_elements(p_rooms) AS r;

  IF ABS(p_total_amount - v_expected_total) > 0.01 THEN
    RAISE EXCEPTION 'create_booking_with_rooms: total_amount mismatch — provided %, computed % from rooms.',
      p_total_amount, v_expected_total;
  END IF;

  IF p_status NOT IN ('confirmed', 'checked_in') THEN
    RAISE EXCEPTION 'Invalid p_status ''%''. Only ''confirmed'' or ''checked_in'' accepted.', p_status;
  END IF;

  -- STATUS-AT-BIRTH GUARD (2026-09-25, BK-1915): a booking cannot be BORN
  -- checked_in for a stay that has not started. Dhaka-local today, per the
  -- standing timezone rule; back-dated check-ins pass (late entry).
  IF p_status = 'checked_in' THEN
    FOR v_room IN SELECT value FROM jsonb_array_elements(p_rooms) LOOP
      IF (v_room->>'check_in_date')::DATE > (now() AT TIME ZONE 'Asia/Dhaka')::date THEN
        RAISE EXCEPTION 'create_booking_with_rooms: cannot create as checked_in — room % check-in % is in the future (today is % in Dhaka). Save as confirmed, or correct the date for a walk-in.',
          (SELECT room_number FROM public.rooms WHERE id = (v_room->>'room_id')::UUID),
          (v_room->>'check_in_date'), (now() AT TIME ZONE 'Asia/Dhaka')::date;
      END IF;
    END LOOP;
  END IF;

  -- RESTORED GUARD (2026-06-07). Runs before nextval so a rejected booking
  -- does not burn a booking_ref number.
  FOR v_room IN SELECT value FROM jsonb_array_elements(p_rooms) LOOP
    IF EXISTS (
      SELECT 1 FROM public.booking_rooms x
      WHERE x.room_id = (v_room->>'room_id')::UUID
        AND x.status IN ('confirmed','checked_in')
        AND daterange(x.check_in_date, COALESCE(x.actual_checkout_date, x.check_out_date), '[)')
         && daterange((v_room->>'check_in_date')::DATE, (v_room->>'check_out_date')::DATE, '[)')
    ) THEN
      RAISE EXCEPTION 'Room % is already booked for % to %',
        (SELECT room_number FROM public.rooms WHERE id = (v_room->>'room_id')::UUID),
        (v_room->>'check_in_date'), (v_room->>'check_out_date');
    END IF;
  END LOOP;

  -- Server-assigned reference. Loop guards against any legacy value already in use.
  LOOP
    v_booking_ref := 'BK-' || nextval('public.booking_ref_seq')::TEXT;
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.bookings WHERE booking_ref = v_booking_ref);
  END LOOP;

  v_booking_status := p_status::public.booking_status;
  v_physical_room_status := CASE p_status
    WHEN 'checked_in' THEN 'occupied'::public.room_status
    ELSE 'reserved'::public.room_status END;

  v_first_room_id   := (p_rooms->0->>'room_id')::UUID;
  v_first_check_in  := (p_rooms->0->>'check_in_date')::DATE;
  v_first_check_out := (p_rooms->0->>'check_out_date')::DATE;
  v_first_category  := (p_rooms->0->>'category');

  INSERT INTO public.bookings (
    booking_ref, primary_guest_id, total_guests, status,
    total_amount, paid_amount, payment_status, confirmed_at, checked_in_at,
    room_id, check_in_date, check_out_date, room_category_at_booking
  ) VALUES (
    v_booking_ref, p_primary_guest_id, p_total_guests, v_booking_status,
    p_total_amount, 0, 'unpaid', NOW(),
    CASE WHEN p_status = 'checked_in' THEN NOW() ELSE NULL END,
    v_first_room_id, v_first_check_in, v_first_check_out, v_first_category
  ) RETURNING id INTO v_booking_id;

  FOR v_room IN SELECT value FROM jsonb_array_elements(p_rooms) LOOP
    INSERT INTO public.booking_rooms (
      booking_id, room_id, check_in_date, check_out_date, nights,
      room_category, booking_rate, status, confirmed_at, checked_in_at
    ) VALUES (
      v_booking_id, (v_room->>'room_id')::UUID, (v_room->>'check_in_date')::DATE,
      (v_room->>'check_out_date')::DATE,
      ((v_room->>'check_out_date')::DATE - (v_room->>'check_in_date')::DATE)::SMALLINT,  -- derived, never p_rooms nights
      (v_room->>'category'), (v_room->>'rate')::NUMERIC, v_booking_status,
      NOW(), CASE WHEN p_status = 'checked_in' THEN NOW() ELSE NULL END
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

CREATE OR REPLACE FUNCTION public.add_room_to_booking(p_booking_id uuid, p_room_id uuid, p_check_in_date date, p_check_out_date date, p_nights smallint, p_category text, p_rate numeric, p_room_status booking_status)
 RETURNS uuid
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_room_row_id      UUID;
  v_physical_status  public.room_status;
  v_nights           SMALLINT;
  v_ref              TEXT;
  v_from             DATE;
  v_until            DATE;
  v_cstatus          TEXT;
BEGIN
  IF p_check_out_date <= p_check_in_date THEN
    RAISE EXCEPTION 'add_room_to_booking: check_out_date must be after check_in_date (got % to %).',
      p_check_in_date, p_check_out_date;
  END IF;

  -- STATUS-AT-BIRTH GUARD (2026-09-25, BK-1915): same rule as
  -- create_booking_with_rooms. Not UI-reachable (client always passes
  -- 'confirmed') — guarded fail-loud for any other caller.
  IF p_room_status = 'checked_in' AND p_check_in_date > (now() AT TIME ZONE 'Asia/Dhaka')::date THEN
    RAISE EXCEPTION 'add_room_to_booking: cannot add room as checked_in — check-in % is in the future (today is % in Dhaka).',
      p_check_in_date, (now() AT TIME ZONE 'Asia/Dhaka')::date;
  END IF;

  v_nights := (p_check_out_date - p_check_in_date)::smallint;

  SELECT b.booking_ref, x.check_in_date,
         COALESCE(x.actual_checkout_date, x.check_out_date), x.status::text
  INTO   v_ref, v_from, v_until, v_cstatus
  FROM   public.booking_rooms x
  JOIN   public.bookings b ON b.id = x.booking_id
  WHERE  x.room_id = p_room_id
    AND  x.status IN ('confirmed','checked_in')
    AND  daterange(x.check_in_date, COALESCE(x.actual_checkout_date, x.check_out_date), '[)')
      && daterange(p_check_in_date, p_check_out_date, '[)')
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'Room % is unavailable for % – %: booking % covers % – % (%).',
      (SELECT room_number FROM public.rooms WHERE id = p_room_id),
      p_check_in_date, p_check_out_date, v_ref, v_from, v_until, v_cstatus;
  END IF;

  INSERT INTO public.booking_rooms (
    booking_id, room_id, check_in_date, check_out_date, nights,
    room_category, booking_rate, status, confirmed_at, checked_in_at
  ) VALUES (
    p_booking_id, p_room_id, p_check_in_date, p_check_out_date, v_nights,
    p_category, p_rate, p_room_status, NOW(),
    CASE WHEN p_room_status = 'checked_in' THEN NOW() ELSE NULL END
  ) RETURNING id INTO v_room_row_id;

  PERFORM public.update_booking_total(p_booking_id);

  v_physical_status := CASE p_room_status
    WHEN 'confirmed'  THEN 'reserved'::public.room_status
    WHEN 'checked_in' THEN 'occupied'::public.room_status
    ELSE 'reserved'::public.room_status END;

  UPDATE public.rooms SET status = v_physical_status, updated_at = NOW()
  WHERE id = p_room_id;

  RETURN v_room_row_id;
END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Verification (2026-09-25, ROLLBACK-wrapped probe): synthetic guest + two
-- free rooms for [Dhaka-today+2, Dhaka-today+4). (1) create_booking_with_rooms
-- with p_status='checked_in' → raised the future-check-in exception;
-- (2) identical call with 'confirmed' → created (control); (3)
-- add_room_to_booking with p_room_status='checked_in' on the same future
-- span → raised. PASSED.
--
-- BK-1915 data correction (one-off, applied 2026-09-25): booking + its
-- booking_rooms reverted checked_in → confirmed with checked_in_at cleared
-- (fn_stamp_booking_timestamps only fills NULL timestamps, never clears, so
-- the NULL survives); room 405 occupied → reserved. The stay now check-ins
-- normally on Sep 27.
-- ─────────────────────────────────────────────────────────────────────────────

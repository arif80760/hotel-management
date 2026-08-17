-- =============================================================
-- 2026-08-17-derive-nights-in-create-booking.sql
-- create_booking_with_rooms: nights derived from dates server-side.
--
-- RECORD OF LIVE STATE — applied and verified in the Supabase SQL
-- editor on 2026-08-17 (derives_nights = true,
-- still_reads_client_nights = false, span_guard = true,
-- overlap_guard = true, sequence_intact = true). Committed for
-- history; SQL below is VERBATIM the live body.
--
-- WHY (BK-1400 underbilling, 2026-08-16):
--   The client's calcNights parsed dates without the T12:00:00 noon
--   anchor; one display-format operand shrank a 3-day span to 2.75
--   days in Dhaka (+6) and floor() dropped a night. The old RPC
--   trusted p_rooms nights and its only numeric guard was
--   total == Σ rate × nights — self-referential, so a short nights
--   with its matching short total passed cleanly. BK-1400 stored
--   nights=2 for a 16→19 stay and billed ৳4,000 instead of ৳6,000.
--   Client fix (noon anchors): 048c29e. This migration is the
--   server-side backstop: a client parse can never short a booking
--   again.
--
-- WHAT CHANGED (vs the 2026-07-31-restore-overlap-guard.sql body):
--   • booking_rooms.nights is DERIVED as check_out_date −
--     check_in_date (Postgres date subtraction — timezone-proof
--     integer days). The JSON 'nights' key is IGNORED; clients still
--     send it, so no TS change was needed.
--   • v_expected_total sums rate × derived nights, so a client that
--     shorts nights+total (e.g. a stale pre-048c29e bundle) now FAILS
--     the total_amount mismatch check loudly instead of underbilling.
--   • New fail-loud span guard: check_out_date must be after
--     check_in_date per room (also protects chk_br_nights > 0).
--   • Everything else byte-identical: overlap guard before nextval,
--     server-assigned booking_ref loop, first-room legacy columns,
--     per-room INSERT + rooms.status update, initial payment.
--
-- EARLY CHECKOUTS UNAFFECTED: nights is only ever legitimately
-- reduced below the span at CHECKOUT (checkout_booking /
-- checkout_booking_room compute the floored deduction and rewrite
-- nights). At create time a stay is always its full span.
--
-- DATA FINDINGS (Part-2 audit, run 2026-08-17): 15 rows had
-- nights <> span (৳194,200 nominal). Only 4 were real post-launch
-- underbilling — BK-1400 (৳2,000), BK-1184 (৳2,000), BK-1113 (two
-- rooms, ৳1,000 + ৳1,200) = ৳6,200, every one short by EXACTLY one
-- night (the noon-anchor signature). The other 11 are April–May test
-- rows short by 4–13 nights (an older, different artifact) —
-- deliberately not chased. BK-1400's guest was still in-house;
-- correction = set nights=3 + update_booking_total in the editor.
--
-- RESIDUAL GAPS (known, out of scope here): add_room_to_booking
-- still trusts its p_nights parameter, and the booking EDIT flow
-- writes booking_rooms.nights via direct table updates — the same
-- derivation could be extended to both later.
-- =============================================================

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
  -- 'nights' key is IGNORED: a client-side date-parse bug shorted nights
  -- and the matching total passed the old self-referential check
  -- (BK-1400: 16→19 stored as 2 nights, billed 2×rate). Postgres
  -- date-subtraction is timezone-proof integer days, so a client parse
  -- cannot short it. A shorted client total now FAILS the mismatch check
  -- below instead of underbilling. Early departures are unaffected —
  -- nights is only ever legitimately reduced at checkout, never at create.
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

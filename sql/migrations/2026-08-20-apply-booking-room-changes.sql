-- =============================================================
-- 2026-08-20-apply-booking-room-changes.sql
-- Edit-flow boundary: server-side guard + derived fields for
-- booking_rooms edits (room / dates / rate / category).
--
-- RECORD OF LIVE STATE — applied in the Supabase SQL editor on
-- 2026-08-20 (comments stripped in the applied paste; code below is
-- byte-identical to what runs live). Negative probe fired correctly
-- against BK-1208's completed stay on room 410 (BEGIN…ROLLBACK).
--
-- WHY: updateBooking's old Step 4 wrote booking_rooms dates/room_id
-- directly with only a client-side pre-check that (a) filtered
-- status IN ('confirmed','checked_in') — completed stays didn't
-- block — and (b) used scheduled check_out_date without
-- COALESCE(actual). That's the edit-flow back-dating mechanism
-- behind 3 of the 13 post-launch overlap pairs.
--
-- GUARD SEMANTICS = create_booking_with_rooms':
--   • half-open [) dateranges
--   • a stay occupies through COALESCE(actual_checkout_date,
--     check_out_date)
--   • PLUS completed statuses ('checked_out','checked_out_early') —
--     the exact class the old check missed. 'cancelled'/'no_show'
--     never block (full live status list confirmed against data
--     2026-08-19). Own booking's rows excluded (staged stays are
--     legitimate).
--
-- NIGHTS ARE DERIVED SERVER-SIDE — client values ignored:
--   • active rows: nights = span (check_out − check_in), no deduction
--   • completed rows (actual_checkout_date recorded): RECOMPUTED
--     from the FACTS (decision 2026-08-19: an edit corrects the
--     SCHEDULE; the actual departure is recorded fact — preserving
--     the old deduction gives nights matching nothing, clearing it
--     re-bills refunded nights). Fact-first derivation so
--     "nights = nights actually stayed" holds by construction,
--     including when CHECK-IN is the corrected date:
--       nights = GREATEST(1, LEAST(actual, new_out) − new_in)
--       early  = GREATEST(0, span − nights)
--     Reduces exactly to the checkout RPCs' expression when check-in
--     is unchanged (in-range: early = out − actual; late stamp: 0;
--     same-day: nights floored at 1). Algebraically identical to the
--     tail-based form for in-range actuals — adopted because it
--     states the invariant directly (Arif, 2026-08-20).
--   • An edit never auto-refunds: if the recompute drops the total
--     below paid, chk_paid_not_exceed_total aborts the whole edit
--     (surfaced client-side as the PHANTOM BOOKING message).
--
-- SECURITY INVOKER explicit (like create_booking_with_rooms; relies
-- on booking_rooms RLS). update_booking_total at the end fires
-- trg_sync_payment_status, so total AND payment_status re-derive
-- atomically with the row writes. Booking-level status re-sync uses
-- the same CASE as checkout_booking_room / cancel_booking_room.
-- =============================================================

CREATE OR REPLACE FUNCTION public.apply_booking_room_changes(
  p_booking_id uuid,
  p_changes    jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
AS $function$
DECLARE
  v_change      jsonb;
  v_row_id      uuid;
  v_room_id     uuid;
  v_ci          date;
  v_co          date;
  v_actual      date;
  v_status      public.booking_status;
  v_rate        numeric;
  v_new_rate    numeric;
  v_nights      integer;
  v_early       integer;
  v_room_number text;
  v_ref         text;
  v_from        date;
  v_until       date;
  v_cstatus     text;
  v_final       public.booking_status;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.bookings WHERE id = p_booking_id) THEN
    RAISE EXCEPTION 'booking % not found', p_booking_id;
  END IF;

  FOR v_change IN SELECT value FROM jsonb_array_elements(p_changes) LOOP
    v_row_id  := (v_change->>'booking_room_id')::uuid;
    v_room_id := (v_change->>'room_id')::uuid;
    v_ci      := (v_change->>'check_in_date')::date;
    v_co      := (v_change->>'check_out_date')::date;

    -- The row must belong to this booking (no cross-booking writes).
    SELECT actual_checkout_date, status, booking_rate
    INTO   v_actual, v_status, v_rate
    FROM   public.booking_rooms
    WHERE  id = v_row_id AND booking_id = p_booking_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'booking_room % does not belong to booking %', v_row_id, p_booking_id;
    END IF;

    IF v_co <= v_ci THEN
      RAISE EXCEPTION 'apply_booking_room_changes: check_out_date must be after check_in_date (got % to %).', v_ci, v_co;
    END IF;

    SELECT room_number INTO v_room_number FROM public.rooms WHERE id = v_room_id;
    IF v_room_number IS NULL THEN
      RAISE EXCEPTION 'room % not found', v_room_id;
    END IF;

    -- ── OVERLAP GUARD (create-RPC semantics + completed statuses) ──
    SELECT b.booking_ref, x.check_in_date,
           COALESCE(x.actual_checkout_date, x.check_out_date), x.status::text
    INTO   v_ref, v_from, v_until, v_cstatus
    FROM   public.booking_rooms x
    JOIN   public.bookings b ON b.id = x.booking_id
    WHERE  x.room_id = v_room_id
      AND  x.booking_id <> p_booking_id
      AND  x.status IN ('confirmed', 'checked_in', 'checked_out', 'checked_out_early')
      AND  daterange(x.check_in_date, COALESCE(x.actual_checkout_date, x.check_out_date), '[)')
        && daterange(v_ci, v_co, '[)')
    LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'Room % is unavailable for % – %: booking % covers % – % (%).',
        v_room_number, v_ci, v_co, v_ref, v_from, v_until, v_cstatus;
    END IF;

    v_new_rate := COALESCE((v_change->>'rate')::numeric, v_rate);

    IF v_actual IS NOT NULL AND v_status IN ('checked_out', 'checked_out_early') THEN
      -- Completed row: fact-first recompute (see header).
      v_nights := GREATEST(1, LEAST(v_actual, v_co) - v_ci);
      v_early  := GREATEST(0, (v_co - v_ci) - v_nights);
      UPDATE public.booking_rooms
      SET room_id                = v_room_id,
          check_in_date          = v_ci,
          check_out_date         = v_co,
          nights                 = v_nights::smallint,
          early_nights_deducted  = v_early,
          early_deduction_amount = v_early::numeric * v_new_rate,
          status                 = CASE WHEN v_early > 0
                                        THEN 'checked_out_early'::public.booking_status
                                        ELSE 'checked_out'::public.booking_status END,
          room_category          = COALESCE(v_change->>'category', room_category),
          booking_rate           = v_new_rate,
          updated_at             = NOW()
      WHERE id = v_row_id;
    ELSE
      -- Active (or non-departed) row: nights = full span, no deduction.
      UPDATE public.booking_rooms
      SET room_id        = v_room_id,
          check_in_date  = v_ci,
          check_out_date = v_co,
          nights         = (v_co - v_ci)::smallint,
          room_category  = COALESCE(v_change->>'category', room_category),
          booking_rate   = v_new_rate,
          updated_at     = NOW()
      WHERE id = v_row_id;
    END IF;
  END LOOP;

  PERFORM public.update_booking_total(p_booking_id);

  -- ── Booking-level status re-sync (same CASE as the checkout RPCs) ──
  SELECT CASE
      WHEN COUNT(*) = COUNT(*) FILTER (WHERE status='cancelled') THEN 'cancelled'::public.booking_status
      WHEN COUNT(*) FILTER (WHERE status='checked_in') > 0 THEN 'checked_in'::public.booking_status
      WHEN COUNT(*) FILTER (WHERE status IN ('confirmed','checked_in')) = 0
        THEN CASE WHEN COUNT(*) FILTER (WHERE status='checked_out_early') > 0
                  THEN 'checked_out_early'::public.booking_status
                  ELSE 'checked_out'::public.booking_status END
      ELSE 'confirmed'::public.booking_status
    END
  INTO v_final FROM public.booking_rooms WHERE booking_id = p_booking_id;

  UPDATE public.bookings SET status = v_final
  WHERE id = p_booking_id AND status IS DISTINCT FROM v_final;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.apply_booking_room_changes(uuid, jsonb) TO authenticated, service_role;

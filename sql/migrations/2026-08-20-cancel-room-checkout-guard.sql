-- =============================================================
-- 2026-08-20-cancel-room-checkout-guard.sql
-- cancel_booking_room early-departure branch: balance guard +
-- stop stomping check_out_date + Dhaka clamp (BK-1425 incident).
--
-- RECORD OF LIVE STATE — applied in the Supabase SQL editor on
-- 2026-08-20. Probe verified same day: early-departure attempt on
-- due-carrying BK-1438 raised "Cannot check out BK-1438 —
-- outstanding balance of 2000.00. Collect payment, or ask an admin
-- to override." (assert_checkout_allowed three-param, called from
-- line 66; ROLLBACK clean).
--
-- INCIDENT (BK-1425, 2026-08-20 10:38 Dhaka): guest walked out with
-- the full ৳2000 due via the per-room "early departure" action. The
-- checked_out_early branch of this function was a checkout in
-- disguise with NO assert_checkout_allowed — the guard went into
-- checkout_booking (08-14/15) and checkout_booking_room (08-17) but
-- this third door was never fitted. Isolation verified: of 273
-- completed bookings since launch, BK-1425 is the ONLY positive-due
-- no-override walkout (৳2000 total exposure → collection; any
-- write-off later as a recorded admin discount). Decision: the nine
-- other rows produced by this branch (early>0 with actual ==
-- check_out_date — the stomp signature) are semantic-only damage,
-- billing correct, LEFT ALONE.
--
-- THREE CHANGES vs the prior live body (everything else identical):
--   1. GUARD: PERFORM assert_checkout_allowed(v_booking_id, false,
--      p_booking_room_id) after the step-3 validations, before any
--      write — per-room scope, same staged-stay semantics as
--      checkout_booking_room (intermediate rooms of a multi-room
--      stay pass; the last active room is fully guarded). This
--      branch takes no discount params, so the checkout_booking
--      after-3.6 ordering question does not arise here.
--   2. STOMP REMOVED (the phase11-57 treatment, finally applied
--      here): check_out_date is PRESERVED; only actual_checkout_date
--      records the departure. Previously the branch computed early
--      against the original schedule then overwrote check_out_date
--      with the actual date — destroying the reference and leaving
--      rows that look self-contradictory (early > 0 while actual ==
--      check_out_date). nights still shrinks to the actual stay, so
--      update_booking_total and the disbursement estimate are
--      unchanged financially.
--   3. CLAMP: v_actual = GREATEST(check_in_date, LEAST(
--      p_actual_check_out, (now() AT TIME ZONE 'Asia/Dhaka')::date))
--      — same envelope as both checkout RPCs; unclamped client dates
--      in this branch were the same bug class. The raw-param
--      "> check_out_date → use extend_booking_room" validation stays
--      first, on the unclamped value.
--
-- NOTE: SECURITY INVOKER + fail-closed guard means SQL-editor
-- early-departures on a due-carrying booking now fail (NULL
-- auth.uid()) — expected; same class as the other guards.
-- =============================================================

CREATE OR REPLACE FUNCTION public.cancel_booking_room(p_booking_room_id uuid, p_status text, p_actual_check_out date DEFAULT NULL::date, p_refund_amount numeric DEFAULT NULL::numeric, p_refund_reason text DEFAULT NULL::text, p_refund_created_by uuid DEFAULT NULL::uuid, p_disbursement_method text DEFAULT NULL::text, p_disbursement_notes text DEFAULT NULL::text, p_disbursed_by uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_booking_id           UUID;
  v_room_id              UUID;
  v_current_status       public.booking_status;
  v_check_in_date        DATE;
  v_check_out_date       DATE;
  v_booking_rate         NUMERIC;
  v_nights               SMALLINT;
  v_actual               DATE;
  v_early_nights         INTEGER;
  v_deduction_amount     NUMERIC  := 0;   -- set only in checked_out_early branch
  v_derived_status       public.booking_status;
  v_refund_id            UUID     := NULL;
  v_paid_amount          NUMERIC;
  v_current_total        NUMERIC;
  v_estimated_new_total  NUMERIC;
  v_overpayment          NUMERIC;
BEGIN

  -- ── 1. Read current booking_rooms row ─────────────────────────────────────
  SELECT booking_id, room_id, status, check_in_date, check_out_date, booking_rate, nights
  INTO   v_booking_id, v_room_id, v_current_status,
         v_check_in_date, v_check_out_date, v_booking_rate, v_nights
  FROM   public.booking_rooms
  WHERE  id = p_booking_room_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'booking_room % not found', p_booking_room_id;
  END IF;

  -- ── 2. Read booking financials (needed for disbursement validation) ────────
  SELECT paid_amount, total_amount
  INTO   v_paid_amount, v_current_total
  FROM   public.bookings
  WHERE  id = v_booking_id;

  -- ── 3. Validate status transition ─────────────────────────────────────────
  IF p_status NOT IN ('cancelled', 'checked_out_early') THEN
    RAISE EXCEPTION
      'Invalid p_status ''%''. Must be ''cancelled'' or ''checked_out_early''.', p_status;
  END IF;

  IF p_status = 'cancelled' AND v_current_status <> 'confirmed' THEN
    RAISE EXCEPTION
      'Can only cancel a room with status=confirmed. Current status: %', v_current_status;
  END IF;

  IF p_status = 'checked_out_early' AND v_current_status <> 'checked_in' THEN
    RAISE EXCEPTION
      'Can only mark checked_out_early a room with status=checked_in. Current status: %',
      v_current_status;
  END IF;

  IF p_status = 'checked_out_early' AND p_actual_check_out IS NULL THEN
    RAISE EXCEPTION
      'p_actual_check_out is required when p_status = ''checked_out_early''.';
  END IF;

  IF p_status = 'checked_out_early'
     AND p_actual_check_out > v_check_out_date THEN
    RAISE EXCEPTION
      'p_actual_check_out (%) cannot be after scheduled check_out_date (%). '
      'Use extend_booking_room instead.',
      p_actual_check_out, v_check_out_date;
  END IF;

  -- ── 3.5. BALANCE GUARD (2026-08-20, BK-1425) — early departure IS a
  --         checkout; per-room scope, staged-stay semantics ──
  IF p_status = 'checked_out_early' THEN
    PERFORM public.assert_checkout_allowed(v_booking_id, false, p_booking_room_id);
  END IF;

  -- ── 4. Apply per-status update ────────────────────────────────────────────

  IF p_status = 'checked_out_early' THEN

    -- CLAMP (2026-08-20): bounded [check_in, Dhaka-local today] — same as
    -- both checkout RPCs; never raw current_date (UTC midnight bug).
    v_actual := GREATEST(v_check_in_date,
                  LEAST(p_actual_check_out,
                        (now() AT TIME ZONE 'Asia/Dhaka')::date));

    v_early_nights     := LEAST(
                            GREATEST(0, v_check_out_date - v_actual),
                            GREATEST(0, v_nights - 1)
                          );
    v_deduction_amount := v_early_nights::NUMERIC * v_booking_rate;

    -- check_out_date deliberately NOT written (stomp removed 2026-08-20):
    -- the schedule the deduction was measured against stays in the row.
    UPDATE public.booking_rooms
    SET status                 = 'checked_out_early'::public.booking_status,
        actual_checkout_date   = v_actual,
        early_nights_deducted  = v_early_nights,
        early_deduction_amount = v_deduction_amount,
        nights                 = v_nights - v_early_nights,
        checked_out_at         = NOW(),
        updated_at             = NOW()
    WHERE id = p_booking_room_id;

    -- Room frees to available (no housekeeping step)
    UPDATE public.rooms
    SET    status = 'available', updated_at = NOW()
    WHERE  id = v_room_id;

  ELSIF p_status = 'cancelled' THEN

    UPDATE public.booking_rooms
    SET status       = 'cancelled'::public.booking_status,
        cancelled_at = NOW(),
        updated_at   = NOW()
    WHERE id = p_booking_room_id;

    -- Room goes back to available
    UPDATE public.rooms
    SET    status = 'available', updated_at = NOW()
    WHERE  id = v_room_id;

  END IF;

  -- ── 5. Validate disbursement params (only when method is provided) ─────────
  IF p_disbursement_method IS NOT NULL THEN

    IF p_disbursed_by IS NULL THEN
      RAISE EXCEPTION
        'p_disbursed_by is required when p_disbursement_method is provided.';
    END IF;

    IF p_disbursement_method NOT IN
       ('cash', 'bkash', 'nagad', 'bank_transfer', 'card') THEN
      RAISE EXCEPTION
        'Invalid disbursement method ''%''. '
        'Must be one of: cash, bkash, nagad, bank_transfer, card.',
        p_disbursement_method;
    END IF;

    IF p_refund_amount IS NULL OR p_refund_amount <= 0 THEN
      RAISE EXCEPTION
        'p_refund_amount must be > 0 when p_disbursement_method is provided.';
    END IF;

    IF p_status = 'cancelled' THEN
      v_estimated_new_total := v_current_total - (v_booking_rate * v_nights);
    ELSE
      v_estimated_new_total := v_current_total - v_deduction_amount;
    END IF;

    v_overpayment := v_paid_amount - GREATEST(0, v_estimated_new_total);

    IF v_overpayment > 0 AND p_refund_amount < v_overpayment THEN
      RAISE EXCEPTION
        'Atomic cancel+disburse requires refund amount (%) to be at least '
        'the overpayment % (paid_amount % − estimated new total %). '
        'Provide a larger refund amount or use the pending-refund path '
        'after manually disbursing the overpayment.',
        p_refund_amount,
        v_overpayment,
        v_paid_amount,
        v_estimated_new_total;
    END IF;

    IF p_refund_amount > v_overpayment THEN
      RAISE EXCEPTION
        'Refund amount % exceeds overpayment % '
        '(paid_amount % − estimated new total %). '
        'Cannot disburse more than the overpayment.',
        p_refund_amount,
        v_overpayment,
        v_paid_amount,
        v_estimated_new_total;
    END IF;

  END IF;

  -- ── 6. Refund section (branches unchanged) ────────────────────────────────
  IF p_refund_amount IS NOT NULL AND p_refund_amount > 0 THEN

    IF p_disbursement_method IS NOT NULL THEN

      INSERT INTO public.refunds (
        booking_id,
        booking_room_id,
        amount,
        reason,
        status,
        created_by,
        disbursed_at,
        disbursed_by,
        disbursement_method,
        notes
      ) VALUES (
        v_booking_id,
        p_booking_room_id,
        p_refund_amount,
        p_refund_reason,
        'disbursed',
        p_refund_created_by,
        NOW(),
        p_disbursed_by,
        p_disbursement_method,
        p_disbursement_notes
      )
      RETURNING id INTO v_refund_id;

      INSERT INTO public.payments (
        booking_id,
        amount,
        method,
        recorded_by,
        notes
      ) VALUES (
        v_booking_id,
        -p_refund_amount,
        p_disbursement_method::public.payment_method,
        p_disbursed_by,
        'Refund disbursement: ref ' || v_refund_id::TEXT
      );

    ELSE

      INSERT INTO public.refunds (
        booking_id,
        booking_room_id,
        amount,
        reason,
        created_by
      ) VALUES (
        v_booking_id,
        p_booking_room_id,
        p_refund_amount,
        p_refund_reason,
        p_refund_created_by
      )
      RETURNING id INTO v_refund_id;

    END IF;

  END IF;

  -- ── 7. Recompute booking total ────────────────────────────────────────────
  PERFORM public.update_booking_total(v_booking_id);

  -- ── 8. Derive and sync booking-level status ───────────────────────────────
  SELECT
    CASE
      WHEN COUNT(*) = COUNT(*) FILTER (WHERE status = 'cancelled')
        THEN 'cancelled'::public.booking_status
      WHEN COUNT(*) FILTER (WHERE status = 'checked_in') > 0
        THEN 'checked_in'::public.booking_status
      WHEN COUNT(*) FILTER (WHERE status IN ('confirmed', 'checked_in')) = 0
        THEN CASE
               WHEN COUNT(*) FILTER (WHERE status = 'checked_out_early') > 0
                 THEN 'checked_out_early'::public.booking_status
               ELSE 'checked_out'::public.booking_status
             END
      ELSE  'confirmed'::public.booking_status
    END
  INTO v_derived_status
  FROM public.booking_rooms
  WHERE booking_id = v_booking_id;

  UPDATE public.bookings
  SET    status = v_derived_status
  WHERE  id     = v_booking_id
    AND  status IS DISTINCT FROM v_derived_status;

  RETURN v_refund_id;

END;
$function$;

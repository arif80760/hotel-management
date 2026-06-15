-- 2026-06-15-early-checkout-min-one-night-floor.sql
--
-- Early-checkout billing fix: a checked-in room must always be charged for at
-- least the check-in day. Previously the deduction = unused nights with no
-- floor, so a same-day checkout deducted every night → full refund.
--
-- The floor: deducted_nights = LEAST(unused_nights, booked_nights - 1).
--
--   • cancel_booking_room  — REAL money fix. Its checked_out_early branch had
--                            no floor, so same-day → 0 charged → full refund.
--   • checkout_booking     — CONSISTENCY only, no money change. It already
--                            floored `nights` via GREATEST(1, …); this also
--                            caps the *recorded* early_nights_deducted /
--                            early_deduction_amount so they match.
--
-- NOT touched here (deliberately):
--   • checkout_booking_room — legacy/unused; defensive floor to follow.
--   • "confirmed" (never-checked-in) rooms on a whole-booking checkout still
--     behave exactly as before (no regression). Turning those into a full
--     refund is a separate behaviour change.
--
-- Idempotent: both are CREATE OR REPLACE. After running, diff each function
-- against its previous definition to confirm only the floored lines moved.
-- ─────────────────────────────────────────────────────────────────────────────


-- ═══════════════════════════════════════════════════════════════════════════
-- 1. cancel_booking_room  (per-room early checkout / cancel)  — MONEY FIX
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.cancel_booking_room(p_booking_room_id uuid, p_status text, p_actual_check_out date DEFAULT NULL::date, p_refund_amount numeric DEFAULT NULL::numeric, p_refund_reason text DEFAULT NULL::text, p_refund_created_by uuid DEFAULT NULL::uuid, p_disbursement_method text DEFAULT NULL::text, p_disbursement_notes text DEFAULT NULL::text, p_disbursed_by uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_booking_id           UUID;
  v_room_id              UUID;
  v_current_status       public.booking_status;
  v_check_out_date       DATE;
  v_booking_rate         NUMERIC;
  v_nights               SMALLINT;
  v_early_nights         INTEGER;
  v_deduction_amount     NUMERIC  := 0;   -- set only in checked_out_early branch
  v_derived_status       public.booking_status;
  v_refund_id            UUID     := NULL;
  -- Phase 8.6 additions
  v_paid_amount          NUMERIC;
  v_current_total        NUMERIC;
  v_estimated_new_total  NUMERIC;
  v_overpayment          NUMERIC;
BEGIN

  -- ── 1. Read current booking_rooms row ─────────────────────────────────────
  SELECT booking_id, room_id, status, check_out_date, booking_rate, nights
  INTO   v_booking_id, v_room_id, v_current_status,
         v_check_out_date, v_booking_rate, v_nights
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

  -- ── 4. Apply per-status update ────────────────────────────────────────────

  IF p_status = 'checked_out_early' THEN

    -- ⬇ CHANGED: floor the deduction so at least 1 night (the check-in day) is
    --   always charged. This branch is always a checked_in room.
    v_early_nights     := LEAST(
                            GREATEST(0, v_check_out_date - p_actual_check_out),
                            GREATEST(0, v_nights - 1)
                          );
    v_deduction_amount := v_early_nights::NUMERIC * v_booking_rate;

    UPDATE public.booking_rooms
    SET status                 = 'checked_out_early'::public.booking_status,
        actual_checkout_date   = p_actual_check_out,
        early_nights_deducted  = v_early_nights,
        early_deduction_amount = v_deduction_amount,
        -- Shrink check_out_date and nights to reflect actual stay
        check_out_date         = p_actual_check_out,
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
  --
  -- Estimates what total_amount will be after update_booking_total() runs,
  -- without calling it yet (calling it now would trigger
  -- chk_paid_not_exceed_total before paid_amount has been decremented).
  --
  -- For 'cancelled':       this room's full contribution drops out.
  -- For 'checked_out_early': only the early nights' cost drops out
  --                          (v_deduction_amount = early_nights × rate).
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

    -- Estimate new total after this room's status change.
    IF p_status = 'cancelled' THEN
      v_estimated_new_total := v_current_total - (v_booking_rate * v_nights);
    ELSE
      -- checked_out_early: the deducted nights' revenue drops out
      v_estimated_new_total := v_current_total - v_deduction_amount;
    END IF;

    v_overpayment := v_paid_amount - GREATEST(0, v_estimated_new_total);

    -- When an overpayment exists, the refund must cover it exactly.
    -- Partial refund → paid would still exceed new_total → constraint fires.
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

  -- ── 6. Refund section ─────────────────────────────────────────────────────
  --
  -- Branch A  p_refund_amount IS NULL or 0    → no refund work
  -- Branch B  amount > 0, method IS NULL       → pending refund row (existing)
  -- Branch C  amount > 0, method IS NOT NULL   → disbursed refund row +
  --                                              negative payment row (new)
  --
  -- ORDERING: Branch C payment INSERT must precede update_booking_total()
  -- (step 7) so that paid_amount is decremented BEFORE total_amount drops
  -- and chk_paid_not_exceed_total is evaluated.

  IF p_refund_amount IS NOT NULL AND p_refund_amount > 0 THEN

    IF p_disbursement_method IS NOT NULL THEN

      -- ── Branch C: atomic disburse ─────────────────────────────────────
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

      -- Negative payment → trg_sync_paid_amount fires, paid_amount decrements.
      -- Must come BEFORE update_booking_total() — see ordering note above.
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

      -- ── Branch B: pending refund (existing behaviour unchanged) ───────
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
  -- Called AFTER any payment INSERT (Branch C) so paid_amount is already
  -- decremented when chk_paid_not_exceed_total fires on this UPDATE.
  -- Pending-refund and no-refund paths are unaffected — paid_amount unchanged.
  PERFORM public.update_booking_total(v_booking_id);

  -- ── 8. Derive and sync booking-level status ───────────────────────────────
  -- Per docs/multi-room-design.md § 5 sync rules.
  -- When no rooms remain active, the booking is checked_out_early if any room
  -- left early, otherwise checked_out (was previously always checked_out).
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

  -- Only write if status actually changed (avoids no-op trigger re-stamps).
  UPDATE public.bookings
  SET    status = v_derived_status
  WHERE  id     = v_booking_id
    AND  status IS DISTINCT FROM v_derived_status;

  RETURN v_refund_id;

END;
$function$;


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. checkout_booking  (whole-booking checkout)  — CONSISTENCY ONLY (no money change)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.checkout_booking(p_booking_id uuid, p_actual_checkout_date date DEFAULT NULL::date, p_additional_discount_amount numeric DEFAULT 0, p_additional_discount_reason text DEFAULT NULL::text, p_additional_discount_by uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_room_ids        UUID[];
  -- Step 3.5 / 3.6: overpayment detection + discount write
  v_new_rooms_total NUMERIC;
  v_paid_amount     NUMERIC;
  v_extra_charge    NUMERIC;
  v_discount        NUMERIC;
  v_effective_total NUMERIC;
  v_overpayment     NUMERIC;
  v_refund_id       UUID;
  v_final_status    public.booking_status;   -- step 5: checked_out vs checked_out_early
BEGIN

  -- ── 1. Validate booking exists ────────────────────────────────────────────
  IF NOT EXISTS (SELECT 1 FROM public.bookings WHERE id = p_booking_id) THEN
    RAISE EXCEPTION 'booking % not found', p_booking_id;
  END IF;

  -- ── 2. Per-room early deductions + bulk checkout via CTE ──────────────────
  -- early_nights is now floored at (nights - 1) so the recorded deduction can
  -- never zero out a checked-in room's charge — matches the GREATEST(1, …) on
  -- nights below. No money change: nights was already floored before.
  WITH active_rooms AS (
    SELECT id                                                              AS room_row_id,
           room_id,
           check_out_date,
           booking_rate,
           nights,
           -- ⬇ CHANGED: cap unused nights at (nights - 1) so ≥1 night stays charged
           LEAST(
             GREATEST(0,
               check_out_date
               - COALESCE(p_actual_checkout_date, check_out_date)
             ),
             GREATEST(0, nights - 1)
           )                                                               AS early_nights,
           -- ⬇ CHANGED: same capped expression × rate
           LEAST(
             GREATEST(0,
               check_out_date
               - COALESCE(p_actual_checkout_date, check_out_date)
             ),
             GREATEST(0, nights - 1)
           )::NUMERIC * booking_rate                                       AS deduction_amt
    FROM   public.booking_rooms
    WHERE  booking_id = p_booking_id
      AND  status IN ('confirmed', 'checked_in')
  ),
  upd AS (
    UPDATE public.booking_rooms br
    SET    status                 = CASE
                                      WHEN ar.early_nights > 0
                                      THEN 'checked_out_early'::public.booking_status
                                      ELSE 'checked_out'::public.booking_status
                                    END,
           checked_out_at         = NOW(),
           actual_checkout_date   = COALESCE(p_actual_checkout_date, ar.check_out_date),
           -- check_out_date intentionally omitted — stays as original scheduled date
           early_nights_deducted  = ar.early_nights,
           early_deduction_amount = ar.deduction_amt,
           nights                 = GREATEST(1, ar.nights - ar.early_nights),
           updated_at             = NOW()
    FROM   active_rooms ar
    WHERE  br.id = ar.room_row_id
    RETURNING br.room_id
  )
  SELECT array_agg(room_id)
  INTO   v_room_ids
  FROM   upd;

  -- ── 3. Free physical rooms to available ───────────────────────────────────
  IF v_room_ids IS NOT NULL THEN
    UPDATE public.rooms
    SET    status     = 'available',
           updated_at = NOW()
    WHERE  id = ANY(v_room_ids);
  END IF;

  -- ── 3.5. Detect overpayment and auto-create pending refund ────────────────
  SELECT COALESCE(SUM(br.nights * br.booking_rate), 0),
         b.paid_amount,
         COALESCE(b.extra_charge_amount, 0)
  INTO   v_new_rooms_total, v_paid_amount, v_extra_charge
  FROM   public.bookings b
  LEFT JOIN public.booking_rooms br
         ON br.booking_id = b.id
        AND br.status NOT IN ('cancelled')
  WHERE  b.id = p_booking_id
  GROUP BY b.paid_amount, b.extra_charge_amount;

  v_discount        := p_additional_discount_amount;
  v_effective_total := v_new_rooms_total + v_extra_charge - v_discount;

  IF v_paid_amount > v_effective_total THEN
    v_overpayment := v_paid_amount - v_effective_total;

    INSERT INTO public.refunds (booking_id, booking_room_id, amount, reason, status, created_by, pre_adjusted)
    VALUES (p_booking_id, NULL, v_overpayment, 'Auto-created from checkout — overpayment ৳' || v_overpayment::TEXT, 'pending', NULL, TRUE)
    RETURNING id INTO v_refund_id;

    INSERT INTO public.payments (booking_id, amount, method, notes, refund_id)
    VALUES (p_booking_id, -v_overpayment, 'other'::public.payment_method, 'Auto-refund pre-adjustment — refund row ' || v_refund_id::TEXT, v_refund_id);
    -- trg_sync_paid_amount fires; paid_amount now = v_effective_total
  END IF;

  -- ── 3.6. Write additional_discount_* columns ─────────────────────────────
  IF p_additional_discount_amount > 0 THEN
    UPDATE public.bookings
    SET    additional_discount_amount = p_additional_discount_amount,
           additional_discount_reason = p_additional_discount_reason,
           additional_discount_by     = p_additional_discount_by,
           additional_discount_at     = NOW()
    WHERE  id = p_booking_id;
  END IF;

  -- ── 4. Recompute booking total ────────────────────────────────────────────
  PERFORM public.update_booking_total(p_booking_id);

  -- ── 5. Promote booking to checked_out / checked_out_early ─────────────────
  v_final_status := CASE
    WHEN EXISTS (
      SELECT 1 FROM public.booking_rooms br
      WHERE br.booking_id = p_booking_id
        AND br.status = 'checked_out_early'
    )
    THEN 'checked_out_early'::public.booking_status
    ELSE 'checked_out'::public.booking_status
  END;

  UPDATE public.bookings
  SET    status = v_final_status
  WHERE  id     = p_booking_id
    AND  status IS DISTINCT FROM v_final_status;

END;
$function$;

-- ===========================================================================
-- Phase 8.6 Step 1: Atomic Cancel + Refund Disbursement
-- File:   sql/migrations/2026-05-09-phase8.6-atomic-cancel-with-disbursement.sql
-- Date:   2026-05-09
-- Apply:  After 2026-05-09-phase8.5-refund-disbursement.sql
--
-- Problem:
--   When a per-room or whole-booking cancellation creates an overpayment
--   (paid_amount > new total after cancel), Phase 8.5 blocks the operation:
--   cancel_booking raises before writing anything; the UI disables the
--   Confirm button.  There was no path to atomically create AND disburse
--   the refund as part of the same cancel transaction.
--
-- Fix:
--   Extend cancel_booking_room and cancel_booking with three new optional
--   params.  When p_disbursement_method is provided the RPC:
--     1. Validates the disbursement params and the refund amount
--     2. INSERTs a refund row with status='disbursed' (not 'pending')
--     3. INSERTs a negative payment row — trg_sync_paid_amount fires and
--        decrements bookings.paid_amount in the same transaction
--     4. Calls update_booking_total() AFTER the payment row so that
--        chk_paid_not_exceed_total (CHECK paid <= total) is satisfied
--        at all points during execution
--
-- New params (appended after existing params — existing callers unaffected):
--   p_disbursement_method  TEXT  DEFAULT NULL
--   p_disbursement_notes   TEXT  DEFAULT NULL
--   p_disbursed_by         UUID  DEFAULT NULL
--
-- NOTE ON FUNCTION COUNT:
--   The spec anticipated three RPCs (cancel_booking_room, cancel_booking,
--   plus a separate early-checkout RPC).  Investigation confirmed the
--   early-checkout path lives INSIDE cancel_booking_room via
--   p_status = 'checked_out_early' — there is no separate function.
--   This migration modifies two function signatures, not three.
--
-- NOTE ON DROP/CREATE:
--   PostgreSQL identifies functions by their full argument signature.
--   Adding three new params changes the signature; CREATE OR REPLACE alone
--   would create a new overload and leave the old function receiving all
--   existing callers.  Both functions are explicitly DROPped first.
--
-- NOTE ON CONSTRAINT ORDERING:
--   chk_paid_not_exceed_total (CHECK paid_amount <= total_amount) fires
--   during the UPDATE that update_booking_total() issues.  For the atomic
--   disburse path the payment INSERT (which decrements paid via trigger)
--   MUST precede update_booking_total() so that paid ≤ new_total when
--   the constraint is evaluated.  Pending-refund callers are unaffected —
--   paid_amount does not change in that path.
-- ===========================================================================


-- ===========================================================================
-- 1. cancel_booking_room
--    Replaces the Phase 7 version (6 params → 9 params).
--    All existing behaviour is unchanged when the three new params are NULL.
-- ===========================================================================

-- Drop the Phase 7 signature so the 9-param version becomes the sole target.
DROP FUNCTION IF EXISTS public.cancel_booking_room(
  uuid,     -- p_booking_room_id
  text,     -- p_status
  date,     -- p_actual_check_out
  numeric,  -- p_refund_amount
  text,     -- p_refund_reason
  uuid      -- p_refund_created_by
);

CREATE OR REPLACE FUNCTION public.cancel_booking_room(
  p_booking_room_id      UUID,
  p_status               TEXT,                  -- 'cancelled' | 'checked_out_early'
  p_actual_check_out     DATE    DEFAULT NULL,  -- required when p_status = 'checked_out_early'
  p_refund_amount        NUMERIC DEFAULT NULL,  -- NULL = no refund record
  p_refund_reason        TEXT    DEFAULT NULL,
  p_refund_created_by    UUID    DEFAULT NULL,
  -- ── Phase 8.6: atomic disbursement (all three must be non-NULL together) ──
  -- Omit (or pass NULL) for the existing pending-refund / no-refund behaviour.
  p_disbursement_method  TEXT    DEFAULT NULL,
  p_disbursement_notes   TEXT    DEFAULT NULL,
  p_disbursed_by         UUID    DEFAULT NULL
) RETURNS UUID  -- refund id if a refund row was created; NULL otherwise
LANGUAGE plpgsql AS $$
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

    v_early_nights     := GREATEST(0, v_check_out_date - p_actual_check_out);
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

    -- Room goes to cleaning
    UPDATE public.rooms
    SET    status = 'cleaning', updated_at = NOW()
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
  SELECT
    CASE
      WHEN COUNT(*) = COUNT(*) FILTER (WHERE status = 'cancelled')
        THEN 'cancelled'::public.booking_status
      WHEN COUNT(*) FILTER (WHERE status = 'checked_in') > 0
        THEN 'checked_in'::public.booking_status
      WHEN COUNT(*) FILTER (WHERE status IN ('confirmed', 'checked_in')) = 0
        THEN 'checked_out'::public.booking_status
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
$$;

COMMENT ON FUNCTION public.cancel_booking_room IS
  'Cancels one room (pre-checkin) or marks it checked_out_early (mid-stay). '
  'Three refund modes: '
  '(1) no refund params → no refund row; '
  '(2) p_refund_amount only → pending refund row (existing behaviour); '
  '(3) p_refund_amount + p_disbursement_method + p_disbursed_by → atomic '
  'disburse: inserts a disbursed refund row and a negative payment row in '
  'the same transaction, decrementing paid_amount via trg_sync_paid_amount '
  'BEFORE update_booking_total() fires (required by chk_paid_not_exceed_total). '
  'Returns the refund UUID if any refund row was created, or NULL.';


-- ===========================================================================
-- 2. cancel_booking
--    Replaces the Phase 8.5 version (4 params → 7 params).
--    All existing behaviour is unchanged when the three new params are NULL.
--
--    Guard change: the Phase 8.5 guard that unconditionally raised when
--    paid > extras_total is softened for the atomic-disburse path.  When
--    p_disbursement_method is provided, the guard instead validates that
--    the refund amount is sufficient to bring paid down to ≤ new_total.
--    Non-disburse callers see identical error messages to Phase 8.5.
-- ===========================================================================

-- Drop the Phase 8.5 signature.
DROP FUNCTION IF EXISTS public.cancel_booking(
  uuid,     -- p_booking_id
  numeric,  -- p_refund_amount
  text,     -- p_refund_reason
  uuid      -- p_refund_created_by
);

CREATE OR REPLACE FUNCTION public.cancel_booking(
  p_booking_id           UUID,
  p_refund_amount        NUMERIC  DEFAULT NULL,
  p_refund_reason        TEXT     DEFAULT NULL,
  p_refund_created_by    UUID     DEFAULT NULL,
  -- ── Phase 8.6: atomic disbursement ───────────────────────────────────────
  p_disbursement_method  TEXT     DEFAULT NULL,
  p_disbursement_notes   TEXT     DEFAULT NULL,
  p_disbursed_by         UUID     DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql AS $$
DECLARE
  v_paid_amount     NUMERIC;
  v_extras_total    NUMERIC;
  v_bad_room_number TEXT;
  v_bad_status      TEXT;
  v_refund_id       UUID    := NULL;
  v_overpayment     NUMERIC;
BEGIN

  -- ── 1. Read booking ────────────────────────────────────────────────────────
  SELECT paid_amount
  INTO   v_paid_amount
  FROM   public.bookings
  WHERE  id = p_booking_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'booking % not found', p_booking_id;
  END IF;

  -- ── 2. Guard: all rooms must be confirmed ──────────────────────────────────
  SELECT r.room_number, br.status::TEXT
  INTO   v_bad_room_number, v_bad_status
  FROM   public.booking_rooms br
  JOIN   public.rooms r ON r.id = br.room_id
  WHERE  br.booking_id = p_booking_id
    AND  br.status <> 'confirmed'::public.booking_status
  LIMIT  1;

  IF FOUND THEN
    RAISE EXCEPTION
      'Cannot whole-cancel booking % — Room % is %. '
      'Use per-room cancel_booking_room for checked-in rooms, '
      'or cancel rooms individually before cancelling the booking.',
      p_booking_id, v_bad_room_number, v_bad_status;
  END IF;

  -- ── 3. Compute new total after whole cancellation (extras only) ────────────
  --
  -- After all rooms are cancelled, update_booking_total() will set
  -- total_amount = sum(extra_charges).  We compute this now — before any
  -- writes — both for the guard below and for the atomic-disburse validation.
  SELECT COALESCE(SUM(amount), 0)
  INTO   v_extras_total
  FROM   public.booking_extra_charges
  WHERE  booking_id = p_booking_id;

  -- ── 4. Guard: chk_paid_not_exceed_total (softened for atomic disburse) ─────
  --
  -- After cancellation, update_booking_total() will set total_amount to
  -- v_extras_total (rooms contribute 0).  The DB constraint
  -- chk_paid_not_exceed_total CHECK (paid_amount <= total_amount) fires on
  -- that UPDATE.  We must ensure paid ≤ new_total at that moment.
  --
  -- Non-disburse path:  paid must already be ≤ extras_total, or we block.
  -- Atomic-disburse path: the payment INSERT will decrement paid first.
  --   We validate that the refund amount is sufficient:
  --   (v_paid_amount - p_refund_amount) ≤ v_extras_total
  --   ↔  p_refund_amount ≥ (v_paid_amount - v_extras_total)

  IF v_paid_amount > v_extras_total THEN

    IF p_disbursement_method IS NULL THEN
      -- Existing Phase 8.5 error: operator must disburse first (or use
      -- atomic disburse by providing disbursement params).
      RAISE EXCEPTION
        'Cannot cancel booking % — paid_amount (%) exceeds remaining '
        'total (%) after cancellation. Disburse pending refunds totalling '
        'at least % first, or provide p_disbursement_method + p_disbursed_by '
        'to atomically disburse as part of this cancellation.',
        p_booking_id,
        v_paid_amount,
        v_extras_total,
        (v_paid_amount - v_extras_total);
    END IF;

    -- Atomic-disburse path: refund must cover the full overpayment.
    -- (Partial refund would leave paid > new_total → constraint violation.)
    IF p_refund_amount IS NULL
       OR (v_paid_amount - p_refund_amount) > v_extras_total THEN
      RAISE EXCEPTION
        'Atomic cancel+disburse requires refund amount (%) to be at least '
        'the overpayment % (paid_amount % − new_total %). '
        'Provide a larger refund amount or use the pending-refund path '
        'after manually disbursing the overpayment.',
        COALESCE(p_refund_amount, 0),
        (v_paid_amount - v_extras_total),
        v_paid_amount,
        v_extras_total;
    END IF;

  END IF;

  -- ── 5. Validate disbursement params (when method provided) ────────────────
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

    -- Cap: cannot disburse more than the overpayment
    -- (disbursing more than paid would trigger fn_sync_paid_amount fail-fast).
    v_overpayment := v_paid_amount - v_extras_total;
    IF p_refund_amount > v_overpayment THEN
      RAISE EXCEPTION
        'Refund amount % exceeds overpayment % for booking %.',
        p_refund_amount, v_overpayment, p_booking_id;
    END IF;

  ELSE
    -- Non-disburse: cap at paid_amount (original Phase 8.5 guard).
    IF p_refund_amount IS NOT NULL AND p_refund_amount > v_paid_amount THEN
      RAISE EXCEPTION
        'Refund amount % exceeds paid_amount % for booking %.',
        p_refund_amount, v_paid_amount, p_booking_id;
    END IF;
  END IF;

  -- ── 6. Cancel all booking_rooms ────────────────────────────────────────────
  UPDATE public.booking_rooms
  SET    status       = 'cancelled'::public.booking_status,
         cancelled_at = NOW(),
         updated_at   = NOW()
  WHERE  booking_id = p_booking_id
    AND  status     = 'confirmed'::public.booking_status;

  -- ── 7. Release physical rooms ──────────────────────────────────────────────
  UPDATE public.rooms r
  SET    status     = 'available'::public.room_status,
         updated_at = NOW()
  FROM   public.booking_rooms br
  WHERE  br.room_id    = r.id
    AND  br.booking_id = p_booking_id;

  -- ── 8. Update booking status ───────────────────────────────────────────────
  UPDATE public.bookings
  SET    status = 'cancelled'::public.booking_status
  WHERE  id     = p_booking_id;

  -- ── 9. Refund section ─────────────────────────────────────────────────────
  --
  -- Branch A  p_refund_amount IS NULL or 0    → no refund work
  -- Branch B  amount > 0, method IS NULL       → pending refund row (existing)
  -- Branch C  amount > 0, method IS NOT NULL   → disbursed refund row +
  --                                              negative payment row (new)
  --
  -- ORDERING: Branch C payment INSERT must precede update_booking_total()
  -- (step 10).  After payment INSERT: paid = v_paid_amount - p_refund_amount
  -- = v_extras_total (guaranteed by guard step 4).  After update_booking_total:
  -- total = v_extras_total.  Constraint: paid (extras_total) ≤ total
  -- (extras_total) ✓.

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
        p_booking_id,
        NULL,               -- whole-booking refund; no specific room
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

      -- Negative payment row → trg_sync_paid_amount fires, paid_amount
      -- decrements.  Must precede update_booking_total() (step 10).
      INSERT INTO public.payments (
        booking_id,
        amount,
        method,
        recorded_by,
        notes
      ) VALUES (
        p_booking_id,
        -p_refund_amount,
        p_disbursement_method::public.payment_method,
        p_disbursed_by,
        'Refund disbursement: ref ' || v_refund_id::TEXT
      );

    ELSE

      -- ── Branch B: pending refund (existing Phase 8.5 behaviour) ───────
      INSERT INTO public.refunds (
        booking_id,
        booking_room_id,
        amount,
        reason,
        created_by
      ) VALUES (
        p_booking_id,
        NULL,
        p_refund_amount,
        p_refund_reason,
        p_refund_created_by
      )
      RETURNING id INTO v_refund_id;

    END IF;

  END IF;

  -- ── 10. Recompute total ────────────────────────────────────────────────────
  -- Called AFTER any payment INSERT (Branch C) so that paid_amount is already
  -- decremented when chk_paid_not_exceed_total evaluates on this UPDATE.
  -- In Branch C: paid = v_extras_total, total becomes v_extras_total → ✓.
  -- In Branch B: paid unchanged (≤ v_extras_total per guard step 4) → ✓.
  PERFORM public.update_booking_total(p_booking_id);

  RETURN v_refund_id;

END;
$$;

COMMENT ON FUNCTION public.cancel_booking IS
  'Cancels all confirmed rooms in a booking atomically (raises if any room '
  'is not confirmed). Three refund modes: '
  '(1) no refund params → no refund row; '
  '(2) p_refund_amount only → pending refund row; '
  '(3) p_refund_amount + p_disbursement_method + p_disbursed_by → atomic '
  'disburse: releases rooms, inserts a disbursed refund row and a negative '
  'payment row in the same transaction, then calls update_booking_total(). '
  'Guard: when paid > new_total and no disburse params are provided, raises '
  'with an actionable message (Phase 8.5 behaviour preserved). When disburse '
  'params are provided, validates that the refund covers the full overpayment '
  'so chk_paid_not_exceed_total is satisfied after update_booking_total(). '
  'Returns the refund UUID if any refund row was created, or NULL.';


-- ===========================================================================
-- GRANTS
-- Re-grant after DROP/CREATE cycle on both functions.
-- ===========================================================================

GRANT EXECUTE ON FUNCTION public.cancel_booking_room TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_booking      TO authenticated;


-- ===========================================================================
-- VERIFICATION
-- ===========================================================================

-- Confirm both functions exist at their new 9- and 7-param signatures.
SELECT
  p.proname                                                     AS function_name,
  pg_catalog.pg_get_function_identity_arguments(p.oid)         AS arguments,
  pg_catalog.pg_get_function_result(p.oid)                     AS return_type
FROM pg_catalog.pg_proc p
JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('cancel_booking_room', 'cancel_booking')
ORDER BY p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid);

-- Expected (one row each — no overloads):
--   cancel_booking       | p_booking_id uuid, ..., p_disbursed_by uuid  | uuid
--   cancel_booking_room  | p_booking_room_id uuid, ..., p_disbursed_by uuid | uuid

-- ===========================================================================
-- END OF MIGRATION
-- ===========================================================================

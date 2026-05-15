-- ===========================================================================
-- Phase 11 #58a: Auto-create pending refund on checkout overpayment
-- File:    sql/migrations/2026-05-15-phase11-58a-overpayment-auto-refund.sql
-- Date:    2026-05-15
--
-- Nature:
--   Two schema additions (ALTER TABLE) + three RPC replacements
--   (CREATE OR REPLACE). No trigger changes. No data backfill needed
--   — the fix is purely forward-looking (new checkouts).
--
-- Background:
--   When a guest has paid in full and then checks out early, the
--   checkout_booking RPC reduces booking_rooms.nights, then calls
--   update_booking_total() which lowers bookings.total_amount.
--   If paid_amount > new effective total (total + extras − discount),
--   chk_paid_not_exceed_total fires and the entire checkout hard-fails
--   with a Postgres constraint violation. BK-1075 reproduces this.
--
--   The same failure mode exists in checkout_booking_room when
--   p_deduction_amount > 0 reduces total_amount below paid_amount.
--
--   Design decision (2026-05-15, Arif):
--     System auto-creates a pending refund for the overpayment.
--     Operator handles the refund afterward via Timeline modal:
--       - Disburse (cash/bKash/etc.) → mark_disbursed
--       - Guest gifted/tip → deny_refund with reason
--     "Denied refunds are the tip accounting record."
--
-- Fix — four parts:
--   Section 1: Schema additions
--     a. refunds.pre_adjusted BOOLEAN — TRUE when a negative payment
--        was auto-inserted at checkout time (paid_amount already
--        decremented). disburse_refund uses this flag to avoid
--        inserting a second negative payment (double-decrement).
--     b. payments.refund_id UUID FK → refunds — links auto-created
--        payment rows to their refund record. disburse_refund finds
--        the pre-adjustment payment by refund_id to UPDATE (not INSERT).
--
--   Section 2: checkout_booking — new step 3.5
--     After rooms-to-cleaning (step 3), before update_booking_total
--     (step 4): compute new effective total from live booking_rooms
--     state; if paid_amount exceeds it, INSERT pending refund +
--     negative payment. The negative payment fires trg_sync_paid_amount
--     and decrements paid_amount BEFORE update_booking_total drops
--     total_amount — constraint satisfied.
--
--   Section 3: checkout_booking_room — overpayment detection
--     When p_deduction_amount > 0: read current financials, compute
--     new effective total, INSERT pending refund + negative payment
--     if overpaid, THEN proceed with the deduction UPDATE on bookings.
--     Ordering is critical — payment INSERT must precede the total_amount
--     reduction (same principle as Phase 8.6 cancel_booking_room comment:
--     "Branch C payment INSERT must precede update_booking_total()").
--
--   Section 4: disburse_refund — pre_adjusted branch
--     If pre_adjusted = TRUE: the payment row was already inserted at
--     checkout with method='other'. UPDATE that row to set the actual
--     disbursement method. No new payment INSERT → no double decrement.
--     If pre_adjusted = FALSE: existing INSERT behaviour unchanged.
--
-- Scope — deferred to #58b:
--   Discount-on-paid-booking (additional_discount_amount write in the
--   service layer Step 2 UPDATE after the RPC returns) hits the
--   constraint at the PostgREST layer. Fixing it requires either a
--   trigger on UPDATE OF additional_discount_amount on bookings, or
--   moving the discount write inside the RPC. Different risk surface.
--
-- Payment method for auto-created payment rows:
--   'other'::public.payment_method — reuses existing enum value.
--   Adding a new enum value (e.g., 'auto_refund') requires ALTER TYPE
--   ADD VALUE which cannot run inside a transaction block. 'other' is
--   safe and the notes / refund_id FK provide full context.
--   When disburse_refund fires, the method is updated to the actual
--   disbursement method (cash / bkash / etc.).
--
-- fn_sync_paid_amount safety:
--   Phase 8.5 fail-fast guard raises if v_new < 0. Auto-payment is
--   amount = −v_overpayment where v_overpayment = paid − effective_total
--   > 0. Result: paid − v_overpayment = effective_total ≥ 0. Safe.
--
-- chk_paid_not_exceed_total ordering:
--   In checkout_booking: negative payment fires trg_sync_paid_amount
--   (paid_amount decremented) BEFORE update_booking_total reduces
--   total_amount. In checkout_booking_room: negative payment INSERT
--   precedes the inline UPDATE bookings SET total_amount. Both orderings
--   satisfy the constraint.
--
-- Apply mode:
--   SQL Editor (service role). Sections 1–4 can run as one block.
--   Section 5 queries are read-only — run separately after applying.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- Section 1: Schema additions
-- ---------------------------------------------------------------------------

-- 1a. refunds.pre_adjusted
--   TRUE  = a negative payment was auto-inserted at checkout time.
--           paid_amount is already decremented. disburse_refund must
--           UPDATE the existing payment row, not INSERT a new one.
--   FALSE = normal pending refund created at cancellation. disburse_refund
--           INSERTs a new negative payment row (existing behaviour).
--   DEFAULT FALSE preserves existing behaviour for all current refund rows.

ALTER TABLE public.refunds
  ADD COLUMN IF NOT EXISTS pre_adjusted BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.refunds.pre_adjusted IS
  'TRUE = negative payment row already inserted at checkout time to satisfy '
  'chk_paid_not_exceed_total (paid_amount already decremented). '
  'disburse_refund must UPDATE that existing payment row instead of inserting '
  'a new one to avoid double-decrementing paid_amount. '
  'FALSE = normal cancellation-path pending refund (existing behaviour).';


-- 1b. payments.refund_id FK
--   Links auto-created adjustment payment rows to their refund record.
--   disburse_refund uses this FK to find the pre-adjustment payment for
--   UPDATE (instead of the fragile notes LIKE pattern).
--   NULL for all existing payment rows and for normal (non-auto) payments.
--   ON DELETE SET NULL: if a refund row is deleted, the payment row is
--   not lost — refund_id just becomes NULL.

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS refund_id UUID NULL
    REFERENCES public.refunds(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.payments.refund_id IS
  'Non-null only for auto-refund pre-adjustment payments created by '
  'checkout_booking or checkout_booking_room when overpayment is detected. '
  'Links the payment to its pending refund row. Used by disburse_refund to '
  'locate and UPDATE the pre-adjustment payment (not INSERT a duplicate).';


-- ---------------------------------------------------------------------------
-- Section 2: Replace checkout_booking — add overpayment detection (step 3.5)
--
-- Changes vs Phase 11 #57 version:
--   a. DECLARE block gains 7 new variables for overpayment calculation.
--   b. New step 3.5 inserted between step 3 (rooms to cleaning) and
--      step 4 (update_booking_total). Reads post-CTE booking_rooms.nights
--      to compute new effective total; inserts pending refund + negative
--      payment if overpayment exists.
--   c. All other steps unchanged.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.checkout_booking(
  p_booking_id           UUID,
  p_actual_checkout_date DATE DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_room_ids        UUID[];
  -- Step 3.5: overpayment detection
  v_new_rooms_total NUMERIC;
  v_paid_amount     NUMERIC;
  v_extra_charge    NUMERIC;
  v_discount        NUMERIC;
  v_effective_total NUMERIC;
  v_overpayment     NUMERIC;
  v_refund_id       UUID;
BEGIN

  -- ── 1. Validate booking exists ────────────────────────────────────────────
  IF NOT EXISTS (SELECT 1 FROM public.bookings WHERE id = p_booking_id) THEN
    RAISE EXCEPTION 'booking % not found', p_booking_id;
  END IF;

  -- ── 2. Per-room early deductions + bulk checkout via CTE ──────────────────
  -- active_rooms snapshots each active room and pre-computes:
  --   early_nights = GREATEST(0, scheduled_date − actual_date)
  --                  0 when p_actual_checkout_date IS NULL (on-time checkout)
  --   deduction_amt = early_nights × booking_rate
  --
  -- The upd CTE bulk-UPDATEs booking_rooms using these values and RETURNs
  -- room_id for step 3. Both CTEs execute atomically in one statement.
  --
  -- Status convention (matches cancel_booking_room):
  --   early_nights > 0 → checked_out_early
  --   early_nights = 0 → checked_out
  --
  -- GREATEST(1, ar.nights - ar.early_nights): floor prevents nights = 0 in
  -- the degenerate case where p_actual_checkout_date = check_in_date.
  WITH active_rooms AS (
    SELECT id                                                              AS room_row_id,
           room_id,
           check_out_date,
           booking_rate,
           nights,
           GREATEST(0,
             check_out_date
             - COALESCE(p_actual_checkout_date, check_out_date)
           )                                                               AS early_nights,
           GREATEST(0,
             check_out_date
             - COALESCE(p_actual_checkout_date, check_out_date)
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

  -- ── 3. Set physical rooms to cleaning ─────────────────────────────────────
  -- v_room_ids is NULL when 0 active rows (already-terminal booking).
  -- Guard prevents a vacuous ANY(NULL) match.
  IF v_room_ids IS NOT NULL THEN
    UPDATE public.rooms
    SET    status     = 'cleaning',
           updated_at = NOW()
    WHERE  id = ANY(v_room_ids);
  END IF;

  -- ── 3.5. Detect overpayment and auto-create pending refund ────────────────
  -- Must run BEFORE update_booking_total (step 4) so that paid_amount is
  -- already decremented when chk_paid_not_exceed_total evaluates.
  --
  -- Reads booking_rooms.nights AFTER step 2's CTE reduced them — these are
  -- the same values update_booking_total will sum. The computation mirrors
  -- update_booking_total's SUM(nights × booking_rate) for non-cancelled rooms.
  --
  -- If no overpayment exists (on-time checkout with outstanding balance, or
  -- paid exactly equals new total), this block is a no-op.
  SELECT COALESCE(SUM(br.nights * br.booking_rate), 0),
         b.paid_amount,
         COALESCE(b.extra_charge_amount, 0),
         COALESCE(b.additional_discount_amount, 0)
  INTO   v_new_rooms_total, v_paid_amount, v_extra_charge, v_discount
  FROM   public.bookings b
  LEFT JOIN public.booking_rooms br
         ON br.booking_id = b.id
        AND br.status NOT IN ('cancelled')
  WHERE  b.id = p_booking_id
  GROUP BY b.paid_amount, b.extra_charge_amount, b.additional_discount_amount;

  v_effective_total := v_new_rooms_total + v_extra_charge - v_discount;

  IF v_paid_amount > v_effective_total THEN
    v_overpayment := v_paid_amount - v_effective_total;

    -- Insert pending refund (pre_adjusted = TRUE signals pre-adjustment).
    INSERT INTO public.refunds (
      booking_id,
      booking_room_id,
      amount,
      reason,
      status,
      created_by,
      pre_adjusted
    ) VALUES (
      p_booking_id,
      NULL,                          -- booking-level refund, not per-room
      v_overpayment,
      'Auto-created from checkout — overpayment ৳' || v_overpayment::TEXT,
      'pending',
      NULL,                          -- system-created; no operator user
      TRUE
    ) RETURNING id INTO v_refund_id;

    -- Insert negative payment → trg_sync_paid_amount fires → paid_amount
    -- decremented to v_effective_total. refund_id FK links this payment
    -- to the refund row so disburse_refund can find it by FK instead of
    -- using a fragile notes-based lookup.
    -- method = 'other' (no new enum value needed; updated to actual method
    -- when operator calls disburse_refund).
    INSERT INTO public.payments (
      booking_id,
      amount,
      method,
      notes,
      refund_id
    ) VALUES (
      p_booking_id,
      -v_overpayment,
      'other'::public.payment_method,
      'Auto-refund pre-adjustment — refund row ' || v_refund_id::TEXT,
      v_refund_id
    );
    -- trg_sync_paid_amount fires after this INSERT.
    -- paid_amount is now = v_effective_total.
  END IF;

  -- ── 4. Recompute booking total ────────────────────────────────────────────
  -- update_booking_total sums SUM(nights × booking_rate) from non-cancelled
  -- booking_rooms. Step 2 already reduced per-room nights, so this yields
  -- the correct lower total. Step 3.5 already decremented paid_amount when
  -- needed, so chk_paid_not_exceed_total will not fire. Fires
  -- trg_sync_payment_status → payment_status updated atomically.
  PERFORM public.update_booking_total(p_booking_id);

  -- ── 5. Promote booking to checked_out ─────────────────────────────────────
  -- IS DISTINCT FROM guard prevents a no-op UPDATE from firing triggers.
  UPDATE public.bookings
  SET    status = 'checked_out'
  WHERE  id     = p_booking_id
    AND  status IS DISTINCT FROM 'checked_out';

END;
$$;

COMMENT ON FUNCTION public.checkout_booking IS
  'Checks out all active rooms on a booking. Computes per-room early '
  'deductions from each room''s own check_out_date. Sets '
  'booking_rooms.status=checked_out(_early), rooms.status=cleaning, '
  'reduces nights, recomputes total, promotes bookings.status=checked_out. '
  'check_out_date preserved as original scheduled date; actual_checkout_date '
  'records real departure. '
  'Phase 11 #58a: auto-creates a pending refund + negative payment when '
  'paid_amount exceeds effective total after deductions, satisfying '
  'chk_paid_not_exceed_total before update_booking_total fires.';

GRANT EXECUTE ON FUNCTION public.checkout_booking(UUID, DATE)
  TO anon, authenticated;


-- ---------------------------------------------------------------------------
-- Section 3: Replace checkout_booking_room — overpayment detection
--
-- Changes vs Phase 11 #57 version:
--   a. DECLARE block gains 7 new variables.
--   b. When p_deduction_amount > 0: read current booking financials,
--      compute new effective total, INSERT pending refund + negative payment
--      if overpaid — BEFORE the inline UPDATE bookings SET total_amount.
--      Ordering is critical: negative payment must precede the total_amount
--      reduction so paid_amount is decremented when the constraint fires.
--   c. All other logic unchanged.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.checkout_booking_room(
  p_booking_room_id       UUID,
  p_actual_checkout_date  DATE     DEFAULT NULL,  -- NULL = stayed to scheduled date
  p_early_nights_deducted INTEGER  DEFAULT 0,
  p_deduction_amount      NUMERIC  DEFAULT 0
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_booking_id      UUID;
  v_room_id         UUID;
  v_active_count    INTEGER;
  -- Overpayment detection
  v_paid_amount     NUMERIC;
  v_current_total   NUMERIC;
  v_extra_charge    NUMERIC;
  v_discount        NUMERIC;
  v_new_total       NUMERIC;
  v_effective_total NUMERIC;
  v_overpayment     NUMERIC;
  v_refund_id       UUID;
BEGIN
  -- Read context
  SELECT booking_id, room_id
  INTO   v_booking_id, v_room_id
  FROM   public.booking_rooms
  WHERE  id = p_booking_room_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'booking_room % not found', p_booking_room_id;
  END IF;

  -- Update this room's row
  UPDATE public.booking_rooms
  SET status                 = 'checked_out',
      checked_out_at         = NOW(),
      actual_checkout_date   = COALESCE(p_actual_checkout_date, check_out_date),
      early_nights_deducted  = p_early_nights_deducted,
      early_deduction_amount = p_deduction_amount,
      -- Adjust nights if early departure was recorded
      nights                 = CASE WHEN p_early_nights_deducted > 0
                                 THEN nights - p_early_nights_deducted
                                 ELSE nights END,
      -- check_out_date intentionally omitted — stays as original scheduled date
      updated_at             = NOW()
  WHERE id = p_booking_room_id;

  -- Deduct unused nights from booking total (fires trg_sync_payment_status)
  IF p_deduction_amount > 0 THEN

    -- ── Overpayment detection — must precede total_amount reduction ─────────
    -- Read current booking financials to compute new effective total after
    -- the deduction. If paid_amount would exceed it, INSERT pending refund +
    -- negative payment BEFORE reducing total_amount, so paid_amount is already
    -- decremented when chk_paid_not_exceed_total evaluates on the next UPDATE.
    SELECT b.paid_amount,
           b.total_amount,
           COALESCE(b.extra_charge_amount, 0),
           COALESCE(b.additional_discount_amount, 0)
    INTO   v_paid_amount, v_current_total, v_extra_charge, v_discount
    FROM   public.bookings b
    WHERE  b.id = v_booking_id;

    v_new_total       := GREATEST(0, v_current_total - p_deduction_amount);
    v_effective_total := v_new_total + v_extra_charge - v_discount;

    IF v_paid_amount > v_effective_total THEN
      v_overpayment := v_paid_amount - v_effective_total;

      INSERT INTO public.refunds (
        booking_id,
        booking_room_id,
        amount,
        reason,
        status,
        created_by,
        pre_adjusted
      ) VALUES (
        v_booking_id,
        p_booking_room_id,             -- per-room refund
        v_overpayment,
        'Auto-created from checkout — overpayment ৳' || v_overpayment::TEXT,
        'pending',
        NULL,
        TRUE
      ) RETURNING id INTO v_refund_id;

      INSERT INTO public.payments (
        booking_id,
        amount,
        method,
        notes,
        refund_id
      ) VALUES (
        v_booking_id,
        -v_overpayment,
        'other'::public.payment_method,
        'Auto-refund pre-adjustment — refund row ' || v_refund_id::TEXT,
        v_refund_id
      );
      -- trg_sync_paid_amount fires; paid_amount now = v_effective_total
    END IF;
    -- ── End overpayment detection ───────────────────────────────────────────

    UPDATE public.bookings
    SET total_amount = GREATEST(0, total_amount - p_deduction_amount)
    WHERE id = v_booking_id;
    -- chk_paid_not_exceed_total evaluates here — paid_amount already correct.

  END IF;

  -- Set physical room to cleaning
  UPDATE public.rooms
  SET    status     = 'cleaning',
         updated_at = NOW()
  WHERE  id = v_room_id;

  -- Advance booking to checked_out if no rooms are still active
  SELECT COUNT(*) INTO v_active_count
  FROM   public.booking_rooms
  WHERE  booking_id = v_booking_id
    AND  status IN ('confirmed', 'checked_in');

  IF v_active_count = 0 THEN
    -- trg_stamp_booking_timestamps will stamp checked_out_at on bookings
    UPDATE public.bookings
    SET status = 'checked_out'
    WHERE id = v_booking_id
      AND status IS DISTINCT FROM 'checked_out';
  END IF;

END;
$$;

COMMENT ON FUNCTION public.checkout_booking_room IS
  'Checks out one room. Sets status=checked_out, room=cleaning. '
  'check_out_date preserved as original scheduled date; actual_checkout_date '
  'records real departure. Advances booking to checked_out when last room '
  'completes. '
  'Phase 11 #58a: when p_deduction_amount > 0, auto-creates a pending '
  'refund + negative payment if paid_amount would exceed effective total, '
  'satisfying chk_paid_not_exceed_total before the total_amount reduction.';

GRANT EXECUTE ON FUNCTION public.checkout_booking_room(UUID, DATE, INTEGER, NUMERIC)
  TO anon, authenticated;


-- ---------------------------------------------------------------------------
-- Section 4: Replace disburse_refund — pre_adjusted branch
--
-- Changes vs Phase 8.5 version (2026-05-09-phase8.5-refund-disbursement.sql):
--   a. DECLARE block gains v_pre_adjusted BOOLEAN.
--   b. Step 1 SELECT now also reads pre_adjusted.
--   c. Step 3 branches on pre_adjusted:
--      pre_adjusted = TRUE  → UPDATE existing payment row (method + notes)
--                             No new INSERT. No second paid_amount decrement.
--      pre_adjusted = FALSE → Existing INSERT behaviour unchanged.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.disburse_refund(
  p_refund_id           UUID,
  p_disbursement_method TEXT,
  p_disbursed_by        UUID,
  p_notes               TEXT  DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_booking_id   UUID;
  v_amount       NUMERIC;
  v_status       TEXT;
  v_pre_adjusted BOOLEAN;
BEGIN

  -- ── 1. Read and validate refund row ──────────────────────────────────────
  SELECT booking_id, amount, status, pre_adjusted
  INTO   v_booking_id, v_amount, v_status, v_pre_adjusted
  FROM   public.refunds
  WHERE  id = p_refund_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'refund % not found', p_refund_id;
  END IF;

  IF v_status <> 'pending' THEN
    RAISE EXCEPTION
      'Cannot disburse refund % — current status is %. '
      'Only pending refunds can be disbursed.',
      p_refund_id, v_status;
  END IF;

  IF p_disbursement_method NOT IN ('cash', 'bkash', 'nagad', 'bank_transfer', 'card') THEN
    RAISE EXCEPTION
      'Invalid disbursement_method ''%''. '
      'Must be one of: cash, bkash, nagad, bank_transfer, card.',
      p_disbursement_method;
  END IF;

  -- ── 2. Mark refund as disbursed ──────────────────────────────────────────
  UPDATE public.refunds
  SET    status              = 'disbursed',
         disbursed_at        = NOW(),
         disbursed_by        = p_disbursed_by,
         disbursement_method = p_disbursement_method,
         notes               = COALESCE(p_notes, notes)
  WHERE  id = p_refund_id;

  -- ── 3. Payment row — branch on pre_adjusted ───────────────────────────────
  IF v_pre_adjusted THEN

    -- Auto-refund path: a negative payment was already inserted at checkout
    -- time (paid_amount already decremented). UPDATE that payment row to
    -- reflect the actual disbursement method. Do NOT insert a new payment row
    -- — that would double-decrement paid_amount.
    UPDATE public.payments
    SET    method = p_disbursement_method::public.payment_method,
           notes  = 'Refund disbursed: ' || p_refund_id::TEXT
    WHERE  refund_id = p_refund_id;
    -- trg_sync_paid_amount does NOT fire on payments UPDATE (only INSERT OR
    -- DELETE). paid_amount is already correct. No trigger cascade.

  ELSE

    -- Normal path (cancellation-created pending refund): insert negative
    -- payment row → trg_sync_paid_amount fires → paid_amount decremented.
    -- Raises if paid_amount would go negative (Phase 8.5 fail-fast guard).
    INSERT INTO public.payments (
      booking_id,
      amount,
      method,
      recorded_by,
      notes
    ) VALUES (
      v_booking_id,
      -v_amount,
      p_disbursement_method::public.payment_method,
      p_disbursed_by,
      'Refund disbursement: ref ' || p_refund_id::TEXT
    );
    -- trg_sync_paid_amount fires automatically after the INSERT above.

  END IF;

END;
$$;

COMMENT ON FUNCTION public.disburse_refund IS
  'Marks a pending refund as disbursed. '
  'pre_adjusted = FALSE (normal path): inserts negative payment row → '
  'trg_sync_paid_amount fires → paid_amount decremented. '
  'pre_adjusted = TRUE (auto-refund path, Phase 11 #58a): paid_amount was '
  'already decremented at checkout. Updates the existing payment row''s '
  'method to the actual disbursement method — no new payment INSERT, no '
  'double-decrement. '
  'Raises if refund not pending, if method is invalid, or (normal path only) '
  'if disbursement would make paid_amount negative.';

GRANT EXECUTE ON FUNCTION public.disburse_refund TO authenticated;


-- ---------------------------------------------------------------------------
-- Section 5: Verification (run in SQL Editor after applying Sections 1–4)
-- ---------------------------------------------------------------------------

-- V1: Confirm schema additions exist
--
-- SELECT column_name, data_type, is_nullable, column_default
-- FROM   information_schema.columns
-- WHERE  table_schema = 'public'
--   AND  table_name   = 'refunds'
--   AND  column_name  = 'pre_adjusted';
--
-- Expected:
--   column_name  | data_type | is_nullable | column_default
--   pre_adjusted | boolean   | NO          | false

-- SELECT column_name, data_type, is_nullable
-- FROM   information_schema.columns
-- WHERE  table_schema = 'public'
--   AND  table_name   = 'payments'
--   AND  column_name  = 'refund_id';
--
-- Expected:
--   column_name | data_type         | is_nullable
--   refund_id   | uuid              | YES

-- V2: Test BK-1075 checkout (the previously hard-blocked booking)
--   Pre-state: paid_amount = X, total_amount = Y, X > Y (fully paid,
--   early departure)
--
-- After calling checkout_booking for BK-1075:
--
-- SELECT r.amount, r.status, r.reason, r.pre_adjusted
-- FROM   public.refunds r
-- JOIN   public.bookings b ON b.id = r.booking_id
-- WHERE  b.booking_ref = 'BK-1075'
-- ORDER BY r.created_at DESC LIMIT 1;
--
-- Expected: amount = overpayment, status='pending', pre_adjusted=TRUE

-- SELECT p.amount, p.method, p.notes, p.refund_id
-- FROM   public.payments p
-- JOIN   public.bookings b ON b.id = p.booking_id
-- WHERE  b.booking_ref = 'BK-1075'
--   AND  p.amount < 0
-- ORDER BY p.created_at DESC LIMIT 1;
--
-- Expected: amount = -overpayment, method='other', refund_id = (refund UUID above)

-- SELECT paid_amount,
--        total_amount + COALESCE(extra_charge_amount, 0)
--                     - COALESCE(additional_discount_amount, 0) AS effective_total
-- FROM   public.bookings WHERE booking_ref = 'BK-1075';
--
-- Expected: paid_amount = effective_total (constraint satisfied)

-- V3: Test disburse_refund on the auto-created pending refund
--   After operator clicks Mark Disbursed → cash in Timeline modal:
--
-- SELECT p.amount, p.method, p.notes
-- FROM   public.payments p
-- JOIN   public.bookings b ON b.id = p.booking_id
-- WHERE  b.booking_ref = 'BK-1075'
--   AND  p.amount < 0;
--
-- Expected: exactly ONE negative row, method='cash' (updated by disburse_refund)
-- Confirm: no second negative row inserted (double-decrement guard worked)

-- SELECT paid_amount,
--        total_amount + COALESCE(extra_charge_amount, 0)
--                     - COALESCE(additional_discount_amount, 0) AS effective_total
-- FROM   public.bookings WHERE booking_ref = 'BK-1075';
--
-- Expected: paid_amount UNCHANGED from V2 (no second decrement)

-- V4: Confirm existing (normal) pending refund disbursement unaffected
--   Pick any pre-existing pending refund (pre_adjusted = FALSE):
--
-- SELECT id, amount, status, pre_adjusted
-- FROM   public.refunds
-- WHERE  status = 'pending' AND pre_adjusted = FALSE
-- LIMIT 1;
--
-- Disburse it via disburse_refund(). Then:
--
-- SELECT p.amount, p.method FROM public.payments p
-- JOIN   public.bookings b ON b.id = p.booking_id
-- WHERE  p.amount < 0
-- ORDER BY p.created_at DESC LIMIT 1;
--
-- Expected: NEW negative payment row inserted (normal path unchanged)


-- ===========================================================================
-- END OF MIGRATION
-- ===========================================================================

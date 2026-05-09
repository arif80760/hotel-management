-- ===========================================================================
-- Phase 8.5: Cancellation + Refund Disbursement Flow
-- File:    sql/migrations/2026-05-09-phase8.5-refund-disbursement.sql
-- Date:    2026-05-09
-- Apply:   After 2026-05-09-checkin-booking-room-rpc.sql
--
-- Changes:
--   1a. Relax payments.amount constraint from > 0 to <> 0, permitting
--       negative disbursement outflow rows.
--
--   1b. Replace fn_sync_paid_amount with a fail-fast version that raises
--       rather than silently flooring to 0 via GREATEST when a disburse
--       would result in negative paid_amount.
--
--   1c. New RPC: disburse_refund — marks a pending refund as disbursed
--       and inserts a negative payment row; trg_sync_paid_amount fires
--       automatically and decrements bookings.paid_amount.
--
--   1d. New RPC: deny_refund — marks a pending refund as denied; no
--       payment row inserted, no paid_amount change.
--
--   1e. New RPC: cancel_booking — atomically cancels all confirmed rooms,
--       frees physical rooms, updates booking status, optionally creates
--       a pending refund record, and recomputes total via
--       update_booking_total().
-- ===========================================================================


-- ===========================================================================
-- 1a. Relax payments.amount constraint: > 0  →  <> 0
--
-- The inline CHECK is auto-named by Postgres as payments_amount_check.
-- DROP IF EXISTS is safe — we immediately re-add with the new expression.
-- ===========================================================================

ALTER TABLE public.payments
  DROP CONSTRAINT IF EXISTS payments_amount_check;

ALTER TABLE public.payments
  ADD CONSTRAINT payments_amount_check
  CHECK (amount <> 0);

COMMENT ON COLUMN public.payments.amount IS
  'Transaction amount. Positive = inflow (guest payment). '
  'Negative = outflow (refund disbursement inserted by disburse_refund). '
  'Zero is forbidden.';


-- ===========================================================================
-- 1b. Replace fn_sync_paid_amount — fail-fast on negative paid_amount
--
-- Old formula: GREATEST(0, paid_amount + NEW.amount)
--   Problem: a disbursement of ৳500 when paid_amount = ৳200 silently
--   floors to 0 instead of raising — data loss disguised as success.
--
-- New formula: read current paid_amount, add NEW.amount, raise if < 0.
--   A negative result means a disbursement was issued for more than was
--   ever received, which is a programming error and should fail hard.
--
-- The trigger name, table, and firing event are unchanged.
-- CREATE OR REPLACE replaces the body in place.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.fn_sync_paid_amount()
RETURNS TRIGGER AS $$
DECLARE
  v_current NUMERIC;
  v_new     NUMERIC;
BEGIN
  SELECT paid_amount INTO v_current
  FROM   public.bookings
  WHERE  id = NEW.booking_id;

  v_new := v_current + NEW.amount;

  IF v_new < 0 THEN
    RAISE EXCEPTION
      'Disbursement of % would result in negative paid_amount '
      '(current: %, projected: %). '
      'Cannot disburse more than has been received.',
      NEW.amount, v_current, v_new;
  END IF;

  UPDATE public.bookings
  SET    paid_amount = v_new
  WHERE  id = NEW.booking_id;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION public.fn_sync_paid_amount IS
  'Increments (or decrements for negative amounts) bookings.paid_amount on '
  'each INSERT into payments. Raises if the result would be negative — '
  'prevents disbursing more than was received. Fired by trg_sync_paid_amount.';


-- ===========================================================================
-- 1c. disburse_refund
--
-- Marks a pending refund as disbursed and inserts a negative payment row
-- so that trg_sync_paid_amount automatically decrements paid_amount.
-- Both the refund UPDATE and the payment INSERT run in the same transaction.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.disburse_refund(
  p_refund_id           UUID,
  p_disbursement_method TEXT,
  p_disbursed_by        UUID,
  p_notes               TEXT  DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql AS $$
DECLARE
  v_booking_id  UUID;
  v_amount      NUMERIC;
  v_status      TEXT;
BEGIN

  -- ── 1. Read and validate refund row ──────────────────────────────────
  SELECT booking_id, amount, status
  INTO   v_booking_id, v_amount, v_status
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

  -- ── 2. Mark refund as disbursed ──────────────────────────────────────
  UPDATE public.refunds
  SET    status               = 'disbursed',
         disbursed_at         = NOW(),
         disbursed_by         = p_disbursed_by,
         disbursement_method  = p_disbursement_method,
         notes                = COALESCE(p_notes, notes)
  WHERE  id = p_refund_id;

  -- ── 3. Insert negative payment row ───────────────────────────────────
  -- Negative amount = outflow.  trg_sync_paid_amount fires on this INSERT
  -- and decrements bookings.paid_amount.  If paid_amount would go negative,
  -- fn_sync_paid_amount raises and the entire transaction rolls back.
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
    'Refund disbursement: ref ' || p_refund_id::text
  );

  -- trg_sync_paid_amount fires automatically after the INSERT above.

END;
$$;

COMMENT ON FUNCTION public.disburse_refund IS
  'Marks a pending refund as disbursed and inserts a negative payment row '
  'to decrement bookings.paid_amount via trg_sync_paid_amount. '
  'Raises if the refund is not pending, if the method is invalid, or if '
  'the disbursement would make paid_amount negative. Single transaction — '
  'either both the refund update and payment insert commit, or neither does.';


-- ===========================================================================
-- 1d. deny_refund
--
-- Marks a pending refund as denied. No payment row is inserted and
-- paid_amount is not changed. The denial reason is appended to notes so
-- the original reason is preserved.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.deny_refund(
  p_refund_id UUID,
  p_reason    TEXT,
  p_denied_by UUID
) RETURNS VOID
LANGUAGE plpgsql AS $$
DECLARE
  v_status TEXT;
BEGIN

  -- ── 1. Read and validate ──────────────────────────────────────────────
  SELECT status INTO v_status
  FROM   public.refunds
  WHERE  id = p_refund_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'refund % not found', p_refund_id;
  END IF;

  IF v_status <> 'pending' THEN
    RAISE EXCEPTION
      'Cannot deny refund % — current status is %. '
      'Only pending refunds can be denied.',
      p_refund_id, v_status;
  END IF;

  -- ── 2. Mark as denied, append reason to notes ────────────────────────
  -- COALESCE(notes, '') preserves the original reason if present;
  -- TRIM removes leading ' / ' when notes was NULL.
  UPDATE public.refunds
  SET    status = 'denied',
         notes  = TRIM(
                    BOTH ' / ' FROM
                    CONCAT(COALESCE(notes, ''), ' / DENIED: ', TRIM(p_reason))
                  )
  WHERE  id = p_refund_id;

END;
$$;

COMMENT ON FUNCTION public.deny_refund IS
  'Marks a pending refund as denied. Appends denial reason to notes '
  'so the original refund reason is preserved. No payment row inserted, '
  'no paid_amount change. p_denied_by is reserved for future audit columns.';


-- ===========================================================================
-- 1e. cancel_booking
--
-- Atomically cancels all rooms in a booking (pre-check-in only — all rooms
-- must be status=confirmed).  Updates physical room statuses to available,
-- updates the booking status to cancelled, recomputes total via
-- update_booking_total() (→ 0 when no extras), and optionally creates a
-- pending refund record for the amount already paid.
--
-- Locked design: rooms with status != 'confirmed' cause an exception.
-- Mid-stay cancellations must use per-room cancel_booking_room.
--
-- Guards (in order, all fail-fast before any writes):
--   1. Booking exists
--   2. All rooms confirmed (no checked-in rooms)
--   3. chk_paid_not_exceed_total pre-check: paid_amount <= extras_total
--      after cancellation; raises with actionable message if not
--   4. Refund amount cap: p_refund_amount <= paid_amount
--
-- Returns: refund UUID if a refund row was created, NULL otherwise.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.cancel_booking(
  p_booking_id          UUID,
  p_refund_amount       NUMERIC  DEFAULT NULL,
  p_refund_reason       TEXT     DEFAULT NULL,
  p_refund_created_by   UUID     DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql AS $$
DECLARE
  v_paid_amount     NUMERIC;
  v_extras_total    NUMERIC;
  v_bad_room_number TEXT;
  v_bad_status      TEXT;
  v_refund_id       UUID := NULL;
BEGIN

  -- ── 1. Read booking ───────────────────────────────────────────────────
  SELECT paid_amount
  INTO   v_paid_amount
  FROM   public.bookings
  WHERE  id = p_booking_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'booking % not found', p_booking_id;
  END IF;

  -- ── 2. Guard: all rooms must be confirmed ─────────────────────────────
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

  -- ── 3. Guard: chk_paid_not_exceed_total pre-check ─────────────────────
  -- After cancellation, update_booking_total() will set total_amount to
  -- extras only (all rooms cancelled → rooms contribute 0).  The existing
  -- DB constraint chk_paid_not_exceed_total CHECK (paid_amount <= total_amount)
  -- would then reject the UPDATE on bookings.  Pre-empt it here with an
  -- actionable message so the operator knows what to clear first.
  SELECT COALESCE(SUM(amount), 0)
  INTO   v_extras_total
  FROM   public.booking_extra_charges
  WHERE  booking_id = p_booking_id;

  IF v_paid_amount > v_extras_total THEN
    RAISE EXCEPTION
      'Cannot cancel booking % — paid_amount (%) exceeds remaining '
      'total (%) after cancellation. Disburse pending refunds totalling '
      'at least % first to clear the overpayment.',
      p_booking_id,
      v_paid_amount,
      v_extras_total,
      (v_paid_amount - v_extras_total);
  END IF;

  -- ── 4. Guard: refund cap ──────────────────────────────────────────────
  IF p_refund_amount IS NOT NULL AND p_refund_amount > v_paid_amount THEN
    RAISE EXCEPTION
      'Refund amount % exceeds paid_amount % for booking %.',
      p_refund_amount, v_paid_amount, p_booking_id;
  END IF;

  -- ── 5. Cancel all booking_rooms ───────────────────────────────────────
  UPDATE public.booking_rooms
  SET    status       = 'cancelled'::public.booking_status,
         cancelled_at = NOW(),
         updated_at   = NOW()
  WHERE  booking_id = p_booking_id
    AND  status     = 'confirmed'::public.booking_status;

  -- ── 6. Release physical rooms ─────────────────────────────────────────
  UPDATE public.rooms r
  SET    status     = 'available'::public.room_status,
         updated_at = NOW()
  FROM   public.booking_rooms br
  WHERE  br.room_id    = r.id
    AND  br.booking_id = p_booking_id;

  -- ── 7. Update booking status ──────────────────────────────────────────
  UPDATE public.bookings
  SET    status = 'cancelled'::public.booking_status
  WHERE  id     = p_booking_id;

  -- ── 8. Recompute total (all rooms now cancelled → extras only) ─────────
  PERFORM public.update_booking_total(p_booking_id);

  -- ── 9. Optional refund record ─────────────────────────────────────────
  IF p_refund_amount IS NOT NULL AND p_refund_amount > 0 THEN
    INSERT INTO public.refunds (
      booking_id,
      booking_room_id,    -- NULL = whole-booking refund
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

  RETURN v_refund_id;

END;
$$;

COMMENT ON FUNCTION public.cancel_booking IS
  'Cancels all confirmed rooms in a booking atomically (raises if any room '
  'is checked_in or already cancelled/checked_out). Pre-checks that '
  'paid_amount will not exceed post-cancel total (extras only) — production '
  'has chk_paid_not_exceed_total CHECK (paid_amount <= total_amount) which '
  'would otherwise reject the update_booking_total() call. Frees physical '
  'rooms to available, updates booking status to cancelled, recomputes total '
  'via update_booking_total(). Optionally creates a pending refund record. '
  'Returns the refund UUID if created, or NULL. '
  'Locked design: only pre-checkin whole-cancel is supported here. '
  'Mid-stay must use cancel_booking_room per room.';


-- ===========================================================================
-- GRANTS
-- ===========================================================================

GRANT EXECUTE ON FUNCTION public.disburse_refund TO authenticated;
GRANT EXECUTE ON FUNCTION public.deny_refund      TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_booking   TO authenticated;


-- ===========================================================================
-- VERIFICATION
-- ===========================================================================

SELECT
  p.proname                                                          AS function_name,
  pg_catalog.pg_get_function_identity_arguments(p.oid)              AS arguments,
  pg_catalog.pg_get_function_result(p.oid)                          AS return_type
FROM pg_catalog.pg_proc p
JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('disburse_refund', 'deny_refund', 'cancel_booking',
                    'fn_sync_paid_amount')
ORDER BY p.proname;

-- Expected:
--   cancel_booking      | p_booking_id uuid, ...   | uuid
--   deny_refund         | p_refund_id uuid, ...    | void
--   disburse_refund     | p_refund_id uuid, ...    | void
--   fn_sync_paid_amount | (trigger function)       |

SELECT conname, pg_get_constraintdef(oid) AS definition
FROM   pg_constraint
WHERE  conrelid = 'public.payments'::regclass
  AND  conname  = 'payments_amount_check';

-- Expected: payments_amount_check | CHECK ((amount <> 0))

-- ===========================================================================
-- END OF MIGRATION
-- ===========================================================================

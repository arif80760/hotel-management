-- ===========================================================================
-- Phase 11 Item #4: payment_status = 'cancelled' for cancelled bookings
-- File:    sql/migrations/2026-05-10-phase11-payment-status-cancelled.sql
-- Date:    2026-05-10
-- Apply:   After 2026-05-10-phase11-deny-refund-reason.sql
--
-- Problem:
--   fn_sync_payment_status derives payment_status solely from paid_amount
--   vs total_amount, with no awareness of bookings.status.
--   Cancelled bookings (total_amount = 0, paid_amount = 0) satisfy the
--   WHEN paid_amount <= 0 branch and permanently show payment_status =
--   'unpaid' — indistinguishable from a confirmed booking that has not
--   yet received any payment.
--
-- Fix:
--   1. Add enum value 'cancelled' to public.payment_status.
--   2. Extend fn_sync_payment_status to check NEW.status first, before
--      any paid/total comparison.  Cancelled bookings always resolve to
--      'cancelled' regardless of amounts.
--   3. Extend the trigger OF clause to include status, so the trigger
--      fires when a booking transitions to 'cancelled'.
--   4. Backfill: touch all existing cancelled rows so the new trigger
--      logic fires on each and writes payment_status = 'cancelled'.
--
-- ── HOW TO RUN (IMPORTANT — TWO SEPARATE RUNS REQUIRED) ─────────────
--
-- ALTER TYPE ... ADD VALUE cannot run in the same transaction as a
-- subsequent DML that writes the new enum label on Postgres < 14.
-- On Postgres 14+ it CAN run in the same transaction, but only if the
-- new value is not used in the same command that added it — Postgres
-- still prohibits using a freshly-added label within the same
-- transaction on some versions.
--
-- Supabase's SQL Editor wraps every execution in an implicit
-- transaction.  To be safe on ALL Postgres versions (verify yours with
-- SELECT version(); in the SQL Editor before running):
--
--   RUN 1 — paste and run only the block marked "═══ RUN 1 ═══" below.
--            This adds the 'cancelled' enum value and commits it.
--
--   RUN 2 — paste and run only the block marked "═══ RUN 2 ═══" below.
--            This replaces the trigger function, drops/recreates the
--            trigger with the updated OF clause, runs the backfill, and
--            verifies the result.
--
-- ===========================================================================


-- ===========================================================================
-- ═══ RUN 1 ═══════════════════════════════════════════════════════════════
-- Extend the enum.  Must be committed before RUN 2 uses 'cancelled'.
-- ===========================================================================

ALTER TYPE public.payment_status ADD VALUE IF NOT EXISTS 'cancelled';

-- After running this block:
--   SELECT unnest(enum_range(NULL::public.payment_status));
-- Expected output (4 rows):
--   unpaid | partial | paid | cancelled


-- ===========================================================================
-- ═══ RUN 2 ═══════════════════════════════════════════════════════════════
-- Replace the trigger function, recreate the trigger, backfill, verify.
-- Run only AFTER RUN 1 has been committed successfully.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. Replace fn_sync_payment_status
--
-- Changes vs the previous version:
--   a. Added a status guard — WHEN NEW.status = 'cancelled' fires first,
--      so cancelled bookings always resolve to 'cancelled' regardless of
--      paid_amount or total_amount.
--   b. The IF condition now also watches NEW.status IS DISTINCT FROM
--      OLD.status, so the recalculation runs when the booking is cancelled
--      (even if paid_amount / total_amount did not change).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_sync_payment_status()
RETURNS TRIGGER AS $$
BEGIN
  -- Recalculate when any of the three governing columns changes.
  IF NEW.paid_amount  IS DISTINCT FROM OLD.paid_amount
  OR NEW.total_amount IS DISTINCT FROM OLD.total_amount
  OR NEW.status       IS DISTINCT FROM OLD.status
  THEN
    NEW.payment_status =
      CASE
        -- Cancelled booking always wins, regardless of paid/total values.
        WHEN NEW.status = 'cancelled'                THEN 'cancelled'::payment_status
        WHEN NEW.paid_amount <= 0                    THEN 'unpaid'::payment_status
        WHEN NEW.paid_amount >= NEW.total_amount     THEN 'paid'::payment_status
        ELSE                                              'partial'::payment_status
      END;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION public.fn_sync_payment_status IS
  'Derives bookings.payment_status from status, paid_amount, and total_amount. '
  'Cancelled bookings always resolve to ''cancelled'' regardless of amounts. '
  'Fires via trg_sync_payment_status BEFORE UPDATE OF paid_amount, total_amount, status.';


-- ---------------------------------------------------------------------------
-- 2. Drop and recreate trg_sync_payment_status
--
-- The OF clause is extended from:
--   OF paid_amount, total_amount
-- to:
--   OF paid_amount, total_amount, status
--
-- This ensures the trigger fires when a booking transitions to 'cancelled'
-- (via cancel_booking or cancel_booking_room), even if paid_amount and
-- total_amount happen not to change in the same UPDATE.
-- ---------------------------------------------------------------------------

DROP TRIGGER IF EXISTS trg_sync_payment_status ON public.bookings;

CREATE TRIGGER trg_sync_payment_status
BEFORE UPDATE OF paid_amount, total_amount, status ON public.bookings
FOR EACH ROW
EXECUTE FUNCTION public.fn_sync_payment_status();


-- ---------------------------------------------------------------------------
-- 3. Backfill existing cancelled bookings
--
-- SET status = status is a no-op write: it touches the status column,
-- which is now in the trigger's OF clause, so fn_sync_payment_status fires
-- on each cancelled row and writes payment_status = 'cancelled'.
--
-- Only cancelled rows are touched; confirmed / checked_in rows are not
-- affected.
-- ---------------------------------------------------------------------------

UPDATE public.bookings
SET    status = status
WHERE  status = 'cancelled';


-- ---------------------------------------------------------------------------
-- 4. Verification
-- ---------------------------------------------------------------------------

-- 4a. Confirm all four enum values are present (expect: unpaid, partial, paid, cancelled)
SELECT enumlabel, enumsortorder
FROM   pg_enum
JOIN   pg_type ON pg_type.oid = pg_enum.enumtypid
WHERE  pg_type.typname = 'payment_status'
ORDER  BY enumsortorder;

-- 4b. Distribution of (booking_status, payment_status) pairs.
-- Expected after backfill:
--   - No rows where status = 'cancelled' AND payment_status = 'unpaid'
--   - All cancelled rows show payment_status = 'cancelled'
SELECT
  status          AS booking_status,
  payment_status,
  COUNT(*)        AS row_count
FROM   public.bookings
GROUP  BY status, payment_status
ORDER  BY status, payment_status;


-- ===========================================================================
-- END OF MIGRATION
-- ===========================================================================

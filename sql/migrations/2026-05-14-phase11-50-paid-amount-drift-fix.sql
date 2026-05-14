-- ===========================================================================
-- Phase 11 #50: Fix paid_amount scalar drift from SUM(payments.amount)
-- File:    sql/migrations/2026-05-14-phase11-50-paid-amount-drift-fix.sql
-- Date:    2026-05-14
--
-- Nature:
--   Trigger function replacement + trigger re-bind + one-time backfill.
--   No schema additions. Two existing objects replaced in-place (function
--   via CREATE OR REPLACE, trigger via DROP/CREATE).
--
-- Background:
--   fn_sync_paid_amount has always fired on INSERT only. The trigger
--   was changed from INSERT OR UPDATE OR DELETE (with re-aggregate body)
--   to INSERT only (with incremental += body) during the multi-room
--   foundation work (2026-05-08). When payment rows were subsequently
--   deleted via the SQL Editor (test-data cleanup runs), paid_amount was
--   never decremented, creating a positive scalar drift:
--     bookings.paid_amount > SUM(payments.amount) for the same booking.
--
--   Preflight audit (2026-05-14) found 23 affected bookings:
--     - All drifts positive (scalar overstated — no reverse-direction drift)
--     - Drift magnitudes: mostly ৳500–৳1,000; outliers BK-1008 (৳6,000),
--       BK-1009 (৳1,999.98 floating-point artifact from disbursement)
--     - Status mix: 16 checked_out, 4 checked_in, 3 confirmed
--     - All confirmed test data; no real-guest impact
--
--   The downstream symptom: invoice "Paid in Full" banner (driven by
--   payment_status, which uses the overstated scalar) contradicted the
--   Payment History rows (driven by the payments table row-sum).
--   Booking list showed "Paid" badges on bookings still partially owed.
--
--   Precedent: the BK-1068 cleanup migration
--   (2026-05-12-cleanup-bk1068-test-pollution.sql) encountered exactly
--   this pattern and documented it explicitly. That migration hardcoded
--   a single-booking reconciliation. This migration generalises the fix
--   to all 23 affected bookings and prevents future recurrence.
--
-- Fix:
--   Part A — fn_sync_paid_amount gains a DELETE branch that re-aggregates
--             paid_amount from the remaining payments rows. Re-aggregate
--             (not differential -= OLD.amount) is used in the DELETE branch
--             because it is correct-by-construction regardless of any
--             pre-existing drift. The INSERT branch is unchanged (Phase 8.5
--             fail-fast incremental design).
--   Part B — One-time backfill UPDATE sets paid_amount = SUM(payments.amount)
--             for all 23 affected bookings. The UPDATE fires
--             trg_sync_payment_status automatically via BEFORE UPDATE OF
--             paid_amount — payment_status is corrected in the same statement.
--
-- Why NOT a simple re-aggregate on INSERT too:
--   Phase 8.5 deliberately uses fail-fast incremental for INSERT to catch
--   disbursements that would make paid_amount go negative (programming error).
--   Re-aggregate on INSERT would silently floor to 0 on such a case,
--   re-introducing the exact data-loss risk Phase 8.5 was designed to prevent.
--   The DELETE branch has no analogous risk — deletion cannot fail-fast on
--   negative because that is the correct outcome of deleting a payment row.
--
-- Trigger cascade:
--   Section 3 backfill UPDATE writes paid_amount, firing
--   trg_sync_payment_status (BEFORE UPDATE OF paid_amount ON bookings).
--   No separate payment_status fix is needed.
--
-- Constraint impact:
--   chk_paid_not_exceed_total (paid <= total + extras - discount).
--   The backfill only decreases paid_amount. A lower paid_amount cannot
--   violate an upper-bound constraint. Zero risk.
--
-- Fresh-DB behaviour:
--   Section 3 WHERE clause matches zero rows on a DB where paid_amount
--   already equals SUM(payments.amount) for all bookings. True no-op.
--
-- Apply mode:
--   Sections 1–3 must be run via the Supabase SQL Editor (service role).
--   CREATE OR REPLACE is idempotent. DROP TRIGGER IF EXISTS is idempotent.
--   Section 3 backfill is safe to re-run (WHERE guard prevents already-
--   reconciled rows from being touched twice).
--   Section 4 queries are read-only — run separately after applying.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- Section 1: Replace fn_sync_paid_amount — add DELETE branch
--
-- Changes vs Phase 8.5 version (2026-05-09-phase8.5-refund-disbursement.sql):
--   a. New IF TG_OP = 'DELETE' branch at top: re-aggregates paid_amount
--      from remaining payments rows and returns OLD.
--   b. INSERT branch body is identical to Phase 8.5 — fail-fast incremental,
--      raises if v_new < 0.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_sync_paid_amount()
RETURNS TRIGGER AS $$
DECLARE
  v_current NUMERIC;
  v_new     NUMERIC;
BEGIN

  -- ── DELETE branch ─────────────────────────────────────────────────────────
  -- Re-aggregate from remaining payments rows. Defensive against pre-existing
  -- scalar drift — the result is always the ground truth regardless of what
  -- paid_amount was before. Does NOT raise on a result of 0 (valid when all
  -- payment rows are gone). The UPDATE fires trg_sync_payment_status via
  -- BEFORE UPDATE OF paid_amount on bookings.
  IF TG_OP = 'DELETE' THEN
    UPDATE public.bookings
    SET    paid_amount = (
             SELECT COALESCE(SUM(amount), 0)
             FROM   public.payments
             WHERE  booking_id = OLD.booking_id
           )
    WHERE  id = OLD.booking_id;
    RETURN OLD;
  END IF;

  -- ── INSERT branch — Phase 8.5 design unchanged ────────────────────────────
  -- Fail-fast incremental. Raises if the result would be negative — prevents
  -- disbursing more than has been received (negative payment INSERT from
  -- disburse_refund RPC would produce v_new < 0 when paid is insufficient).
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
  'Keeps bookings.paid_amount in sync with the payments table. '
  'INSERT branch: fail-fast incremental (Phase 8.5) — raises if result '
  'would be negative (catches bad disbursements). '
  'DELETE branch: re-aggregate from remaining rows (Phase 11 #50) — '
  'defensive against pre-existing drift; does not raise. '
  'Both branches fire trg_sync_payment_status via BEFORE UPDATE OF '
  'paid_amount on bookings. Fired by trg_sync_paid_amount '
  'AFTER INSERT OR DELETE ON payments.';


-- ---------------------------------------------------------------------------
-- Section 2: Re-bind trg_sync_paid_amount with DELETE support
--
-- Change vs Phase 8.5 binding:
--   AFTER INSERT ON public.payments
--   →
--   AFTER INSERT OR DELETE ON public.payments
--
-- The function uses TG_OP to distinguish branches.
-- No UPDATE binding — payment rows are never UPDATEd in the normal flow.
-- ---------------------------------------------------------------------------

DROP TRIGGER IF EXISTS trg_sync_paid_amount ON public.payments;

CREATE TRIGGER trg_sync_paid_amount
AFTER INSERT OR DELETE ON public.payments
FOR EACH ROW
EXECUTE FUNCTION public.fn_sync_paid_amount();


-- ---------------------------------------------------------------------------
-- Section 3: Backfill — reconcile all bookings with drift
--
-- Sets paid_amount = SUM(payments.amount) for every booking where the
-- scalar has drifted from the row sum. The BEFORE UPDATE OF paid_amount
-- trigger fires on each row updated, recomputing payment_status in the
-- same statement — no separate payment_status fix is needed.
--
-- The subquery in SET and the subquery in WHERE are evaluated independently
-- per row; because no payments rows are modified here, they always agree.
--
-- On a fresh DB this WHERE clause matches zero rows — true no-op.
-- ---------------------------------------------------------------------------

UPDATE public.bookings b
SET    paid_amount = (
         SELECT COALESCE(SUM(p.amount), 0)
         FROM   public.payments p
         WHERE  p.booking_id = b.id
       )
WHERE  b.paid_amount != (
         SELECT COALESCE(SUM(p.amount), 0)
         FROM   public.payments p
         WHERE  p.booking_id = b.id
       );

-- ^^^ Fires trg_sync_payment_status automatically on each updated row.
-- payment_status is recomputed without a separate UPDATE.


-- ---------------------------------------------------------------------------
-- Section 4: Verification (run in SQL Editor after applying Sections 1–3)
-- ---------------------------------------------------------------------------

-- Q1: Confirm zero remaining drift — expect 0 rows
SELECT b.booking_ref,
       b.paid_amount                             AS scalar,
       COALESCE(SUM(p.amount), 0)                AS rows_sum,
       b.paid_amount - COALESCE(SUM(p.amount), 0) AS drift
FROM   public.bookings b
LEFT JOIN public.payments p ON p.booking_id = b.id
GROUP BY b.id, b.booking_ref, b.paid_amount
HAVING b.paid_amount != COALESCE(SUM(p.amount), 0)
ORDER BY b.booking_ref;

-- Q2: Spot-check known drift cases — confirm paid_amount reduced correctly
-- and payment_status reflects the new lower value.
--
-- Expected post-fix values (based on preflight drift figures):
--   BK-1006: paid_amount=2000, payment_status appropriate to 2000 vs total
--   BK-1008: paid_amount reduced by ৳6,000
--   BK-1009: paid_amount reduced by ৳1,999.98
--   BK-1026: paid_amount=1500, payment_status=partial (was partial before fix)
SELECT b.booking_ref,
       b.status,
       b.total_amount,
       b.paid_amount,
       b.payment_status,
       COALESCE(SUM(p.amount), 0) AS payments_row_sum
FROM   public.bookings b
LEFT JOIN public.payments p ON p.booking_id = b.id
WHERE  b.booking_ref IN ('BK-1006', 'BK-1008', 'BK-1009', 'BK-1026')
GROUP BY b.id, b.booking_ref, b.status, b.total_amount,
         b.paid_amount, b.payment_status
ORDER BY b.booking_ref;

-- Q3: Verify trigger binding — confirm AFTER INSERT OR DELETE
-- Run in SQL Editor:
--
-- SELECT tgname, pg_get_triggerdef(oid) AS definition
-- FROM   pg_trigger
-- WHERE  tgrelid = 'public.payments'::regclass
--   AND  tgname  = 'trg_sync_paid_amount';
--
-- Expected: definition contains 'INSERT OR DELETE' in the event clause.


-- ===========================================================================
-- END OF MIGRATION
-- ===========================================================================

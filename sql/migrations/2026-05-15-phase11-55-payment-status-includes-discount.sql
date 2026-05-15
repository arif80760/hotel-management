-- ===========================================================================
-- Phase 11 #55: fn_sync_payment_status must subtract additional_discount_amount
-- File:    sql/migrations/2026-05-15-phase11-55-payment-status-includes-discount.sql
-- Date:    2026-05-15
--
-- Nature:
--   Trigger logic change + targeted one-time backfill.  No schema
--   additions.  Two existing objects replaced in-place (function via
--   CREATE OR REPLACE, trigger via DROP/CREATE).
--
-- Background:
--   Phase 11 #20 (2026-05-12) fixed fn_sync_payment_status to account
--   for extra_charge_amount in the PAID threshold:
--     paid >= total + extra_charge_amount
--   That migration explicitly scoped out additional_discount_amount,
--   noting it as Phase 11 #35 for a follow-up migration. This is that
--   migration.
--
--   The bug:
--     The discount modal writes bookings.additional_discount_amount but
--     this column was absent from both (a) the trigger's OF clause, so
--     the trigger was never invoked on those writes, and (b) the PAID
--     branch formula, so even on payment writes the comparison ignored
--     the discount.
--
--   Visible symptom:
--     BK-1021: total=6000, paid=3000, discount=3000 (Gm Reference).
--       Effective owed = 6000 + 0 - 3000 = 3000. Paid = 3000.
--       payment_status = 'partial' — should be 'paid'.
--     Booking list showed partial badge; invoice showed PAID IN FULL.
--     Cross-screen contradiction.
--
-- Why NOT subtracting early_deduction_amount:
--   Phase 11 #48 bakes early deductions into bookings.total_amount via
--   reduced booking_rooms.nights → SUM(nights × rate). total_amount is
--   already the post-deduction amount. Subtracting early_deduction_amount
--   from the threshold would double-deduct. This column is correctly
--   absent from the formula.
--
-- Fix:
--   Part A — fn_sync_payment_status IF guard gains a fifth column:
--             additional_discount_amount IS DISTINCT FROM OLD.additional_discount_amount
--             PAID branch changes:
--               was:  paid >= total + COALESCE(extra_charge_amount, 0)
--               now:  paid >= total + COALESCE(extra_charge_amount, 0)
--                                   - COALESCE(additional_discount_amount, 0)
--   Part B — trg_sync_payment_status OF clause gains additional_discount_amount.
--             This ensures the trigger fires when the discount modal
--             writes additional_discount_amount (previously it did not).
--   Part C — One-time direct backfill. Sets payment_status to the correct
--             value for all bookings where additional_discount_amount > 0
--             and the stored payment_status no longer matches the new formula.
--
-- Why direct backfill (not no-op UPDATE):
--   Day 9 lesson from Phase 11 #20: writing SET col = col satisfies the
--   trigger OF clause (trigger fires) but fails the IS DISTINCT FROM
--   inner guard (CASE does not execute). payment_status is left unchanged.
--   The backfill must write payment_status directly, bypassing trigger
--   CASE logic entirely for the historical rows.
--
-- Known affected bookings (preflight 2026-05-15):
--   BK-1021: total=6000, paid=3000, discount=3000 → should be 'paid'
--   BK-1062: (additional bookings identified by Arif's preflight audit)
--   Full list from preflight query — run before applying Section 3.
--
-- Trigger cascade:
--   Section 3 writes payment_status directly. trg_sync_payment_status
--   does NOT fire on a payment_status write (only OF paid_amount,
--   total_amount, status, extra_charge_amount, additional_discount_amount).
--   No loop risk. No additional cascade.
--
-- Fresh-DB behaviour:
--   Section 3 WHERE clause matches zero rows on a DB where no bookings
--   have additional_discount_amount > 0 with a mismatched status. True no-op.
--
-- Apply mode:
--   SQL Editor (service role). Sections 1–3 can run as one block.
--   Section 4 queries are read-only — run separately after applying.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- Section 1: Replace fn_sync_payment_status — subtract additional_discount_amount
--
-- Changes vs Phase 11 #20 version (2026-05-12):
--   a. IF guard gains fifth column:
--        OR NEW.additional_discount_amount IS DISTINCT FROM OLD.additional_discount_amount
--   b. PAID branch formula:
--        was:  paid_amount >= total_amount + COALESCE(extra_charge_amount, 0)
--        now:  paid_amount >= total_amount + COALESCE(extra_charge_amount, 0)
--                                          - COALESCE(additional_discount_amount, 0)
--   c. All other branches (cancelled, unpaid, partial) unchanged.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_sync_payment_status()
RETURNS TRIGGER AS $$
BEGIN
  -- Recalculate when any of the five governing columns changes.
  IF NEW.paid_amount                IS DISTINCT FROM OLD.paid_amount
  OR NEW.total_amount               IS DISTINCT FROM OLD.total_amount
  OR NEW.status                     IS DISTINCT FROM OLD.status
  OR NEW.extra_charge_amount        IS DISTINCT FROM OLD.extra_charge_amount
  OR NEW.additional_discount_amount IS DISTINCT FROM OLD.additional_discount_amount
  THEN
    NEW.payment_status =
      CASE
        -- Cancelled booking always wins, regardless of amounts.
        WHEN NEW.status = 'cancelled'
          THEN 'cancelled'::payment_status
        WHEN NEW.paid_amount <= 0
          THEN 'unpaid'::payment_status
        -- 'paid' when guest has covered rooms + extras, net of any discount.
        WHEN NEW.paid_amount >= NEW.total_amount
                                + COALESCE(NEW.extra_charge_amount, 0)
                                - COALESCE(NEW.additional_discount_amount, 0)
          THEN 'paid'::payment_status
        ELSE
          'partial'::payment_status
      END;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION public.fn_sync_payment_status IS
  'Derives bookings.payment_status from status, paid_amount, total_amount, '
  'extra_charge_amount, and additional_discount_amount. '
  'Cancelled bookings always resolve to ''cancelled''. '
  'A booking is ''paid'' only when: '
  '  paid_amount >= total_amount + extra_charge_amount - additional_discount_amount. '
  'early_deduction_amount is intentionally absent — it is already baked '
  'into total_amount via reduced booking_rooms.nights (Phase 11 #48). '
  'Phase 11 #20 (2026-05-12): added extra_charge_amount to comparison. '
  'Phase 11 #55 (2026-05-15): added additional_discount_amount subtraction. '
  'Fires via trg_sync_payment_status BEFORE UPDATE OF '
  'paid_amount, total_amount, status, extra_charge_amount, additional_discount_amount.';


-- ---------------------------------------------------------------------------
-- Section 2: Re-bind trg_sync_payment_status with 5-column OF clause
--
-- Change vs Phase 11 #20 binding:
--   OF clause extended from:
--     paid_amount, total_amount, status, extra_charge_amount
--   to:
--     paid_amount, total_amount, status, extra_charge_amount,
--     additional_discount_amount
--
-- This ensures the trigger fires when the discount modal writes
-- additional_discount_amount directly (previously it did not fire).
-- ---------------------------------------------------------------------------

DROP TRIGGER IF EXISTS trg_sync_payment_status ON public.bookings;

CREATE TRIGGER trg_sync_payment_status
BEFORE UPDATE OF paid_amount, total_amount, status, extra_charge_amount,
                 additional_discount_amount
ON public.bookings
FOR EACH ROW
EXECUTE FUNCTION public.fn_sync_payment_status();


-- ---------------------------------------------------------------------------
-- Section 3: Backfill — correct payment_status for all affected bookings
--
-- Direct write to payment_status. Does NOT use the no-op UPDATE pattern.
-- Rationale: a self-assignment (SET col = col) satisfies the OF clause
-- but fails the IS DISTINCT FROM guard inside the function — CASE never
-- executes. Learned empirically during Phase 11 #20 (Day 9).
--
-- The CASE expression here mirrors the updated function exactly.
-- WHERE guard: only rows with additional_discount_amount > 0 AND a
-- payment_status that disagrees with the new formula.
--
-- On a fresh DB this WHERE clause matches zero rows — true no-op.
-- Safe to re-run (WHERE guard prevents re-touching correct rows).
-- ---------------------------------------------------------------------------

UPDATE public.bookings
SET    payment_status =
         CASE
           WHEN status = 'cancelled'
             THEN 'cancelled'::payment_status
           WHEN paid_amount <= 0
             THEN 'unpaid'::payment_status
           WHEN paid_amount >= total_amount
                                + COALESCE(extra_charge_amount, 0)
                                - COALESCE(additional_discount_amount, 0)
             THEN 'paid'::payment_status
           ELSE
             'partial'::payment_status
         END
WHERE  additional_discount_amount > 0
  AND  payment_status != CASE
         WHEN status = 'cancelled'
           THEN 'cancelled'::payment_status
         WHEN paid_amount <= 0
           THEN 'unpaid'::payment_status
         WHEN paid_amount >= total_amount
                              + COALESCE(extra_charge_amount, 0)
                              - COALESCE(additional_discount_amount, 0)
           THEN 'paid'::payment_status
         ELSE
           'partial'::payment_status
       END;


-- ---------------------------------------------------------------------------
-- Section 4: Verification (run in SQL Editor after applying Sections 1–3)
-- ---------------------------------------------------------------------------

-- V1: Confirm no remaining mismatches — expect 0 rows
--
-- SELECT booking_ref, total_amount, paid_amount, extra_charge_amount,
--        additional_discount_amount, payment_status,
--        CASE
--          WHEN paid_amount >= total_amount
--               + COALESCE(extra_charge_amount, 0)
--               - COALESCE(additional_discount_amount, 0)
--          THEN 'paid'
--          WHEN paid_amount > 0 THEN 'partial'
--          ELSE 'unpaid'
--        END AS should_be
-- FROM public.bookings
-- WHERE additional_discount_amount > 0
--   AND payment_status != CASE
--       WHEN paid_amount >= total_amount
--            + COALESCE(extra_charge_amount, 0)
--            - COALESCE(additional_discount_amount, 0)
--       THEN 'paid'
--       WHEN paid_amount > 0 THEN 'partial'
--       ELSE 'unpaid'
--   END;
--
-- Expected: 0 rows

-- V2: Spot-check BK-1021
--
-- SELECT booking_ref, total_amount, paid_amount,
--        extra_charge_amount, additional_discount_amount, payment_status
-- FROM   public.bookings
-- WHERE  booking_ref = 'BK-1021';
--
-- Expected:
--   payment_status = 'paid'
--   (paid=3000 >= total=6000 + extra=0 - discount=3000 = 3000 ✓)

-- V3: Confirm trigger OF clause now includes additional_discount_amount
--
-- SELECT tgname, pg_get_triggerdef(oid) AS definition
-- FROM   pg_trigger
-- WHERE  tgrelid = 'public.bookings'::regclass
--   AND  tgname  = 'trg_sync_payment_status';
--
-- Expected: definition includes 'additional_discount_amount' in column list.

-- V4: Confirm function comment updated
--
-- SELECT obj_description(oid, 'pg_proc') AS comment
-- FROM   pg_proc
-- WHERE  proname = 'fn_sync_payment_status';
--
-- Expected: comment mentions Phase 11 #55 and additional_discount_amount.


-- ===========================================================================
-- END OF MIGRATION
-- ===========================================================================

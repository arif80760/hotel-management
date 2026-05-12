-- ===========================================================================
-- Phase 11 #20: fn_sync_payment_status must account for extra_charge_amount
-- File:    sql/migrations/2026-05-12-phase11-20-payment-status-includes-extras.sql
-- Date:    2026-05-12
--
-- Nature:
--   Trigger logic change + targeted one-time backfill.  No schema
--   additions.  Two existing objects are replaced in-place (function
--   via CREATE OR REPLACE, trigger via DROP/CREATE).
--
-- Background:
--   Day 9 Batch 3 investigation found 6 production bookings showing
--   payment_status = 'paid' while actually still owing ৳500–1,000
--   in extra charges (damage, laundry, extra bed, etc.):
--
--     BK-1012  paid=10500  total=10500  extra=1000   owe: ৳1000
--     BK-1013  paid=12000  total=12000  extra=500    owe: ৳500
--     BK-1015  paid=4500   total=4500   extra=500    owe: ৳500
--     BK-1017  paid=9000   total=9000   extra=499.99 owe: ৳499.99
--     BK-1023  paid=2400   total=2400   extra=500    owe: ৳500
--     BK-1043  paid=10000  total=10000  extra=500    owe: ৳500
--
--   The booking list showed "Paid" for all 6.  The invoice (which calls
--   calcTrueDue, adding extra_charge_amount on top of total_amount) would
--   have shown "Outstanding Balance."  Cross-screen contradiction.
--
--   Root cause: checkoutNormal and checkoutWithOverride write
--   bookings.extra_charge_amount (Step 2) via a plain UPDATE.
--   At the time of writing, extra_charge_amount was NOT in the
--   OF clause of trg_sync_payment_status.  The trigger never fired
--   on that write, so payment_status was not recomputed.
--
-- Why Path 2 (extend trigger) over Path 1 (call update_booking_total):
--   The entire codebase treats total_amount as rooms-only and adds
--   extra_charge_amount on top.  calcTrueDue (lib/invoiceUtils.ts)
--   computes: total_amount + extra_charge_amount − deductions − paid.
--   The invoice grossBill also adds booking_extra_charges table rows
--   on top of total_amount.  Calling update_booking_total would bake
--   extras into total_amount, causing every downstream consumer to
--   double-count them (extras would appear in both total_amount and
--   the separate extra_charge_amount add-on).  Path 2 leaves the
--   existing data architecture intact and fixes only the trigger logic.
--
-- Scope limitation — Phase 11 #35 and #36:
--   additional_discount_amount and early_deduction_amount have a
--   symmetric relationship to payment_status: they also affect
--   the true amount owed but are not in the trigger's OF clause or
--   CASE condition.  Those are captured as Phase 11 backlog items
--   #35 and #36.  This migration intentionally does NOT extend the
--   trigger to cover them; scope-creeping trigger logic in a single
--   migration is dangerous.  Each item gets its own migration with
--   its own preflight and verification.
--
-- Trigger cascade explanation:
--   fn_sync_payment_status is a BEFORE UPDATE trigger.  It sets
--   NEW.payment_status directly and returns NEW — no second UPDATE
--   is issued.  No loop risk.  The change takes effect atomically
--   within the same statement that triggered it.
--
-- Future writes:
--   Any future call to checkoutNormal or checkoutWithOverride that
--   writes extra_charge_amount will now fire this trigger and
--   recompute payment_status correctly.  No app-layer changes needed.
--
-- Fresh-DB behaviour:
--   CREATE OR REPLACE on the function is idempotent.
--   DROP TRIGGER IF EXISTS + CREATE TRIGGER is idempotent.
--   The backfill UPDATE matches zero rows on a fresh DB because no
--   bookings exist with (extra_charge_amount > 0 AND
--   payment_status = 'paid' AND paid_amount < total_amount +
--   extra_charge_amount).
--
-- Execution mode:
--   Single block — no enum ADD VALUE, no multi-run requirement.
--   Must be run via service role.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- Section 1: Replace fn_sync_payment_status
--
-- Changes vs the previous version (2026-05-10-phase11-payment-status-cancelled.sql):
--   a. IF guard extended: now also fires when extra_charge_amount changes
--      (OR NEW.extra_charge_amount IS DISTINCT FROM OLD.extra_charge_amount).
--   b. PAID branch changed: was (paid_amount >= total_amount),
--      now (paid_amount >= total_amount + COALESCE(extra_charge_amount, 0)).
--      A booking is only 'paid' when the guest has covered both the room
--      charges and any extra charges applied at checkout.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_sync_payment_status()
RETURNS TRIGGER AS $$
BEGIN
  -- Recalculate when any of the four governing columns changes.
  IF NEW.paid_amount          IS DISTINCT FROM OLD.paid_amount
  OR NEW.total_amount         IS DISTINCT FROM OLD.total_amount
  OR NEW.status               IS DISTINCT FROM OLD.status
  OR NEW.extra_charge_amount  IS DISTINCT FROM OLD.extra_charge_amount
  THEN
    NEW.payment_status =
      CASE
        -- Cancelled booking always wins, regardless of amounts.
        WHEN NEW.status = 'cancelled'
          THEN 'cancelled'::payment_status
        WHEN NEW.paid_amount <= 0
          THEN 'unpaid'::payment_status
        -- 'paid' only when the guest has covered rooms + extra charges.
        WHEN NEW.paid_amount >= NEW.total_amount + COALESCE(NEW.extra_charge_amount, 0)
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
  'and extra_charge_amount. Cancelled bookings always resolve to ''cancelled''. '
  'A booking is ''paid'' only when paid_amount >= total_amount + extra_charge_amount. '
  'Phase 11 #20 (2026-05-12): added extra_charge_amount to the PAID comparison. '
  'Note: additional_discount_amount and early_deduction_amount are not yet factored '
  'in (Phase 11 #35 and #36). '
  'Fires via trg_sync_payment_status BEFORE UPDATE OF '
  'paid_amount, total_amount, status, extra_charge_amount.';


-- ---------------------------------------------------------------------------
-- Section 2: Recreate trg_sync_payment_status with extended OF clause
--
-- Change vs previous version:
--   OF clause extended from:
--     paid_amount, total_amount, status
--   to:
--     paid_amount, total_amount, status, extra_charge_amount
--
-- This ensures the trigger fires when checkoutNormal or
-- checkoutWithOverride writes extra_charge_amount to the bookings
-- table (Step 2 of the checkout flow), so payment_status is
-- recomputed in the same statement.
-- ---------------------------------------------------------------------------

DROP TRIGGER IF EXISTS trg_sync_payment_status ON public.bookings;

CREATE TRIGGER trg_sync_payment_status
BEFORE UPDATE OF paid_amount, total_amount, status, extra_charge_amount
ON public.bookings
FOR EACH ROW
EXECUTE FUNCTION public.fn_sync_payment_status();


-- ---------------------------------------------------------------------------
-- Section 3: Backfill — fix the 6 affected bookings via direct write
--
-- IMPORTANT — DAY 9 LESSON:
--   The original design for this section was a no-op write to
--   extra_charge_amount, intended to fire the trigger's recomputation
--   logic. EMPIRICAL FINDING (Day 9, during this migration's apply
--   step): that pattern does NOT cause fn_sync_payment_status's CASE
--   to execute. The function body's IF guard uses IS DISTINCT FROM
--   for all four watched columns; a self-assignment satisfies the OF
--   clause (trigger function is invoked) but fails the inner guard
--   (CASE is not executed). payment_status is left unchanged.
--
--   This same pattern was used in 2026-05-10-phase11-payment-status-
--   cancelled.sql's backfill. The Day 6 migration appeared to work
--   but the mechanism remains unclear — possibly via an untracked
--   platform trigger, possibly via a separate manual fix that ran
--   contemporaneously. See Phase 11 backlog items #37, #38, #39
--   for the open questions.
--
--   For #20, we use a direct payment_status write. The trigger logic
--   in Sections 1 and 2 is correct and will fire correctly for any
--   FUTURE checkout that writes a non-no-op extra_charge_amount value
--   (e.g., from NULL or 0 to a positive amount). This Section 3 only
--   addresses the 6 historical bookings already in the broken state.
--
-- WHERE clause matches exactly the 6 bookings confirmed at preflight
-- (2026-05-12): BK-1012, BK-1013, BK-1015, BK-1017, BK-1023, BK-1043.
--
-- On a fresh DB this matches zero rows (no bookings with payment_status
-- = 'paid' and an unpaid extra charge) — safe no-op.
-- ---------------------------------------------------------------------------

UPDATE public.bookings
SET    payment_status = 'partial'::payment_status
WHERE  extra_charge_amount > 0
  AND  payment_status = 'paid'
  AND  paid_amount < total_amount + extra_charge_amount;


-- ---------------------------------------------------------------------------
-- Section 4: Verification
-- ---------------------------------------------------------------------------

-- 4a. Trigger OF clause
--
-- pg_trigger is not reachable via PostgREST.  To verify the OF clause
-- was updated, run the following directly in the Supabase SQL Editor:
--
--   SELECT tgname, pg_get_triggerdef(oid) AS definition
--   FROM   pg_trigger
--   WHERE  tgrelid = 'public.bookings'::regclass
--     AND  tgname  = 'trg_sync_payment_status';
--
-- Expected: definition includes 'extra_charge_amount' in the column list.

-- 4b. Re-run the pre-step query — expect 0 rows
--     (all 6 bookings should now have payment_status = 'partial')
SELECT
  booking_ref,
  total_amount,
  extra_charge_amount,
  paid_amount,
  payment_status,
  (paid_amount < total_amount + extra_charge_amount) AS bug_present
FROM   public.bookings
WHERE  extra_charge_amount > 0
  AND  payment_status = 'paid'
  AND  paid_amount < total_amount + extra_charge_amount
ORDER  BY booking_ref;

-- Expected: 0 rows (bug fully resolved for all affected bookings)

-- 4c. Spot-check BK-1012
SELECT
  booking_ref,
  total_amount,
  extra_charge_amount,
  paid_amount,
  payment_status,
  total_amount + extra_charge_amount AS canonical_total_due
FROM   public.bookings
WHERE  booking_ref = 'BK-1012';

-- Expected:
--   booking_ref | total_amount | extra_charge_amount | paid_amount | payment_status | canonical_total_due
--   BK-1012     | 10500.00     | 1000                | 10500.00    | partial        | 11500.00

-- 4d. Confirm all 6 are now 'partial' (positive check, not just absence of bug)
SELECT
  booking_ref,
  payment_status,
  paid_amount,
  total_amount,
  extra_charge_amount,
  total_amount + extra_charge_amount - paid_amount AS still_owed
FROM   public.bookings
WHERE  booking_ref IN ('BK-1012','BK-1013','BK-1015','BK-1017','BK-1023','BK-1043')
ORDER  BY booking_ref;

-- Expected: all 6 rows show payment_status = 'partial',
-- still_owed matches their extra_charge_amount exactly.


-- ===========================================================================
-- END OF MIGRATION
-- ===========================================================================

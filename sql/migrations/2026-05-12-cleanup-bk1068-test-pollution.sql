-- ===========================================================================
-- Cleanup: BK-1068 Phase 11 smoke-test pollution
-- File:    sql/migrations/2026-05-12-cleanup-bk1068-test-pollution.sql
-- Date:    2026-05-12
--
-- Nature:
--   One-time data cleanup.  This is NOT a schema change.  No tables,
--   functions, triggers, or policies are altered.
--
-- Background:
--   During Phase 11 smoke testing on Day 6 (2026-05-10), three ৳1 refund
--   rows and two corresponding ৳1 payment rows were created against
--   booking BK-1068 (id: 32bf3cc9-be4f-4926-b8a6-95e94de31a14) to
--   exercise the disburse-refund, deny-refund, and auto-refresh flows.
--   These rows are identifiable by their trivially small amount (৳1) and
--   explicit smoke-test labels in the notes column.  They left BK-1068
--   in a corrupted state:
--
--     paid_amount    = 11998  (should be 12000)
--     payment_status = 'partial'  (should be 'paid')
--
-- What is deleted:
--
--   Refunds (3 rows):
--     cb1937ca-43ab-494a-bf3e-dcb7b39de81d  ৳1  disbursed  notes="Okay"
--     3e4f6042-d107-484e-857c-8b3c0b54af11  ৳1  denied     notes="SMOKE TEST: Phase 11 item 2 — deny with empty reason"
--     767dc589-fceb-4d55-8860-0f121ad91a86  ৳1  disbursed  notes="AUTO-REFRESH TEST: Phase 11 item 5"
--
--   Payments (2 rows):
--     5433d918-b0d7-4161-9b87-124a1fdc5f84  -৳1  "Refund disbursement: ref cb1937ca-..."
--     cdcb4402-8850-4818-b48f-68291fa4be14  -৳1  "Refund disbursement: ref 767dc589-..."
--
-- What is preserved:
--   The one legitimate refund on BK-1068 (7b789bfa, ৳4000,
--   "Cancellation refund — Room 101") and its backing payment
--   (be00b98c, -৳4000) are NOT touched.
--
-- Trigger behaviour — IMPORTANT:
--   trg_sync_paid_amount is AFTER INSERT ON payments only
--   (see sql/schema/05-triggers.sql lines 101-103).  Deleting
--   payment rows does NOT auto-recalc paid_amount; the trigger
--   body references NEW.amount, which does not exist on DELETE.
--   A manual reconciliation UPDATE (Section 3 below) is therefore
--   required to restore paid_amount to the correct value.
--
--   fn_sync_payment_status fires on BEFORE UPDATE OF paid_amount
--   on bookings, so the reconciliation UPDATE in Section 3 is
--   sufficient to cascade both paid_amount and payment_status
--   into their correct final state.
--
-- Day 9 lesson:
--   On the actual Day 9 (2026-05-12) apply, production passed
--   through an intermediate broken state between the payment
--   DELETEs (Sections 1-2) and the reconciliation UPDATE
--   (Section 3): paid_amount=11998, payment_status='partial'.
--   Future runs on a fresh DB are a no-op throughout — the
--   UUIDs in Sections 1-2 do not exist, and Section 3 sets
--   paid_amount to the value it already has — so no intermediate
--   broken state arises.
--
-- Fresh-DB behaviour:
--   On a database that never ran the Phase 11 smoke tests these
--   UUIDs do not exist; the DELETE statements match zero rows.
--   The reconciliation UPDATE sets paid_amount to 12000, which
--   is already the correct value on a clean DB, making it a
--   true no-op in effect.
--
-- Execution mode:
--   Single block — no DDL, no multi-run requirement.  Must be
--   run via service role (no DELETE RLS policy exists on
--   refunds by design; authenticated client silently deletes
--   zero rows).
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. Remove test-pollution refund rows
-- ---------------------------------------------------------------------------

DELETE FROM public.refunds
WHERE id IN (
  'cb1937ca-43ab-494a-bf3e-dcb7b39de81d',   -- ৳1 disbursed, notes="Okay"
  '3e4f6042-d107-484e-857c-8b3c0b54af11',   -- ৳1 denied,    SMOKE TEST label
  '767dc589-fceb-4d55-8860-0f121ad91a86'    -- ৳1 disbursed, AUTO-REFRESH TEST label
);


-- ---------------------------------------------------------------------------
-- 2. Remove test-pollution payment rows
-- ---------------------------------------------------------------------------

DELETE FROM public.payments
WHERE id IN (
  '5433d918-b0d7-4161-9b87-124a1fdc5f84',   -- -৳1, linked to cb1937ca refund
  'cdcb4402-8850-4818-b48f-68291fa4be14'    -- -৳1, linked to 767dc589 refund
);


-- ---------------------------------------------------------------------------
-- 3. Reconcile paid_amount
--
-- trg_sync_paid_amount fires on INSERT only — deleting the two -৳1
-- payment rows above does not decrement paid_amount automatically.
-- This UPDATE sets paid_amount to the correct value (sum of remaining
-- payments: +16000 - 4000 = 12000), which fires fn_sync_payment_status
-- via BEFORE UPDATE OF paid_amount and transitions payment_status from
-- 'partial' → 'paid'.
--
-- On a fresh DB: paid_amount is already 12000 (no smoke-test rows
-- ever existed), so this UPDATE writes the same value and resolves
-- as a no-op in effect.
-- ---------------------------------------------------------------------------

UPDATE public.bookings
SET    paid_amount = 12000
WHERE  id = '32bf3cc9-be4f-4926-b8a6-95e94de31a14';


-- ---------------------------------------------------------------------------
-- 4. Verification
-- ---------------------------------------------------------------------------

-- 4a. BK-1068 booking row — expect paid_amount=12000, payment_status='paid'
SELECT
  booking_ref,
  total_amount,
  paid_amount,
  payment_status,
  status
FROM   public.bookings
WHERE  id = '32bf3cc9-be4f-4926-b8a6-95e94de31a14';

-- Expected:
--   booking_ref | total_amount | paid_amount | payment_status | status
--   BK-1068     | 12000        | 12000       | paid           | confirmed

-- 4b. Payment count — expect exactly 2 rows, net ৳12000
SELECT
  COUNT(*)    AS payment_count,
  SUM(amount) AS net_amount
FROM   public.payments
WHERE  booking_id = '32bf3cc9-be4f-4926-b8a6-95e94de31a14';

-- Expected:
--   payment_count | net_amount
--   2             | 12000

-- 4c. Refund rows — expect exactly 1 row
SELECT
  id,
  amount,
  status,
  notes
FROM   public.refunds
WHERE  booking_id = '32bf3cc9-be4f-4926-b8a6-95e94de31a14';

-- Expected:
--   id (7b789bfa-...)  | amount=4000 | status=disbursed | notes="Cancellation refund — Room 101"


-- ===========================================================================
-- END OF MIGRATION
-- ===========================================================================

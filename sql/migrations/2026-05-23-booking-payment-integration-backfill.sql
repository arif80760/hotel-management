-- sql/migrations/2026-05-23-booking-payment-integration-backfill.sql
-- Booking-payment integration — Stage 1 of 2: backfill historical payments.
--
-- ─── STATUS ───────────────────────────────────────────────────
-- APPLIED TO PRODUCTION: 2026-05-23
-- Verified post-application via:
--   Q1: 104 rows backfilled (105 payments − 1 pending pre-adjustment)
--   Q2: revenue_in 95 / ৳462,500.02 + expense_out 9 / ৳49,500.00
--   Q3: All four bucket balances reflect real historical cash flow
--   Q4: Pending pre-adjustment (c0f2cac8) correctly excluded
--
-- Re-running on production is safe — the NOT EXISTS clause makes
-- the backfill idempotent. Fresh-environment setup should apply
-- this file in order with the trigger migration that follows.
-- ──────────────────────────────────────────────────────────────
--
-- Walks every row in public.payments and inserts the matching row into
-- public.account_transactions, mapping payments.method → bucket UUID and
-- payments.amount sign → revenue_in / expense_out.
--
-- EXCLUSION: skips pending pre-adjustment rows (refund_id IS NOT NULL AND
-- method = 'other'). These represent money that has not physically left a
-- bucket yet (the refund is still pending). When their refund is later
-- disbursed, the trigger's UPDATE branch will fire and create the daybook
-- row at that time.
--
-- IDEMPOTENT: skips any payment whose id is already referenced by an
-- account_transactions.booking_payment_id. Re-running is safe.
--
-- Run order:
--   1. THIS FILE (backfill)              — populates historical rows
--   2. ...-trigger.sql (next migration)  — installs the auto-sync trigger
--
-- Bucket mapping (from architecture doc §3.1):
--   cash          -> Cash in Hand (a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11, is_spendable)
--   bkash         -> bKash        (c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33)
--   nagad         -> Nagad        (d0eebc99-9c0b-4ef8-bb6d-6bb9bd380a44)
--   bank_transfer -> Bank         (b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22)
--   card          -> Bank
--   online        -> Bank   (legacy enum value)
--   other         -> Bank   (best-effort for post-disbursement 'other' rows;
--                            pending pre-adjustments are excluded above)
-- =============================================================

INSERT INTO public.account_transactions (
  txn_date,
  type,
  amount,
  from_account_id,
  to_account_id,
  booking_payment_id,
  note,
  created_by,
  created_at
)
SELECT
  p.created_at::date                              AS txn_date,
  CASE WHEN p.amount > 0
       THEN 'revenue_in'::public.account_transaction_type
       ELSE 'expense_out'::public.account_transaction_type
  END                                             AS type,
  ABS(p.amount)                                   AS amount,
  CASE WHEN p.amount < 0 THEN
    CASE p.method
      WHEN 'cash'          THEN 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'::uuid
      WHEN 'bkash'         THEN 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33'::uuid
      WHEN 'nagad'         THEN 'd0eebc99-9c0b-4ef8-bb6d-6bb9bd380a44'::uuid
      WHEN 'bank_transfer' THEN 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22'::uuid
      WHEN 'card'          THEN 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22'::uuid
      WHEN 'online'        THEN 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22'::uuid
      WHEN 'other'         THEN 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22'::uuid
    END
  ELSE NULL END                                   AS from_account_id,
  CASE WHEN p.amount > 0 THEN
    CASE p.method
      WHEN 'cash'          THEN 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'::uuid
      WHEN 'bkash'         THEN 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33'::uuid
      WHEN 'nagad'         THEN 'd0eebc99-9c0b-4ef8-bb6d-6bb9bd380a44'::uuid
      WHEN 'bank_transfer' THEN 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22'::uuid
      WHEN 'card'          THEN 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22'::uuid
      WHEN 'online'        THEN 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22'::uuid
      WHEN 'other'         THEN 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22'::uuid
    END
  ELSE NULL END                                   AS to_account_id,
  p.id                                            AS booking_payment_id,
  p.notes                                         AS note,
  p.recorded_by                                   AS created_by,
  p.created_at                                    AS created_at
FROM public.payments p
WHERE
  -- Exclude pending pre-adjustments — money hasn't physically moved yet.
  -- The trigger's UPDATE branch will create the daybook row when the
  -- refund is eventually disbursed.
  NOT (p.refund_id IS NOT NULL AND p.method = 'other')
  -- Idempotency: skip rows already backfilled.
  AND NOT EXISTS (
    SELECT 1 FROM public.account_transactions a
    WHERE a.booking_payment_id = p.id
  );

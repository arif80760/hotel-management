-- sql/migrations/2026-05-24-account-transactions-soft-delete.sql
-- Soft delete for account_transactions — add deleted_at column,
-- update account_balances view to filter soft-deleted rows.
--
-- ─── STATUS ───────────────────────────────────────────────────
-- APPLIED 2026-05-24 (Day 19) — column, partial index, and view
-- replacement all live in production. Verified 2026-05-29 (Day 20)
-- post-Eid: 0 rows soft-deleted, view body confirmed to include
-- the deleted_at IS NULL filter, balances unchanged from pre-apply.
-- ──────────────────────────────────────────────────────────────
--
-- What changes:
--   1. ALTER TABLE account_transactions ADD COLUMN deleted_at TIMESTAMPTZ
--      (nullable, no default). NULL = live row. Non-null = soft-deleted
--      at that timestamp.
--   2. Partial index on (id) WHERE deleted_at IS NULL — speeds up the
--      common case ("show me the live rows").
--   3. CREATE OR REPLACE VIEW account_balances — same shape as the
--      original (Stage 2 view, 2026-05-19), with the LEFT JOIN
--      additionally filtered to deleted_at IS NULL. Soft-deleted rows
--      no longer contribute to bucket balances.
--
-- Design decisions (from Day 19 shift discussion):
--   - Soft delete applies only to MANUAL rows (transfer/injection).
--     Booking-payment-derived rows refuse mutation per existing guard.
--     This file does not enforce that scope — it's still enforced in
--     the service layer (deleteTransaction's existing booking_payment_id
--     guard).
--   - Immutability trigger (trg_check_account_transactions_immutability)
--     applies to soft delete because soft delete is an UPDATE. Closed-day
--     rows are uneditable AND undeletable. UI disables the trash icon
--     on rows from closed days.
--   - Soft-deleted rows are hidden from ALL reads by default. No "show
--     deleted" toggle in this iteration. Restorability is a manual SQL
--     operation if ever needed.
--
-- Re-running on production is safe:
--   - ALTER TABLE ADD COLUMN is idempotent only if we use IF NOT EXISTS.
--   - CREATE INDEX IF NOT EXISTS handles the index.
--   - CREATE OR REPLACE VIEW handles the view.
--
-- Backfill: no rows have a "should be deleted" state at apply time, so
-- deleted_at defaults to NULL on every existing row. Nothing to migrate.
-- =============================================================


-- ── 1. Add deleted_at column ──────────────────────────────────

ALTER TABLE public.account_transactions
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

COMMENT ON COLUMN public.account_transactions.deleted_at IS
  'Soft delete marker. NULL = live row, visible everywhere. Non-null = timestamp the row was soft-deleted, hidden from reads. Restore by setting back to NULL.';


-- ── 2. Partial index for live-row queries ────────────────────

CREATE INDEX IF NOT EXISTS idx_acct_txn_not_deleted
  ON public.account_transactions (id)
  WHERE deleted_at IS NULL;


-- ── 3. Replace account_balances view ─────────────────────────
--
-- Identical to the 2026-05-19 view except for the WHERE clause on the
-- LEFT JOIN: soft-deleted rows don't contribute to balances.

CREATE OR REPLACE VIEW account_balances
WITH (security_invoker = true) AS
SELECT
  a.id            AS account_id,
  a.name          AS name,
  a.is_spendable  AS is_spendable,
  COALESCE(
    SUM(t.amount) FILTER (WHERE t.to_account_id = a.id), 0
  )
  - COALESCE(
    SUM(t.amount) FILTER (WHERE t.from_account_id = a.id), 0
  )                AS balance
FROM accounts a
LEFT JOIN account_transactions t
  ON (t.to_account_id = a.id OR t.from_account_id = a.id)
  AND t.deleted_at IS NULL
GROUP BY a.id, a.name, a.is_spendable;


-- =============================================================
-- Verification queries — run AFTER applying:
--
--   -- Q1: column exists
--   SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--   WHERE table_schema = 'public'
--     AND table_name = 'account_transactions'
--     AND column_name = 'deleted_at';
--
--   -- Q2: index exists
--   SELECT indexname FROM pg_indexes
--   WHERE tablename = 'account_transactions'
--     AND indexname = 'idx_acct_txn_not_deleted';
--
--   -- Q3: view body has the deleted_at filter
--   SELECT pg_get_viewdef('public.account_balances'::regclass, true);
--
--   -- Q4: row count unchanged, no rows soft-deleted yet
--   SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE deleted_at IS NOT NULL) AS deleted
--   FROM public.account_transactions;
--
--   -- Q5: balances unchanged (same as before migration — no rows soft-deleted yet)
--   SELECT name, balance FROM account_balances ORDER BY name;
-- =============================================================

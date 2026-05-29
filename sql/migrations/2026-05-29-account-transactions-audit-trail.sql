-- sql/migrations/2026-05-29-account-transactions-audit-trail.sql
-- Audit trail columns on account_transactions — edited_at, edited_by, deleted_by.
--
-- ─── STATUS ───────────────────────────────────────────────────
-- APPLIED 2026-05-29 (Day 20) — edited_at, edited_by, deleted_by
-- columns added to public.account_transactions. Verified: all three
-- columns exist nullable; no rows backfilled (107 rows, 0 audit values).
-- Service layer (services/accountsService.ts) updated to populate
-- these columns from supabase.auth.getUser() on edit and delete.
-- UI indicator (clock icon + tooltip) added to edited rows in the
-- cashbook table.
-- ──────────────────────────────────────────────────────────────
--
-- What changes:
--   1. ALTER TABLE account_transactions ADD COLUMN edited_at TIMESTAMPTZ
--      (nullable, no default). NULL = never edited. Non-null = timestamp
--      of most recent edit.
--   2. ALTER TABLE ... ADD COLUMN edited_by UUID (nullable, no default).
--      auth.users(id) of the most recent editor. NULL = never edited.
--      Plain UUID, no FK — mirrors the closed_by / created_by / recorded_by
--      convention used elsewhere in this schema.
--   3. ALTER TABLE ... ADD COLUMN deleted_by UUID (nullable, no default).
--      auth.users(id) of the user who soft-deleted the row. NULL = either
--      the row is live, or it was deleted by a code path that didn't set
--      this column (shouldn't happen post-migration, but defensible).
--   4. No new indexes — these columns aren't filtered on in any current
--      query path. Add an index later if a "history" or "edited rows"
--      view ships.
--
-- Design decisions (Day 20):
--   - Audit applies only to MANUAL rows. The booking-payment integration
--     trigger continues to write daybook rows directly via INSERT, so
--     edited_at / edited_by stay NULL for those rows (correct — they
--     reflect the underlying payment, not user edits). Soft delete is
--     already manual-only via deleteTransaction's existing guard.
--   - Closed-day rows: the immutability trigger
--     (trg_check_account_transactions_immutability) blocks UPDATEs on
--     closed-period rows. So audit columns get populated only for
--     successful edits — which by construction are on live (open) rows.
--     No special handling needed in this migration.
--   - No retroactive backfill: existing rows that were edited before
--     this migration won't have audit info. That's accepted — there's
--     no source of truth to reconstruct from.
--
-- Re-running on production is safe:
--   - ALTER TABLE ... ADD COLUMN IF NOT EXISTS on all three columns.
-- =============================================================


-- ── 1. Add audit columns ─────────────────────────────────────

ALTER TABLE public.account_transactions
  ADD COLUMN IF NOT EXISTS edited_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS edited_by  UUID,
  ADD COLUMN IF NOT EXISTS deleted_by UUID;

COMMENT ON COLUMN public.account_transactions.edited_at IS
  'Timestamp of most recent user edit. NULL means the row has never been edited since creation. Set by services/accountsService.updateTransaction.';

COMMENT ON COLUMN public.account_transactions.edited_by IS
  'auth.users(id) of the user who performed the most recent edit. NULL when edited_at is NULL. Plain UUID, no FK (consistent with created_by / recorded_by convention).';

COMMENT ON COLUMN public.account_transactions.deleted_by IS
  'auth.users(id) of the user who soft-deleted this row. NULL when the row is live (deleted_at IS NULL). Plain UUID, no FK.';


-- =============================================================
-- Verification queries — run AFTER applying:
--
--   -- Q1: all three columns exist
--   SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--   WHERE table_schema = 'public'
--     AND table_name = 'account_transactions'
--     AND column_name IN ('edited_at', 'edited_by', 'deleted_by')
--   ORDER BY column_name;
--
--   -- Q2: column comments are set
--   SELECT column_name, col_description(
--     ('public.account_transactions')::regclass,
--     ordinal_position
--   ) AS comment
--   FROM information_schema.columns
--   WHERE table_schema = 'public'
--     AND table_name = 'account_transactions'
--     AND column_name IN ('edited_at', 'edited_by', 'deleted_by')
--   ORDER BY column_name;
--
--   -- Q3: existing rows all have NULL audit fields (no backfill)
--   SELECT COUNT(*) AS total,
--          COUNT(edited_at)  AS edited_at_set,
--          COUNT(edited_by)  AS edited_by_set,
--          COUNT(deleted_by) AS deleted_by_set
--   FROM public.account_transactions;
-- =============================================================

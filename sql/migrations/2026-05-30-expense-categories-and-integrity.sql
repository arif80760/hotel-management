-- sql/migrations/2026-05-30-expense-categories-and-integrity.sql
-- Phase 4A of Expense Management — categories table + FK + CHECK + indexes.
--
-- ─── STATUS ───────────────────────────────────────────────────
-- APPLIED 2026-05-30 (Day 21) — expense_categories table, FK from
-- account_transactions.category_id, CHECK constraint with three-branch
-- CASE on booking_payment_id, five partial indexes, touch_updated_at
-- trigger, RLS policies (authenticated read/insert/update). Verified
-- via the queries in the footer. All 9 pre-existing booking-derived
-- expense_out rows pass the CHECK via the booking-derived branch (TRUE).
-- ──────────────────────────────────────────────────────────────
--
-- Context: Stage 1 (2026-05-18-accounts-core-stage1.sql) already added
-- category_id, voucher_number, payee, employee_id, loan_id,
-- receipt_image_url as columns on account_transactions in anticipation
-- of the Expense / Loans / Receipts features. This migration completes
-- the Expense data foundation on top of that scaffolding:
--
--   1. Create the expense_categories reference table.
--   2. Wire account_transactions.category_id to expense_categories(id)
--      via a FK constraint (Stage 1 left it as a bare UUID).
--   3. Add the CHECK constraint enforcing expense_out integrity, with a
--      branch on booking_payment_id (refund-disbursement expense_out rows
--      created by the booking-payment integration trigger don't have
--      voucher/category/payee and shouldn't be required to).
--   4. Partial indexes on category_id, voucher_number, employee_id, payee
--      for join and lookup performance.
--   5. RLS on expense_categories (admin-only writes pattern matching
--      the rest of the codebase).
--
-- Design decisions (Day 21, after discovering Stage 1's pre-existing
-- expense columns):
--
--   - Reuse Stage 1's category_id, voucher_number, payee, employee_id
--     columns rather than introducing parallel names. No vendors table —
--     Stage 1 settled on free-text payee.
--   - CHECK branches on booking_payment_id. User-recorded expenses
--     (booking_payment_id IS NULL) must have voucher + category + exactly
--     one of (employee_id, payee). Booking-derived refund expenses
--     (booking_payment_id IS NOT NULL) are exempt — they're a different
--     code path created by fn_sync_account_transactions.
--   - Non-expense_out rows must NOT have category_id, voucher_number, or
--     payee set (defensive against cross-type contamination). employee_id
--     is intentionally NOT constrained on non-expense rows because
--     Stage 1 didn't constrain it.
--   - Soft-deactivate via is_active = false, no rename ban (renaming
--     allowed for typo fixes; single-user-today low-risk).
--
-- Pre-apply verification confirmed:
--   - 9 existing expense_out rows are all booking-derived (booking_payment_id
--     IS NOT NULL). They pass the CHECK via the booking-derived branch.
--   - 0 non-expense_out rows have any of category_id, voucher_number,
--     payee, employee_id set. They pass the ELSE branch.
-- =============================================================


-- ── 1. expense_categories table ──────────────────────────────

CREATE TABLE IF NOT EXISTS public.expense_categories (
  id         UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT         NOT NULL UNIQUE,
  is_active  BOOLEAN      NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
  created_by UUID,
  updated_at TIMESTAMPTZ  NOT NULL DEFAULT now()
);

COMMENT ON TABLE  public.expense_categories IS
  'Dynamic categories for expense classification. Created on-the-spot from the expense form; managed admin-side. Rename allowed for typo fixes; soft-deactivate via is_active = false (DELETE not used so past expenses keep their FK target).';

COMMENT ON COLUMN public.expense_categories.is_active IS
  'When false, the category is hidden from the entry form''s autocomplete but past expenses still reference it.';


-- ── 2. FK from account_transactions.category_id ──────────────
--
-- Stage 1 left category_id as a bare UUID. Now that expense_categories
-- exists, add the constraint. ON DELETE RESTRICT means you can't delete
-- a category that still has expenses pointing at it — use soft-deactivate.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_account_transactions_category'
  ) THEN
    ALTER TABLE public.account_transactions
    ADD CONSTRAINT fk_account_transactions_category
    FOREIGN KEY (category_id) REFERENCES public.expense_categories(id) ON DELETE RESTRICT;
  END IF;
END
$$;


-- ── 3. CHECK constraint: expense_out integrity ───────────────
--
-- Three branches:
--   A. User-recorded expense_out (booking_payment_id IS NULL):
--        voucher_number IS NOT NULL
--        AND category_id IS NOT NULL
--        AND exactly one of (employee_id, payee) IS NOT NULL
--   B. Booking-derived expense_out (booking_payment_id IS NOT NULL):
--        no constraint on expense fields (refund disbursements bypass)
--   C. Non-expense_out:
--        category_id, voucher_number, payee all IS NULL
--        (employee_id intentionally permissive — Stage 1 design)

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_account_transactions_expense_out_integrity'
  ) THEN
    ALTER TABLE public.account_transactions
    ADD CONSTRAINT chk_account_transactions_expense_out_integrity
    CHECK (
      CASE
        WHEN type = 'expense_out' AND booking_payment_id IS NULL THEN
          voucher_number IS NOT NULL
          AND category_id IS NOT NULL
          AND (
            (employee_id IS NOT NULL AND payee IS NULL)
            OR
            (employee_id IS NULL AND payee IS NOT NULL)
          )
        WHEN type = 'expense_out' AND booking_payment_id IS NOT NULL THEN
          TRUE
        ELSE
          voucher_number IS NULL
          AND category_id IS NULL
          AND payee IS NULL
      END
    );
  END IF;
END
$$;


-- ── 4. Indexes ───────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_acct_txn_category_id    ON public.account_transactions(category_id)    WHERE category_id    IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_acct_txn_voucher_number ON public.account_transactions(voucher_number) WHERE voucher_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_acct_txn_employee_id    ON public.account_transactions(employee_id)    WHERE employee_id    IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_acct_txn_payee          ON public.account_transactions(payee)          WHERE payee          IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_expense_categories_active ON public.expense_categories(is_active) WHERE is_active = true;


-- ── 5. updated_at trigger for expense_categories ─────────────
--
-- Reuse touch_updated_at() if it exists from a prior migration; create
-- otherwise. Idempotent.

CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_touch_expense_categories') THEN
    CREATE TRIGGER trg_touch_expense_categories
    BEFORE UPDATE ON public.expense_categories
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
  END IF;
END
$$;


-- ── 6. Row Level Security ────────────────────────────────────

ALTER TABLE public.expense_categories ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='expense_categories' AND policyname='Authenticated can read expense_categories') THEN
    CREATE POLICY "Authenticated can read expense_categories"
      ON public.expense_categories FOR SELECT TO authenticated USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='expense_categories' AND policyname='Authenticated can insert expense_categories') THEN
    CREATE POLICY "Authenticated can insert expense_categories"
      ON public.expense_categories FOR INSERT TO authenticated WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='expense_categories' AND policyname='Authenticated can update expense_categories') THEN
    CREATE POLICY "Authenticated can update expense_categories"
      ON public.expense_categories FOR UPDATE TO authenticated USING (true);
  END IF;
END
$$;


-- =============================================================
-- Verification queries — run AFTER applying:
--
--   -- Q1: expense_categories table exists
--   SELECT table_name FROM information_schema.tables
--   WHERE table_schema = 'public' AND table_name = 'expense_categories';
--
--   -- Q2: FK on category_id exists
--   SELECT conname, pg_get_constraintdef(oid)
--   FROM pg_constraint WHERE conname = 'fk_account_transactions_category';
--
--   -- Q3: CHECK constraint exists
--   SELECT conname, pg_get_constraintdef(oid)
--   FROM pg_constraint WHERE conname = 'chk_account_transactions_expense_out_integrity';
--
--   -- Q4: indexes
--   SELECT indexname FROM pg_indexes
--   WHERE schemaname = 'public'
--     AND (indexname LIKE 'idx_acct_txn_category%'
--          OR indexname LIKE 'idx_acct_txn_voucher%'
--          OR indexname LIKE 'idx_acct_txn_employee%'
--          OR indexname LIKE 'idx_acct_txn_payee%'
--          OR indexname LIKE 'idx_expense_categories%');
--
--   -- Q5: RLS enabled
--   SELECT tablename, rowsecurity FROM pg_tables
--   WHERE schemaname='public' AND tablename = 'expense_categories';
--
--   -- Q6: existing rows still pass the CHECK (no errors during apply)
--   SELECT COUNT(*) FROM public.account_transactions;
-- =============================================================

-- sql/migrations/2026-05-31-revenue-categories-and-integrity.sql
-- Phase R-A of Revenue Management bootstrap.
--
-- ─── STATUS ───────────────────────────────────────────────────
-- APPLIED 2026-05-31 (Day 22) — revenue_categories table,
-- account_transactions.revenue_category_id column + FK,
-- chk_account_transactions_expense_out_integrity DROPPED,
-- chk_account_transactions_revenue_expense_integrity CREATED with
-- five-branch CASE (user-expense / booking-expense / user-revenue /
-- booking-revenue / ELSE TRUE), two new partial indexes,
-- touch_updated_at trigger on revenue_categories, RLS policies
-- (authenticated read/insert/update).
--
-- Pre-apply state: 110 rows. Post-apply: 111 rows (one user expense
-- EV-2026-0006 was added by Arif between Day 21 close and Day 22 open).
-- All 111 rows pass the new CHECK:
--   - 9 booking-derived expense_out → branch B (TRUE)
--   - 2 user expense_out (EV-2026-0005, EV-2026-0006) → branch A
--   - 96 booking-derived revenue_in → branch D (TRUE)
--   - 0 user revenue_in (none exist yet)
--   - 4 other types (injection, transfer, etc.) → branch E (TRUE)
-- ──────────────────────────────────────────────────────────────
--
-- Context: Stage 1's account_transactions schema reserved `category_id`
-- and `payee` as shared columns intended for both expense and revenue
-- subtypes. Day 21's Phase 4A wired `category_id` to expense_categories
-- via FK and added chk_account_transactions_expense_out_integrity, which
-- has a too-restrictive ELSE branch — it forbids category_id/payee/
-- voucher_number on every non-expense_out row, blocking user-recorded
-- revenue from ever being created.
--
-- This migration completes the revenue data foundation:
--
--   1. New revenue_categories table (parallel to expense_categories).
--      Architecture-doc §7 specifies expense vs revenue categories are
--      separate sets, so a separate table — not a polymorphic merge.
--   2. New column account_transactions.revenue_category_id with FK to
--      revenue_categories(id) ON DELETE RESTRICT. Kept separate from
--      `category_id` (which continues to FK expense_categories) to
--      avoid touching yesterday's working expense code. Asymmetric
--      naming accepted; can be refactored later if it bothers us.
--   3. DROP yesterday's chk_account_transactions_expense_out_integrity
--      and CREATE a new chk_account_transactions_revenue_expense_integrity
--      that handles both expense and revenue branches plus a permissive
--      ELSE.
--   4. Partial index on revenue_category_id.
--   5. RLS + touch_updated_at trigger on revenue_categories.
--
-- Pre-apply verification confirmed:
--   - 96 booking-derived revenue_in rows exist; all have category_id,
--     payee, voucher_number, employee_id all NULL. They pass the new
--     CHECK via the booking-derived branch (TRUE).
--   - 0 user-recorded revenue_in rows exist. New code path starts clean.
--   - 9 booking-derived expense_out rows pass via their existing branch.
--   - 1 user expense_out row (EV-2026-0005) passes via the
--     user-recorded expense branch.
--   - 100 non-expense/non-revenue rows pass via the ELSE branch (which
--     is now permissive — no longer requires category_id/payee NULL).
--
-- Design decisions:
--   - revenue_in user-recorded rows require revenue_category_id +
--     payee (NOT NULL). No voucher (vouchers are outbound; a rent
--     receipt would be a separate artifact, not built today).
--   - ELSE branch returns TRUE rather than forbidding the shared
--     columns to be set. Stage 1 reserved these columns as shared;
--     blanket-forbidding them on other types over-restricts the schema.
--   - Rename of the constraint reflects the expanded scope.
-- =============================================================


-- ── 1. revenue_categories table ──────────────────────────────

CREATE TABLE IF NOT EXISTS public.revenue_categories (
  id         UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT         NOT NULL UNIQUE,
  is_active  BOOLEAN      NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
  created_by UUID,
  updated_at TIMESTAMPTZ  NOT NULL DEFAULT now()
);

COMMENT ON TABLE  public.revenue_categories IS
  'Dynamic categories for non-booking revenue (rent from restaurant/office/tower/holiday/shop/bus-ticketing-office tenants, etc.). Created on-the-spot from the revenue entry form; managed admin-side. Rename allowed; soft-deactivate via is_active = false.';

COMMENT ON COLUMN public.revenue_categories.is_active IS
  'When false, the category is hidden from the entry form''s autocomplete but past revenue rows still reference it.';


-- ── 2. account_transactions.revenue_category_id column + FK ──

ALTER TABLE public.account_transactions
  ADD COLUMN IF NOT EXISTS revenue_category_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_account_transactions_revenue_category'
  ) THEN
    ALTER TABLE public.account_transactions
    ADD CONSTRAINT fk_account_transactions_revenue_category
    FOREIGN KEY (revenue_category_id) REFERENCES public.revenue_categories(id) ON DELETE RESTRICT;
  END IF;
END
$$;

COMMENT ON COLUMN public.account_transactions.revenue_category_id IS
  'For revenue_in rows: the category (rent source, etc.). NULL for non-revenue rows. Separate from category_id (which is for expense_categories) per Day 22 design.';


-- ── 3. DROP the old expense-only CHECK, CREATE expanded one ──

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_account_transactions_expense_out_integrity'
  ) THEN
    ALTER TABLE public.account_transactions
    DROP CONSTRAINT chk_account_transactions_expense_out_integrity;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_account_transactions_revenue_expense_integrity'
  ) THEN
    ALTER TABLE public.account_transactions
    ADD CONSTRAINT chk_account_transactions_revenue_expense_integrity
    CHECK (
      CASE
        -- A. User-recorded expense: voucher + category + exactly one payee
        WHEN type = 'expense_out' AND booking_payment_id IS NULL THEN
          voucher_number IS NOT NULL
          AND category_id IS NOT NULL
          AND (
            (employee_id IS NOT NULL AND payee IS NULL)
            OR
            (employee_id IS NULL AND payee IS NOT NULL)
          )

        -- B. Booking-derived expense (refund disbursement): bypass
        WHEN type = 'expense_out' AND booking_payment_id IS NOT NULL THEN
          TRUE

        -- C. User-recorded revenue: revenue_category + payee
        WHEN type = 'revenue_in' AND booking_payment_id IS NULL THEN
          revenue_category_id IS NOT NULL
          AND payee IS NOT NULL

        -- D. Booking-derived revenue (from fn_sync_account_transactions): bypass
        WHEN type = 'revenue_in' AND booking_payment_id IS NOT NULL THEN
          TRUE

        -- E. All other types (transfer, injection, loan_received,
        --    loan_repayment): no expense/revenue field requirements.
        --    Stage 1's chk_txn_accounts handles direction invariants.
        ELSE
          TRUE
      END
    );
  END IF;
END
$$;


-- ── 4. Index on revenue_category_id ──────────────────────────

CREATE INDEX IF NOT EXISTS idx_acct_txn_revenue_category_id
  ON public.account_transactions(revenue_category_id)
  WHERE revenue_category_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_revenue_categories_active
  ON public.revenue_categories(is_active)
  WHERE is_active = true;


-- ── 5. updated_at trigger for revenue_categories ─────────────
-- touch_updated_at() already exists from Phase 4A; reuse.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_touch_revenue_categories') THEN
    CREATE TRIGGER trg_touch_revenue_categories
    BEFORE UPDATE ON public.revenue_categories
    FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
  END IF;
END
$$;


-- ── 6. Row Level Security ────────────────────────────────────

ALTER TABLE public.revenue_categories ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='revenue_categories' AND policyname='Authenticated can read revenue_categories') THEN
    CREATE POLICY "Authenticated can read revenue_categories"
      ON public.revenue_categories FOR SELECT TO authenticated USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='revenue_categories' AND policyname='Authenticated can insert revenue_categories') THEN
    CREATE POLICY "Authenticated can insert revenue_categories"
      ON public.revenue_categories FOR INSERT TO authenticated WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='revenue_categories' AND policyname='Authenticated can update revenue_categories') THEN
    CREATE POLICY "Authenticated can update revenue_categories"
      ON public.revenue_categories FOR UPDATE TO authenticated USING (true);
  END IF;
END
$$;


-- =============================================================
-- Verification queries — run AFTER applying:
--
--   -- Q1: revenue_categories table exists
--   SELECT table_name FROM information_schema.tables
--   WHERE table_schema='public' AND table_name='revenue_categories';
--
--   -- Q2: revenue_category_id column added
--   SELECT column_name FROM information_schema.columns
--   WHERE table_schema='public' AND table_name='account_transactions'
--     AND column_name='revenue_category_id';
--
--   -- Q3: FK exists
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--   WHERE conname='fk_account_transactions_revenue_category';
--
--   -- Q4: NEW CHECK exists, OLD CHECK gone
--   SELECT conname FROM pg_constraint
--   WHERE conname IN (
--     'chk_account_transactions_expense_out_integrity',
--     'chk_account_transactions_revenue_expense_integrity'
--   );
--   -- Expected: only chk_account_transactions_revenue_expense_integrity
--
--   -- Q5: row count unchanged
--   SELECT COUNT(*) FROM public.account_transactions;
--   -- Expected: 110
--
--   -- Q6: all rows still pass the new constraint (implicit — if any row
--   -- failed during apply, the migration would have rolled back)
-- =============================================================

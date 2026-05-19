-- =============================================================
-- 2026-05-18-accounts-core-stage1.sql
-- Accounts feature — Stage 1: foundational schema
--
-- Run in: Supabase SQL Editor (project: hotel-albatross-resort)
-- Run as: postgres / service_role (required for seed INSERT)
-- Idempotent: yes (IF NOT EXISTS, OR REPLACE, IF EXISTS guards)
--
-- What this migration does:
--   1. Creates the account_transaction_type enum
--   2. Creates the accounts table (four money buckets)
--   3. Seeds accounts with FIXED UUIDs (stable for later stages)
--   4. Creates the account_transactions table
--   5. Creates 4 indexes on account_transactions
--   6. Enables RLS on both tables
--   7. Creates 5 admin-only policies
--
-- Fixed bucket UUIDs (reference in later stages):
--   Cash in Hand : a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11
--   Bank         : b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22
--   bKash        : c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33
--   Nagad        : d0eebc99-9c0b-4ef8-bb6d-6bb9bd380a44
--
-- Do NOT run until Stage 1 is ready to ship.
-- The booking-payment integration seam (Section 8 of architecture)
-- is resolved in a later stage — this migration creates the schema
-- but does not wire the seam.
-- =============================================================


-- ── 1. Enum ──────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE public.account_transaction_type AS ENUM (
    'revenue_in',
    'expense_out',
    'transfer',
    'injection',
    'loan_received',
    'loan_repayment'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;


-- ── 2. accounts table ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.accounts (
  id            UUID          PRIMARY KEY,
  name          TEXT          NOT NULL UNIQUE,
  is_spendable  BOOLEAN       NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT now()
);

COMMENT ON TABLE  public.accounts
  IS 'Money buckets (Cash in Hand, Bank, bKash, Nagad). Four fixed rows seeded at migration. Balance is always computed from account_transactions — no stored balance column.';
COMMENT ON COLUMN public.accounts.is_spendable
  IS 'true = admin can fund expenses from this bucket (Cash in Hand only). false = receive/transfer only.';


-- ── 3. Seed — fixed UUIDs ────────────────────────────────────
-- Inserted with ON CONFLICT DO NOTHING so re-running is safe.
-- service_role bypasses RLS (no INSERT policy on accounts for
-- authenticated role — the app never creates/deletes buckets).

INSERT INTO public.accounts (id, name, is_spendable) VALUES
  ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'Cash in Hand', true),
  ('b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22', 'Bank',         false),
  ('c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33', 'bKash',        false),
  ('d0eebc99-9c0b-4ef8-bb6d-6bb9bd380a44', 'Nagad',        false)
ON CONFLICT (id) DO NOTHING;


-- ── 4. account_transactions table ────────────────────────────

CREATE TABLE IF NOT EXISTS public.account_transactions (
  id                   UUID                             PRIMARY KEY DEFAULT gen_random_uuid(),
  txn_date             DATE                             NOT NULL,
  type                 public.account_transaction_type  NOT NULL,
  amount               NUMERIC(12, 2)                   NOT NULL CHECK (amount > 0),

  from_account_id      UUID                             REFERENCES public.accounts(id),
  to_account_id        UUID                             REFERENCES public.accounts(id),

  CONSTRAINT chk_txn_accounts CHECK (
    (type IN ('revenue_in','injection','loan_received')
       AND to_account_id IS NOT NULL AND from_account_id IS NULL)
    OR (type IN ('expense_out','loan_repayment')
       AND from_account_id IS NOT NULL AND to_account_id IS NULL)
    OR (type = 'transfer'
       AND from_account_id IS NOT NULL AND to_account_id IS NOT NULL
       AND from_account_id <> to_account_id)
  ),

  category_id          UUID,
  voucher_number       TEXT,
  payee                TEXT,
  employee_id          UUID        REFERENCES public.employees(id) ON DELETE SET NULL,
  booking_payment_id   UUID        REFERENCES public.payments(id)  ON DELETE SET NULL,
  loan_id              UUID,
  receipt_image_url    TEXT,
  note                 TEXT,
  created_by           UUID,                -- auth.users(id); plain UUID, no FK (consistent with payments.recorded_by)
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE  public.account_transactions
  IS 'Every money movement in the Accounts feature. One row per event. Balance for any bucket is computed by summing to_account_id credits minus from_account_id debits.';
COMMENT ON COLUMN public.account_transactions.from_account_id
  IS 'Bucket that loses money (debit). NULL for inbound types (revenue_in, injection, loan_received).';
COMMENT ON COLUMN public.account_transactions.to_account_id
  IS 'Bucket that gains money (credit). NULL for outbound types (expense_out, loan_repayment).';
COMMENT ON COLUMN public.account_transactions.voucher_number
  IS 'Sequential voucher ID (VCH-0001, VCH-0002 …). Non-null only for expense_out rows.';
COMMENT ON COLUMN public.account_transactions.employee_id
  IS 'Set for Salary-category expense_out rows (payroll). Links to employees table.';
COMMENT ON COLUMN public.account_transactions.booking_payment_id
  IS 'Set when this revenue_in row was auto-generated from a booking payment. Links to payments table.';
COMMENT ON COLUMN public.account_transactions.loan_id
  IS 'Set for loan_received and loan_repayment rows. FK to loans table (added Stage 6).';


-- ── 5. Indexes ────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_acct_txn_date
  ON public.account_transactions (txn_date);

CREATE INDEX IF NOT EXISTS idx_acct_txn_from_account
  ON public.account_transactions (from_account_id);

CREATE INDEX IF NOT EXISTS idx_acct_txn_to_account
  ON public.account_transactions (to_account_id);

CREATE INDEX IF NOT EXISTS idx_acct_txn_type
  ON public.account_transactions (type);

CREATE INDEX IF NOT EXISTS idx_acct_txn_booking_payment_id
  ON public.account_transactions (booking_payment_id)
  WHERE booking_payment_id IS NOT NULL;


-- ── 6. Enable RLS ─────────────────────────────────────────────

ALTER TABLE public.accounts             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_transactions ENABLE ROW LEVEL SECURITY;


-- ── 7. Policies — admin-only ──────────────────────────────────

-- accounts: SELECT only for authenticated admin.
-- No INSERT/UPDATE/DELETE policies — authenticated role cannot
-- write to accounts; only service_role (seed) can.
CREATE POLICY "Accounts select — admin only"
  ON public.accounts FOR SELECT TO authenticated
  USING (current_user_role() = 'admin');

-- account_transactions: full CRUD, admin-only.
CREATE POLICY "Account transactions select — admin only"
  ON public.account_transactions FOR SELECT TO authenticated
  USING (current_user_role() = 'admin');
CREATE POLICY "Account transactions insert — admin only"
  ON public.account_transactions FOR INSERT TO authenticated
  WITH CHECK (current_user_role() = 'admin');
CREATE POLICY "Account transactions update — admin only"
  ON public.account_transactions FOR UPDATE TO authenticated
  USING (current_user_role() = 'admin')
  WITH CHECK (current_user_role() = 'admin');
CREATE POLICY "Account transactions delete — admin only"
  ON public.account_transactions FOR DELETE TO authenticated
  USING (current_user_role() = 'admin');


-- =============================================================
-- Verification (run after applying — expected results):
--
--   SELECT id, name, is_spendable FROM public.accounts ORDER BY name;
--   -- 4 rows:
--   --   b0eebc99… | Bank         | false
--   --   a0eebc99… | Cash in Hand | true
--   --   c0eebc99… | bKash        | false
--   --   d0eebc99… | Nagad        | false
--
--   SELECT COUNT(*) FROM public.account_transactions;
--   -- 0 rows (table is empty; transactions are created by the app)
--
--   SELECT policyname FROM pg_policies
--    WHERE tablename IN ('accounts', 'account_transactions')
--    ORDER BY tablename, policyname;
--   -- 5 rows: 1 on accounts, 4 on account_transactions
-- =============================================================

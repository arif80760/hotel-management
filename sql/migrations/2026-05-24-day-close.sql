-- sql/migrations/2026-05-24-day-close.sql
-- Day-close mechanism — table, immutability trigger, bootstrap seed.
--
-- ─── STATUS ───────────────────────────────────────────────────
-- APPLIED 2026-05-24 (Day 19) — table, RLS, immutability trigger,
-- and bootstrap seed all live in production.
-- Bootstrap closing_balance: ৳423,550.02 (Cash in Hand as of end of
-- May 23). Smoke tests confirmed: INSERT with txn_date <= 2026-05-23
-- rejected; INSERT with current_date allowed.
-- ──────────────────────────────────────────────────────────────
--
-- Implements the day-close feature per docs/architecture/accounts.md §11
-- and §14. Path B (MVP) scope: backend ships in this migration. Service
-- layer (closeDay, getMissedDays, getDayCloseStatus) and UI ship in
-- subsequent commits and are NOT in this file.
--
-- Cash in Hand only. Other buckets (Bank, bKash, Nagad) are unaffected
-- by day-close. Closed days are immutable — DB-level trigger blocks
-- INSERT/UPDATE/DELETE on account_transactions where txn_date is on or
-- before the latest closed date.
--
-- Bootstrap: this migration seeds a single day_closes row for 2026-05-23
-- with both opening_balance and closing_balance set to the current Cash
-- in Hand sum across all account_transactions with txn_date <= 2026-05-23.
-- After this migration runs, today (2026-05-24) becomes the first
-- user-facing close.
--
-- Cross-trigger interaction: this immutability trigger fires on
-- account_transactions writes, including those driven indirectly via
-- fn_sync_account_transactions (booking-payment integration). The
-- 2026-05-24-booking-payment-integration-update-branch-fix.sql amendment
-- (applied earlier this same shift) ensures the UPDATE branch of that
-- trigger writes daybook rows with current_date/now(), avoiding the
-- footgun where back-dated pre-adjustment disbursements would be
-- rejected by this immutability trigger.
-- =============================================================


-- ── 1. day_closes table ──────────────────────────────────────
--
-- Schema per docs/architecture/accounts.md §14.
--
-- close_date UNIQUE: enforces "one close per day, no duplicates."
-- opening_balance and closing_balance: NUMERIC(12,2) to match
--   account_transactions.amount precision.
-- closed_by: plain UUID, no FK, mirrors payments.recorded_by and
--   account_transactions.created_by convention. NULL allowed for the
--   bootstrap row only (no human closed the seed).

CREATE TABLE IF NOT EXISTS public.day_closes (
  id                UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
  close_date        DATE           NOT NULL UNIQUE,
  opening_balance   NUMERIC(12, 2) NOT NULL,
  closing_balance   NUMERIC(12, 2) NOT NULL,
  closed_by         UUID,                                -- NULL only for the bootstrap seed row
  closed_at         TIMESTAMPTZ    NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.day_closes
  IS 'One row per closed day. Tracks Cash in Hand opening and closing balances. close_date UNIQUE enforces one close per day. Each days opening = prior days closing (chain). closed_by NULL only on the bootstrap seed row.';

COMMENT ON COLUMN public.day_closes.opening_balance
  IS 'Cash in Hand balance at the start of close_date. Equals prior days closing_balance for all rows except the bootstrap.';

COMMENT ON COLUMN public.day_closes.closing_balance
  IS 'Cash in Hand balance at the end of close_date, after all that days transactions. Auto-calculated by service layer, not entered by user.';

COMMENT ON COLUMN public.day_closes.closed_by
  IS 'auth.users(id) of admin who performed the close. NULL only on the bootstrap seed (no human closed it; the migration seeded it).';


CREATE INDEX IF NOT EXISTS idx_day_closes_close_date
  ON public.day_closes (close_date DESC);


-- RLS: mirror the pattern used on account_transactions and accounts.
-- SELECT and INSERT permitted for authenticated; no UPDATE or DELETE
-- policies — closes are immutable by design (and the immutability
-- trigger on account_transactions assumes day_closes rows don't move).
ALTER TABLE public.day_closes ENABLE ROW LEVEL SECURITY;

CREATE POLICY day_closes_select_authenticated
  ON public.day_closes FOR SELECT TO authenticated
  USING (true);

CREATE POLICY day_closes_insert_authenticated
  ON public.day_closes FOR INSERT TO authenticated
  WITH CHECK (true);


-- ── 2. Immutability trigger on account_transactions ──────────
--
-- Blocks any INSERT, UPDATE, or DELETE on account_transactions where the
-- affected rows txn_date is on or before the latest closed date in
-- day_closes. DB-level enforcement: even if a developer or bug bypasses
-- UI guards, Postgres will RAISE and abort.
--
-- Edge case: if day_closes is empty (no closes ever), MAX returns NULL.
-- "x <= NULL" returns NULL, which is falsy in IF — so the trigger
-- correctly allows all writes when nothing has been closed yet. After
-- this migration runs the bootstrap seed will be present, so MAX is
-- never NULL in production.

CREATE OR REPLACE FUNCTION public.fn_check_account_transactions_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_last_closed DATE;
BEGIN
  SELECT MAX(close_date) INTO v_last_closed FROM public.day_closes;

  -- No closes yet: allow everything. (Pre-bootstrap only.)
  IF v_last_closed IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.txn_date <= v_last_closed THEN
      RAISE EXCEPTION
        'Cannot INSERT account_transactions row with txn_date % — that day is closed (latest closed: %)',
        NEW.txn_date, v_last_closed;
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD.txn_date <= v_last_closed OR NEW.txn_date <= v_last_closed THEN
      RAISE EXCEPTION
        'Cannot UPDATE account_transactions row touching closed date range — OLD.txn_date=%, NEW.txn_date=%, latest closed=%',
        OLD.txn_date, NEW.txn_date, v_last_closed;
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.txn_date <= v_last_closed THEN
      RAISE EXCEPTION
        'Cannot DELETE account_transactions row with txn_date % — that day is closed (latest closed: %)',
        OLD.txn_date, v_last_closed;
    END IF;
    RETURN OLD;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

COMMENT ON FUNCTION public.fn_check_account_transactions_immutability IS
  'Blocks writes to account_transactions rows on or before MAX(day_closes.close_date). Allows all writes if day_closes is empty (pre-bootstrap).';


DROP TRIGGER IF EXISTS trg_check_account_transactions_immutability
  ON public.account_transactions;

CREATE TRIGGER trg_check_account_transactions_immutability
  BEFORE INSERT OR UPDATE OR DELETE
  ON public.account_transactions
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_check_account_transactions_immutability();


COMMENT ON TRIGGER trg_check_account_transactions_immutability
  ON public.account_transactions
  IS 'Enforces day-close immutability. Fires BEFORE so RAISE aborts the write atomically.';


-- ── 3. Bootstrap seed row ────────────────────────────────────
--
-- One-time seed: 2026-05-23 with closing_balance = current Cash in Hand
-- balance computed inline from account_transactions. opening_balance is
-- set to the same value (we have no prior chain link, so we declare
-- May 23 opened AND closed at this balance — equivalent to saying "no
-- net change on May 23 from the perspective of the chain").
--
-- Cash in Hand bucket UUID: a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11
--
-- Sum logic: for each row dated <= 2026-05-23, add amount if Cash in
-- Hand is to_account_id (credit), subtract amount if Cash in Hand is
-- from_account_id (debit). Transfers from non-Cash to non-Cash buckets
-- contribute 0. The schema's chk_txn_accounts constraint ensures
-- from_account_id <> to_account_id, so no double-counting.
--
-- Idempotency: ON CONFLICT (close_date) DO NOTHING means re-running
-- the migration is safe — the seed is inserted exactly once.

INSERT INTO public.day_closes (close_date, opening_balance, closing_balance, closed_by, closed_at)
SELECT
  DATE '2026-05-23',
  COALESCE(SUM(
    CASE
      WHEN to_account_id   = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'::uuid THEN amount
      WHEN from_account_id = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'::uuid THEN -amount
      ELSE 0
    END
  ), 0),
  COALESCE(SUM(
    CASE
      WHEN to_account_id   = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'::uuid THEN amount
      WHEN from_account_id = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'::uuid THEN -amount
      ELSE 0
    END
  ), 0),
  NULL,
  now()
FROM public.account_transactions
WHERE txn_date <= DATE '2026-05-23'
ON CONFLICT (close_date) DO NOTHING;


-- =============================================================
-- Verification queries — run AFTER applying:
--
--   -- Q1: bootstrap row should exist with closing_balance = 423550.02
--   -- (verified value at draft time via Supabase SELECT).
--   SELECT close_date, opening_balance, closing_balance, closed_by, closed_at
--   FROM public.day_closes;
--
--   -- Q2: immutability trigger exists
--   SELECT tgname FROM pg_trigger
--   WHERE tgrelid = 'public.account_transactions'::regclass
--     AND NOT tgisinternal
--   ORDER BY tgname;
--   -- Expected: trg_check_account_transactions_immutability
--
--   -- Q3: smoke test — try to insert a row with txn_date = 2026-05-23.
--   -- MUST fail with the "Cannot INSERT ... that day is closed" RAISE.
--   -- Wrap in a transaction we'll roll back so we don't pollute data.
--   BEGIN;
--   INSERT INTO public.account_transactions
--     (txn_date, type, amount, to_account_id, created_by)
--   VALUES
--     ('2026-05-23', 'injection', 1.00,
--      'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'::uuid, NULL);
--   -- Expected: ERROR: Cannot INSERT account_transactions row with
--   -- txn_date 2026-05-23 — that day is closed (latest closed: 2026-05-23)
--   ROLLBACK;
--
--   -- Q4: positive smoke test — insert a row with today's date should
--   -- succeed. Roll back to avoid polluting data.
--   BEGIN;
--   INSERT INTO public.account_transactions
--     (txn_date, type, amount, to_account_id, created_by)
--   VALUES
--     (current_date, 'injection', 1.00,
--      'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'::uuid, NULL);
--   ROLLBACK;
-- =============================================================

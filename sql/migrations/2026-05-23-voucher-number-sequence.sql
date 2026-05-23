-- sql/migrations/2026-05-23-voucher-number-sequence.sql
-- Voucher number sequence — atomic generator for expense voucher numbers.
--
-- ─── STATUS ───────────────────────────────────────────────────
-- DRAFT — NOT YET APPLIED TO PRODUCTION (as of 2026-05-23).
--
-- This migration is queued for Day 19+ session review and execution
-- alongside other deferred Accounts work (day-close, Expense Management).
-- ──────────────────────────────────────────────────────────────
--
-- Format: EV-{YYYY}-{####}
--   EV    — Expense Voucher prefix
--   YYYY  — 4-digit year, taken from current_date at call time
--   ####  — 4-digit zero-padded sequence, resets each year (1 → 9999)
--
-- Examples:
--   First voucher in 2026 → EV-2026-0001
--   100th voucher in 2026 → EV-2026-0100
--   First voucher in 2027 → EV-2027-0001   (sequence resets)
--
-- Implementation note — per-year sequences (Option A):
--   Postgres SEQUENCE objects don't reset themselves. To get yearly reset
--   without cron, we create a new SEQUENCE for each year on first use,
--   named voucher_seq_{YYYY}. The generator function ensures the current
--   year's sequence exists (CREATE SEQUENCE IF NOT EXISTS) before pulling
--   nextval from it. After 10 years the schema has 10 sequence objects;
--   each is < 1 KB and never queried by name except inside this function.
--
-- Atomicity:
--   nextval() is guaranteed by Postgres to return a unique value per call,
--   even under concurrent execution. No race conditions possible. Sequence
--   gaps may exist (e.g. if a transaction rolls back after consuming a
--   sequence value) — that's expected behavior and acceptable for voucher
--   numbering. The UNIQUE constraint below catches accidental duplicates
--   from any non-sequence write path.
--
-- Not done here:
--   - No backfill of existing account_transactions rows. The voucher_number
--     column is currently NULL on every row; there's nothing to backfill.
--   - No integration with services/accountsService.ts or any RPC. The
--     function is plumbed and ready; Expense Management code will call it
--     when that feature ships.
-- =============================================================


-- ── 1. The generator function ──────────────────────────────
--
-- Call this function to obtain the next voucher number string. Each call
-- returns a unique value scoped to the current year. The function creates
-- the year's sequence on first call of that year.
--
-- Returns:
--   TEXT — formatted as 'EV-YYYY-NNNN'
--
-- Caller responsibilities:
--   - Store the returned string into account_transactions.voucher_number
--     within the same transaction. If the transaction rolls back, the
--     sequence value is consumed but the voucher number is not used —
--     resulting in a permanent gap (acceptable).
--   - Treat sequence gaps as normal. Voucher numbers are guaranteed
--     unique and monotonically increasing within a year, but not gap-free.

CREATE OR REPLACE FUNCTION public.next_voucher_number()
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  v_year     INTEGER := EXTRACT(YEAR FROM current_date)::INTEGER;
  v_seq_name TEXT    := format('voucher_seq_%s', v_year);
  v_seq_val  BIGINT;
BEGIN
  -- Ensure the year's sequence exists. Idempotent — CREATE SEQUENCE IF
  -- NOT EXISTS is a no-op if already created.
  EXECUTE format(
    'CREATE SEQUENCE IF NOT EXISTS public.%I START WITH 1 INCREMENT BY 1 MINVALUE 1',
    v_seq_name
  );

  -- Pull next value atomically.
  EXECUTE format('SELECT nextval(''public.%I'')', v_seq_name) INTO v_seq_val;

  -- Format as EV-YYYY-NNNN. lpad pads with leading zeros to 4 digits.
  -- For year 2026, sequence value 42 → 'EV-2026-0042'.
  -- If a year ever exceeds 9999 vouchers, lpad still works — the number
  -- just grows past 4 digits ('EV-2026-12345'). UNIQUE constraint still
  -- holds.
  RETURN format('EV-%s-%s', v_year, lpad(v_seq_val::TEXT, 4, '0'));
END;
$$;

COMMENT ON FUNCTION public.next_voucher_number IS
  'Atomic generator for expense voucher numbers in format EV-YYYY-NNNN. '
  'Each call returns a unique value; sequence resets each year via '
  'per-year sequence objects (voucher_seq_2026, voucher_seq_2027, etc.).';


-- ── 2. Uniqueness constraint on voucher_number ────────────
--
-- account_transactions.voucher_number is currently TEXT NULL (defined in
-- 02-tables.sql). This partial unique index guarantees no two non-null
-- voucher numbers can coexist. Existing rows (all NULL) pass trivially.
--
-- A partial index (WHERE voucher_number IS NOT NULL) is used instead of
-- a regular UNIQUE constraint because Postgres treats multiple NULLs as
-- distinct values for unique constraints, but partial indexes let us be
-- explicit about ignoring NULLs.

CREATE UNIQUE INDEX IF NOT EXISTS idx_account_transactions_voucher_number_unique
  ON public.account_transactions (voucher_number)
  WHERE voucher_number IS NOT NULL;


-- ── 3. GRANT ──────────────────────────────────────────────
--
-- The function is invoked from RPC contexts (future Expense Management
-- RPCs that will INSERT into account_transactions). authenticated role
-- needs EXECUTE — same pattern as other Accounts functions in this codebase.

GRANT EXECUTE ON FUNCTION public.next_voucher_number() TO authenticated;


-- =============================================================
-- Verification queries — run AFTER applying:
--
--   -- Should return 'EV-2026-0001':
--   SELECT public.next_voucher_number();
--
--   -- Should return 'EV-2026-0002':
--   SELECT public.next_voucher_number();
--
--   -- Confirm the sequence exists:
--   SELECT sequence_name FROM information_schema.sequences
--    WHERE sequence_schema = 'public' AND sequence_name LIKE 'voucher_seq_%';
--
--   -- Confirm the unique index exists:
--   SELECT indexname FROM pg_indexes
--    WHERE tablename = 'account_transactions'
--      AND indexname = 'idx_account_transactions_voucher_number_unique';
-- =============================================================

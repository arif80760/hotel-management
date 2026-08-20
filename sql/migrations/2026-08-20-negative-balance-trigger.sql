-- =============================================================
-- 2026-08-20-negative-balance-trigger.sql
-- BEFORE INSERT guard: no account balance may go negative.
--
-- RECORD OF LIVE STATE — applied in the Supabase SQL editor on
-- 2026-08-20 (precondition verified: all balances non-negative).
-- Probe verified post-apply: transfer of ৳123,456 out of Bank
-- (balance ৳0) rejected with
--   "Insufficient balance in Bank: balance ৳0.00, attempted
--    ৳123456.00, shortfall ৳123456.00".
--
-- DESIGN: balances are DERIVED — account_balances is a VIEW summing
-- non-deleted account_transactions by from/to; there is no stored
-- balance column. The guard computes the projected balance with the
-- SAME expression as the view so the two can never disagree. This is
-- the DB-side overdraw backstop that expensesService.ts:76 noted as
-- pending; it agrees in direction with the client-side remuneration
-- drawdown guard (distinct error texts tell you which layer fired).
--
-- INTERACTIONS (analysed 2026-08-20):
--   • fn_check_account_transactions_immutability: both BEFORE INSERT;
--     ordering immaterial — the balance sum is date-independent, so
--     the carry-forward txn_date rewrite neither affects nor is
--     affected by this guard. On the carry-forward path itself the
--     guard is a no-op BY CONSTRUCTION: carried-forward rows are
--     collections (inflows, from_account_id NULL) and the guard only
--     examines outflows. A carried-forward TRANSFER would still be
--     checked — correct, it is a real outflow.
--   • SECURITY DEFINER because the invoker may be a staff token that
--     RLS bars from reading the ledger — the guard must see ALL rows
--     to compute a true balance. Fail-closed: unknown account raises;
--     any internal error aborts the insert.
--   • FOR UPDATE on the accounts row serializes concurrent outflows
--     from the same account (two simultaneous inserts can't jointly
--     overdraw).
--   • CONSEQUENCE, signed off: the guard applies to EVERY insert,
--     including the checkout auto-refund's ledger debit — if Cash in
--     Hand were ever short of an auto-refund, that checkout FAILS
--     with the shortfall error rather than driving cash negative.
--   • KNOWN NON-COVERAGE (inherent to BEFORE INSERT scope):
--     soft-deleting an old INFLOW (UPDATE … SET deleted_at) can push
--     a balance negative after the fact; the immutability trigger
--     limits that window to rows after the last day close.
--
-- CORRECTION RUNBOOK (also in CLAUDE.md): corrections that must
-- transiently overdraw go through DISABLE TRIGGER inside an explicit
-- transaction — a crash or ROLLBACK re-enables automatically:
--   BEGIN;
--   ALTER TABLE public.account_transactions
--     DISABLE TRIGGER trg_assert_no_negative_balance;
--   -- corrective INSERTs here
--   ALTER TABLE public.account_transactions
--     ENABLE TRIGGER trg_assert_no_negative_balance;
--   COMMIT;
-- =============================================================

CREATE OR REPLACE FUNCTION public.fn_assert_no_negative_balance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_balance numeric;
  v_name    text;
BEGIN
  -- Only OUTFLOWS can create a shortfall; inflow-only rows return
  -- immediately (this is also the carry-forward no-op path).
  IF NEW.from_account_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Serialize per-account so concurrent outflows can't jointly overdraw.
  PERFORM 1 FROM public.accounts WHERE id = NEW.from_account_id FOR UPDATE;

  SELECT a.name,
         COALESCE(SUM(t.amount) FILTER (WHERE t.to_account_id   = a.id), 0)
       - COALESCE(SUM(t.amount) FILTER (WHERE t.from_account_id = a.id), 0)
  INTO   v_name, v_balance
  FROM   public.accounts a
  LEFT JOIN public.account_transactions t
         ON (t.to_account_id = a.id OR t.from_account_id = a.id)
        AND t.deleted_at IS NULL
  WHERE  a.id = NEW.from_account_id
  GROUP BY a.name;

  IF v_name IS NULL THEN
    RAISE EXCEPTION 'fn_assert_no_negative_balance: account % not found', NEW.from_account_id;
  END IF;

  IF v_balance - NEW.amount < 0 THEN
    RAISE EXCEPTION 'Insufficient balance in %: balance ৳%, attempted ৳%, shortfall ৳%',
      v_name, v_balance, NEW.amount, NEW.amount - v_balance;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE TRIGGER trg_assert_no_negative_balance
  BEFORE INSERT ON public.account_transactions
  FOR EACH ROW EXECUTE FUNCTION public.fn_assert_no_negative_balance();

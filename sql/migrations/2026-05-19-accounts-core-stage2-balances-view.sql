-- 2026-05-19-accounts-core-stage2-balances-view.sql
-- Accounts core Stage 2 — account_balances view
-- Computes each bucket's balance by summing account_transactions.
-- Balances are COMPUTED, never stored (per Stage 1 design decision).
-- security_invoker = true: the view runs with the querying user's
-- permissions, so the admin-only RLS on accounts / account_transactions
-- is enforced. Explicit rather than relying on the default.

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
  ON t.to_account_id = a.id OR t.from_account_id = a.id
GROUP BY a.id, a.name, a.is_spendable;

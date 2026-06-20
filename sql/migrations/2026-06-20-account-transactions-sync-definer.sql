-- 2026-06-20-account-transactions-sync-definer.sql
-- BUG: staff bookings with an initial payment fail 42501 RLS on account_transactions.
-- CAUSE: create_booking_with_rooms (INVOKER) -> payments insert -> trg_sync_account_transactions
--   -> fn_sync_account_transactions() (INVOKER) -> INSERT account_transactions (admin-only RLS)
--   runs as the staff caller, fails WITH CHECK, booking rolls back.
-- FIX: run the automatic mirror as SECURITY DEFINER so it bypasses admin-only RLS.
--   Manual daybook entries (direct client INSERT) stay admin-only via the unchanged policy.
ALTER FUNCTION public.fn_sync_account_transactions() SECURITY DEFINER;
ALTER FUNCTION public.fn_sync_account_transactions() SET search_path = public, pg_temp;

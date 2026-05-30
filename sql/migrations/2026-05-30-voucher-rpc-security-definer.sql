-- sql/migrations/2026-05-30-voucher-rpc-security-definer.sql
-- Hotfix during Phase 4C: change next_voucher_number() to SECURITY DEFINER.
--
-- ─── STATUS ───────────────────────────────────────────────────
-- APPLIED 2026-05-30 (Day 21) — ALTER FUNCTION SECURITY DEFINER applied.
-- Verified: prosecdef = true; SELECT public.next_voucher_number() returns EV-2026-NNNN.
-- ──────────────────────────────────────────────────────────────
--
-- Problem discovered Day 21 during Phase 4C smoke test:
--   When called from the authenticated role (the normal client path),
--   the function fails with "permission denied for schema public".
--   Root cause: the function body contains
--     EXECUTE format('CREATE SEQUENCE IF NOT EXISTS public.%I ...', ...)
--   which requires CREATE privilege on the public schema. The
--   authenticated role has USAGE but not CREATE on public, so the
--   CREATE SEQUENCE call fails on the permission check BEFORE the
--   IF NOT EXISTS short-circuit can apply.
--
-- Fix: SECURITY DEFINER mode. The function now runs with the
-- privileges of its owner (postgres), which has CREATE on public.
-- The function body's logic is unchanged.
--
-- Why this is safe:
--   - The function takes no user input. The year is read from
--     current_date inside the function; no user-controlled values
--     reach the dynamic SQL. No injection surface.
--   - The function's only side effects are creating year-scoped
--     sequences (if missing) and incrementing them. Neither is
--     dangerous; both are operations the system needs to do.
--   - SECURITY DEFINER is a standard Postgres pattern for functions
--     that need elevated privileges for legitimate reasons. The
--     anti-pattern is using DEFINER with user-input interpolation;
--     this function doesn't.
--
-- Day 19's migration (2026-05-23-voucher-number-sequence.sql) granted
-- EXECUTE on the function to authenticated; that's still correct.
-- This migration is purely the SECURITY DEFINER flip.
-- =============================================================

ALTER FUNCTION public.next_voucher_number() SECURITY DEFINER;

COMMENT ON FUNCTION public.next_voucher_number() IS
  'Returns the next sequential expense-voucher number for the current year, in the form EV-YYYY-NNNN. Auto-creates a per-year sequence (voucher_seq_YYYY) on first call of a new year. SECURITY DEFINER: runs with the owner''s (postgres) permissions so it can CREATE SEQUENCE in public when called from less-privileged roles like authenticated. Safe to DEFINER because the function takes no parameters and reads no user input.';

-- Verification queries — run AFTER applying:
--
--   SELECT proname, prosecdef FROM pg_proc
--     JOIN pg_namespace n ON n.oid = pronamespace
--     WHERE nspname = 'public' AND proname = 'next_voucher_number';
--   -- Expected: prosecdef = true (was false before this migration)
--
--   SELECT public.next_voucher_number();
--   -- Expected: 'EV-2026-NNNN' (next sequential value)

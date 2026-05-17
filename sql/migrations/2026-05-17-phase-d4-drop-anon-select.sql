-- =============================================================
-- 2026-05-17-phase-d4-drop-anon-select.sql
-- Phase D4 — drop the 8 remaining anon SELECT policies.
--
-- EXECUTE MANUALLY in Supabase SQL Editor after D3 is verified.
--
-- Context:
--   B1b (2026-05-17-phase-b1b-rls-lockdown.sql) created 8 narrow
--   anon SELECT policies so the invoice and reservation Server
--   Component pages could render. Those pages fetched via the
--   anon-key Supabase client because pre-D1 the server could not
--   see the browser's localStorage session.
--
--   The authentication workstream completed:
--     D1: converted browser client to @supabase/ssr cookie sessions
--     D2: added middleware for server-side route protection
--     D3: restored getUser() auth checks and authenticated fetch on
--         the invoice and reservation pages
--
--   As of D3, the document pages authenticate as the logged-in user.
--   Nothing in the application reads from the database as the anon
--   role. This migration removes the last anon surface, fully closing
--   issue #40 (anon write/delete was closed in B1b; anon SELECT is
--   closed here).
--
-- Post-migration expectation:
--   Zero anon policies on any table. The anon role can perform no
--   operation on any table in the public schema.
--
-- Post-migration verification query:
--   SELECT tablename, policyname, roles, cmd
--   FROM   pg_policies
--   WHERE  schemaname = 'public'
--     AND  'anon' = ANY(roles);
--   Expected: 0 rows.
-- =============================================================

BEGIN;

-- ── Section 1: DROP the 8 named anon SELECT policies by exact name ──────────
-- These are the policies created in B1b Section 3.
-- DROP POLICY IF EXISTS is safe to re-run if the policy was already removed.

DROP POLICY IF EXISTS "Anon can read bookings (document rendering - Phase D removal)"
  ON public.bookings;

DROP POLICY IF EXISTS "Anon can read guests (document rendering - Phase D removal)"
  ON public.guests;

DROP POLICY IF EXISTS "Anon can read booking_guests (document rendering - Phase D removal)"
  ON public.booking_guests;

DROP POLICY IF EXISTS "Anon can read booking_rooms (document rendering - Phase D removal)"
  ON public.booking_rooms;

DROP POLICY IF EXISTS "Anon can read rooms (document rendering - Phase D removal)"
  ON public.rooms;

DROP POLICY IF EXISTS "Anon can read booking_extra_charges (document rendering - Phase D removal)"
  ON public.booking_extra_charges;

DROP POLICY IF EXISTS "Anon can read payments (document rendering - Phase D removal)"
  ON public.payments;

DROP POLICY IF EXISTS "Anon can read refunds (document rendering - Phase D removal)"
  ON public.refunds;


-- ── Section 2: Safety net — drop any remaining anon policies dynamically ────
-- Guards against name drift (e.g. if a policy was recreated with a slightly
-- different name). Iterates pg_policies and drops any policy whose roles
-- array includes 'anon' on any public table. RAISE NOTICE per drop for
-- verification in the SQL Editor output.
-- Expected output: no rows (Section 1 already removed all anon policies).
-- If any NOTICE lines appear here, that indicates an unexpected anon policy
-- that was not covered by the named DROPs above.

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT schemaname, tablename, policyname
    FROM   pg_policies
    WHERE  schemaname = 'public'
      AND  'anon' = ANY(roles)
    ORDER BY tablename, policyname
  LOOP
    EXECUTE format(
      'DROP POLICY IF EXISTS %I ON %I.%I',
      r.policyname, r.schemaname, r.tablename
    );
    RAISE NOTICE 'Safety net dropped anon policy: % on %.%',
      r.policyname, r.schemaname, r.tablename;
  END LOOP;
END
$$;

COMMIT;

-- Post-migration: update sql/schema/06-rls-policies.sql to remove the
-- Section 2 anon policies block. The file should contain only the 38
-- authenticated policies and the 2 profiles policies (40 total).

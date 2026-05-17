-- =============================================================
-- 2026-05-17-phase-b1b-rls-lockdown.sql
-- Phase B (Authentication) — RLS overhaul: drop all non-profiles
-- policies, recreate clean authenticated-only policies, preserve
-- a narrow anon SELECT surface for the invoice/reservation Server
-- Component pages.
--
-- EXECUTE MANUALLY in Supabase SQL Editor after B1a is verified.
-- DO NOT run via migration tooling — requires DBA review first.
--
-- ── Policy counts ───────────────────────────────────────────────
--   Pre-migration non-profiles policies (live DB) : 51
--   RAISE NOTICE drop count                       : 51
--   Post-migration authenticated policies          : 38
--   Post-migration anon SELECT policies            : 8
--   Post-migration total (non-profiles)            : 46
--
-- ── Why a transaction ──────────────────────────────────────────
--   Between dropping all policies and recreating them there is a
--   window with no policies on RLS-enabled tables — PostgreSQL
--   denies all access in that window. BEGIN/COMMIT makes it
--   invisible to the application.
--
-- ── Tables covered ────────────────────────────────────────────
--   bookings, booking_rooms, booking_guests, booking_documents,
--   booking_extra_charges, rooms, guests, employees,
--   payments, refunds
--
-- ── Tables intentionally excluded ────────────────────────────
--   profiles — existing policies are correct and authoritative;
--              excluding avoids dropping user-management policies.
--   employees, booking_documents — get authenticated CRUD only;
--              no anon access needed or granted.
--
-- ── Anon SELECT surface (Phase D backlog) ─────────────────────
--   Eight tables retain a narrow anon SELECT policy to support
--   the invoice and reservation Server Component pages, which
--   fetch via the anon-key supabase client (lib/supabase.ts).
--   These eight anon SELECT policies are TEMPORARY. Phase D will:
--     1. Convert the browser client to createBrowserClient from
--        @supabase/ssr (cookie-based session storage).
--     2. Enable the serverClient.auth.getUser() check that was
--        drafted in lib/supabaseServer.ts and reverted in B1a.
--     3. Drop these eight anon SELECT policies, restoring a
--        fully authenticated-only RLS surface.
--   Track as: Phase D — remove anon SELECT (8 policies)
-- =============================================================

BEGIN;

-- ── Section 1: Drop ALL existing policies on all public tables
--              except profiles. RAISE NOTICE per drop for
--              verification — expected count: 51. ─────────────
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT schemaname, tablename, policyname
    FROM   pg_policies
    WHERE  schemaname = 'public'
      AND  tablename  <> 'profiles'
    ORDER BY tablename, policyname
  LOOP
    EXECUTE format(
      'DROP POLICY IF EXISTS %I ON %I.%I',
      r.policyname, r.schemaname, r.tablename
    );
    RAISE NOTICE 'Dropped policy % on %.%',
      r.policyname, r.schemaname, r.tablename;
  END LOOP;
END
$$;


-- ── Section 2: Clean authenticated-only policies (38 total) ──
--
-- Naming convention: "Authenticated can <verb> <table>"
-- Full CRUD on all tables except:
--   booking_documents — no UPDATE (documents are immutable once created)
--   refunds           — no DELETE (permanent audit trail)

-- bookings (4)
CREATE POLICY "Authenticated can select bookings"
  ON public.bookings FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated can insert bookings"
  ON public.bookings FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated can update bookings"
  ON public.bookings FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated can delete bookings"
  ON public.bookings FOR DELETE TO authenticated USING (true);

-- booking_rooms (4)
CREATE POLICY "Authenticated can select booking_rooms"
  ON public.booking_rooms FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated can insert booking_rooms"
  ON public.booking_rooms FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated can update booking_rooms"
  ON public.booking_rooms FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated can delete booking_rooms"
  ON public.booking_rooms FOR DELETE TO authenticated USING (true);

-- booking_guests (4)
CREATE POLICY "Authenticated can select booking_guests"
  ON public.booking_guests FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated can insert booking_guests"
  ON public.booking_guests FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated can update booking_guests"
  ON public.booking_guests FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated can delete booking_guests"
  ON public.booking_guests FOR DELETE TO authenticated USING (true);

-- booking_documents (3 — no UPDATE: documents are immutable once uploaded)
CREATE POLICY "Authenticated can select booking_documents"
  ON public.booking_documents FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated can insert booking_documents"
  ON public.booking_documents FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated can delete booking_documents"
  ON public.booking_documents FOR DELETE TO authenticated USING (true);

-- booking_extra_charges (4)
CREATE POLICY "Authenticated can select booking_extra_charges"
  ON public.booking_extra_charges FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated can insert booking_extra_charges"
  ON public.booking_extra_charges FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated can update booking_extra_charges"
  ON public.booking_extra_charges FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated can delete booking_extra_charges"
  ON public.booking_extra_charges FOR DELETE TO authenticated USING (true);

-- rooms (4)
CREATE POLICY "Authenticated can select rooms"
  ON public.rooms FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated can insert rooms"
  ON public.rooms FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated can update rooms"
  ON public.rooms FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated can delete rooms"
  ON public.rooms FOR DELETE TO authenticated USING (true);

-- guests (4)
CREATE POLICY "Authenticated can select guests"
  ON public.guests FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated can insert guests"
  ON public.guests FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated can update guests"
  ON public.guests FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated can delete guests"
  ON public.guests FOR DELETE TO authenticated USING (true);

-- employees (4)
CREATE POLICY "Authenticated can select employees"
  ON public.employees FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated can insert employees"
  ON public.employees FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated can update employees"
  ON public.employees FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated can delete employees"
  ON public.employees FOR DELETE TO authenticated USING (true);

-- payments (4)
-- Note: UPDATE policy was missing from the live DB prior to B1b,
-- which caused disburse_refund silent failures (Day 12 / issue #19).
CREATE POLICY "Authenticated can select payments"
  ON public.payments FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated can insert payments"
  ON public.payments FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated can update payments"
  ON public.payments FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated can delete payments"
  ON public.payments FOR DELETE TO authenticated USING (true);

-- refunds (3 — no DELETE: permanent audit trail)
CREATE POLICY "Authenticated can select refunds"
  ON public.refunds FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated can insert refunds"
  ON public.refunds FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated can update refunds"
  ON public.refunds FOR UPDATE TO authenticated USING (true) WITH CHECK (true);


-- ── Section 3: Narrow anon SELECT surface (8 policies) ────────
--
-- PURPOSE: the invoice (/bookings/[id]/invoice) and reservation
-- (/bookings/[id]/reservation) pages are Next.js Server Components
-- that fetch via lib/supabase.ts — the legacy createClient singleton
-- which stores sessions in localStorage. The server-side fetch has
-- no access to localStorage, so it runs as the anon role.
--
-- These eight SELECT-only policies are the minimum required for
-- those two pages to render. No anon INSERT/UPDATE/DELETE is granted
-- anywhere. employees and booking_documents get no anon access.
--
-- SCHEDULED FOR REMOVAL in Phase D:
--   Phase D converts lib/supabase.ts to createBrowserClient (@supabase/ssr),
--   moving session storage to cookies. Once cookies carry the JWT,
--   lib/supabaseServer.ts can authenticate server-side fetches, and
--   these eight policies can be dropped.

CREATE POLICY "Anon can read bookings (document rendering - Phase D removal)"
  ON public.bookings FOR SELECT TO anon USING (true);

CREATE POLICY "Anon can read guests (document rendering - Phase D removal)"
  ON public.guests FOR SELECT TO anon USING (true);

CREATE POLICY "Anon can read booking_guests (document rendering - Phase D removal)"
  ON public.booking_guests FOR SELECT TO anon USING (true);

CREATE POLICY "Anon can read booking_rooms (document rendering - Phase D removal)"
  ON public.booking_rooms FOR SELECT TO anon USING (true);

CREATE POLICY "Anon can read rooms (document rendering - Phase D removal)"
  ON public.rooms FOR SELECT TO anon USING (true);

CREATE POLICY "Anon can read booking_extra_charges (document rendering - Phase D removal)"
  ON public.booking_extra_charges FOR SELECT TO anon USING (true);

CREATE POLICY "Anon can read payments (document rendering - Phase D removal)"
  ON public.payments FOR SELECT TO anon USING (true);

CREATE POLICY "Anon can read refunds (document rendering - Phase D removal)"
  ON public.refunds FOR SELECT TO anon USING (true);

COMMIT;

-- Post-migration verification query:
--   SELECT tablename, policyname, roles, cmd
--   FROM   pg_policies
--   WHERE  schemaname = 'public' AND tablename <> 'profiles'
--   ORDER BY tablename, cmd, roles;
-- Expected: 46 rows (38 authenticated + 8 anon).

-- =============================================================
-- 06-rls-policies.sql
-- Row Level Security — authoritative post-E1 state.
--
-- Last updated: 2026-05-19 (Accounts core Stage 1)
--   Migration: 2026-05-18-accounts-core-stage1.sql
--
-- History:
--   2026-05-17 B1b: full overhaul — dropped 51 legacy policies,
--              recreated 38 authenticated + 8 temporary anon SELECT.
--              Closed doc-drift (#19). Partially closed #40.
--   2026-05-18 D4: dropped the 8 anon SELECT policies. The anon
--              role now has no access to any table. #40 fully closed.
--   2026-05-18 E1: added current_user_role() helper; employees policies
--              split into role-aware variants (admin-all / staff-own-row).
--   2026-05-19 Accounts Stage 1: RLS on accounts + account_transactions;
--              5 admin-only policies (SELECT admin-only; no write policies
--              from authenticated role — seeding uses service_role).
--
-- ── Security model ────────────────────────────────────────────
--   authenticated role  — hotel staff / admin with a Supabase login.
--                         Full CRUD on all operational tables.
--                         Row-level ownership (admin vs staff) is
--                         enforced by current_user_role() in RLS.
--   anon role           — NO access to any table. The anon key
--                         ships in the frontend but RLS blocks all
--                         database operations for unauthenticated
--                         requests.
--   service_role        — bypasses RLS entirely (not used by app).
--
-- ── Authenticated policy count: 38 ───────────────────────────
--   rooms (4), guests (4), employees (4), bookings (4),
--   payments (4), booking_guests (4), booking_documents (3),
--   booking_rooms (4), booking_extra_charges (4), refunds (3)
--   employees: SELECT/UPDATE allow staff to access own row (for /profile);
--              INSERT/DELETE are admin-only.
--   booking_documents: no UPDATE (immutable once uploaded)
--   refunds:           no DELETE (permanent audit trail)
--
-- ── Profiles policy count: 2 (scoped to own row) ─────────────
--
-- ── Accounts policy count: 5 (admin-only) ────────────────────
--   accounts (1 SELECT), account_transactions (4)
--   No write policies from authenticated role on accounts —
--   the 4 bucket rows are seeded via service_role (bypasses RLS).
--   account_transactions: SELECT/INSERT/UPDATE/DELETE admin-only.
--
-- ── Total: 45 policies. Zero anon policies. ──────────────────
-- =============================================================


-- =============================================================
-- SECTION 0 — RLS helper functions
-- =============================================================

-- ── current_user_role() ───────────────────────────────────────
-- Returns the calling user's role ('admin' | 'staff') from
-- public.profiles. Returns NULL if no profile row exists.
--
-- STABLE SECURITY DEFINER: executes as owner, bypassing the
-- caller's RLS on profiles (which restricts reads to own row).
-- SET search_path guards against search-path injection.
--
-- Use this in all admin-only RLS policies:
--   USING (current_user_role() = 'admin')
-- =============================================================
CREATE OR REPLACE FUNCTION public.current_user_role()
  RETURNS TEXT
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public
AS $$
  SELECT role FROM public.profiles WHERE id = auth.uid()
$$;


-- ── RLS enable (idempotent — safe to re-run) ─────────────────
ALTER TABLE public.rooms                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.guests                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employees              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bookings               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payments               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.booking_guests         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.booking_documents      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.booking_rooms          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.booking_extra_charges  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.refunds                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounts               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_transactions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.room_categories        ENABLE ROW LEVEL SECURITY;


-- =============================================================
-- SECTION 1 — Authenticated policies (38)
-- =============================================================

-- ─────────────────────────────────────────────────────────────
-- bookings (4)
-- ─────────────────────────────────────────────────────────────
CREATE POLICY "Authenticated can select bookings"
  ON public.bookings FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated can insert bookings"
  ON public.bookings FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated can update bookings"
  ON public.bookings FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated can delete bookings"
  ON public.bookings FOR DELETE TO authenticated USING (true);

-- ─────────────────────────────────────────────────────────────
-- booking_rooms (4)
-- ─────────────────────────────────────────────────────────────
CREATE POLICY "Authenticated can select booking_rooms"
  ON public.booking_rooms FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated can insert booking_rooms"
  ON public.booking_rooms FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated can update booking_rooms"
  ON public.booking_rooms FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated can delete booking_rooms"
  ON public.booking_rooms FOR DELETE TO authenticated USING (true);

-- ─────────────────────────────────────────────────────────────
-- booking_guests (4)
-- ─────────────────────────────────────────────────────────────
CREATE POLICY "Authenticated can select booking_guests"
  ON public.booking_guests FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated can insert booking_guests"
  ON public.booking_guests FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated can update booking_guests"
  ON public.booking_guests FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated can delete booking_guests"
  ON public.booking_guests FOR DELETE TO authenticated USING (true);

-- ─────────────────────────────────────────────────────────────
-- booking_documents (3 — no UPDATE: documents are immutable
--   once uploaded; delete and re-upload to replace)
-- ─────────────────────────────────────────────────────────────
CREATE POLICY "Authenticated can select booking_documents"
  ON public.booking_documents FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated can insert booking_documents"
  ON public.booking_documents FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated can delete booking_documents"
  ON public.booking_documents FOR DELETE TO authenticated USING (true);

-- ─────────────────────────────────────────────────────────────
-- booking_extra_charges (4)
-- ─────────────────────────────────────────────────────────────
CREATE POLICY "Authenticated can select booking_extra_charges"
  ON public.booking_extra_charges FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated can insert booking_extra_charges"
  ON public.booking_extra_charges FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated can update booking_extra_charges"
  ON public.booking_extra_charges FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated can delete booking_extra_charges"
  ON public.booking_extra_charges FOR DELETE TO authenticated USING (true);

-- ─────────────────────────────────────────────────────────────
-- rooms (4)
-- ─────────────────────────────────────────────────────────────
CREATE POLICY "Authenticated can select rooms"
  ON public.rooms FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated can insert rooms"
  ON public.rooms FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated can update rooms"
  ON public.rooms FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated can delete rooms"
  ON public.rooms FOR DELETE TO authenticated USING (true);

-- ─────────────────────────────────────────────────────────────
-- guests (4)
-- ─────────────────────────────────────────────────────────────
CREATE POLICY "Authenticated can select guests"
  ON public.guests FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated can insert guests"
  ON public.guests FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated can update guests"
  ON public.guests FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated can delete guests"
  ON public.guests FOR DELETE TO authenticated USING (true);

-- ─────────────────────────────────────────────────────────────
-- employees (4)
-- SELECT/UPDATE: admin sees/edits any row; staff sees/edits own row
-- only (own row = employees.auth_user_id = auth.uid(), used by the
-- self-service /profile page — accessible to both roles).
-- INSERT/DELETE: admin only — staff have no use case for these.
-- ─────────────────────────────────────────────────────────────
CREATE POLICY "Employees select — admin all, staff own row"
  ON public.employees FOR SELECT TO authenticated
  USING (
    current_user_role() = 'admin'
    OR auth_user_id = auth.uid()
  );
CREATE POLICY "Employees insert — admin only"
  ON public.employees FOR INSERT TO authenticated
  WITH CHECK (current_user_role() = 'admin');
CREATE POLICY "Employees update — admin all, staff own row"
  ON public.employees FOR UPDATE TO authenticated
  USING (
    current_user_role() = 'admin'
    OR auth_user_id = auth.uid()
  )
  WITH CHECK (
    current_user_role() = 'admin'
    OR auth_user_id = auth.uid()
  );
CREATE POLICY "Employees delete — admin only"
  ON public.employees FOR DELETE TO authenticated
  USING (current_user_role() = 'admin');

-- ─────────────────────────────────────────────────────────────
-- payments (4)
-- Note: UPDATE policy was missing from the live DB prior to B1b,
-- which caused disburse_refund silent failures (Day 12 / issue #19).
-- ─────────────────────────────────────────────────────────────
CREATE POLICY "Authenticated can select payments"
  ON public.payments FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated can insert payments"
  ON public.payments FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated can update payments"
  ON public.payments FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated can delete payments"
  ON public.payments FOR DELETE TO authenticated USING (true);

-- ─────────────────────────────────────────────────────────────
-- refunds (3 — no DELETE: permanent audit trail;
--   disbursement is tracked via status UPDATE, not row deletion)
-- ─────────────────────────────────────────────────────────────
CREATE POLICY "Authenticated can select refunds"
  ON public.refunds FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated can insert refunds"
  ON public.refunds FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated can update refunds"
  ON public.refunds FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

-- ─────────────────────────────────────────────────────────────
-- profiles (2 — scoped to own row; untouched by B1b/D4/E1)
-- ─────────────────────────────────────────────────────────────
CREATE POLICY "Users can read own profile"
  ON public.profiles FOR SELECT TO authenticated
  USING (id = auth.uid());
CREATE POLICY "Users can update own profile"
  ON public.profiles FOR UPDATE TO authenticated
  USING (id = auth.uid());


-- =============================================================
-- SECTION 2 — Accounts policies (5) — admin-only
-- Added: 2026-05-19  Migration: 2026-05-18-accounts-core-stage1.sql
-- =============================================================
--
-- The entire Accounts feature is admin-only (architecture Section 9).
-- current_user_role() = 'admin' is the enforced pattern.
--
-- accounts table: SELECT admin-only. No INSERT/UPDATE/DELETE policies
-- for authenticated role — the 4 seed rows are inserted via
-- service_role (bypasses RLS). App never creates or deletes buckets.
--
-- account_transactions: full CRUD admin-only.
-- ─────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────────────────────────
-- accounts (1 — SELECT only; no write policies for authenticated)
-- ─────────────────────────────────────────────────────────────
CREATE POLICY "Accounts select — admin only"
  ON public.accounts FOR SELECT TO authenticated
  USING (current_user_role() = 'admin');

-- ─────────────────────────────────────────────────────────────
-- account_transactions (4)
-- ─────────────────────────────────────────────────────────────
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
-- SECTION 3 — Room categories policies (3)
-- Added: 2026-06-07  Migration: 2026-06-07-room-categories-rls.sql
-- =============================================================
CREATE POLICY "Room categories select — authenticated"
  ON public.room_categories FOR SELECT TO authenticated
  USING (true);
CREATE POLICY "Room categories insert — admin only"
  ON public.room_categories FOR INSERT TO authenticated
  WITH CHECK (current_user_role() = 'admin');
CREATE POLICY "Room categories update — admin only"
  ON public.room_categories FOR UPDATE TO authenticated
  USING (current_user_role() = 'admin')
  WITH CHECK (current_user_role() = 'admin');

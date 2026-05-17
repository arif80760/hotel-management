-- =============================================================
-- 06-rls-policies.sql
-- Row Level Security — authoritative post-D4 state.
--
-- Last updated: 2026-05-18 (Phase D authentication workstream)
--   Migration: 2026-05-17-phase-d4-drop-anon-select.sql
--
-- History:
--   2026-05-17 B1b: full overhaul — dropped 51 legacy policies,
--              recreated 38 authenticated + 8 temporary anon SELECT.
--              Closed doc-drift (#19). Partially closed #40.
--   2026-05-18 D4: dropped the 8 anon SELECT policies. The anon
--              role now has no access to any table. #40 fully closed.
--
-- ── Security model ────────────────────────────────────────────
--   authenticated role  — hotel staff / admin with a Supabase login.
--                         Full CRUD on all operational tables.
--                         Row-level ownership (admin vs staff) is
--                         enforced in the application layer.
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
--   booking_documents: no UPDATE (immutable once uploaded)
--   refunds:           no DELETE (permanent audit trail)
--
-- ── Profiles policy count: 2 (scoped to own row) ─────────────
--
-- ── Total: 40 policies. Zero anon policies. ──────────────────
-- =============================================================


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
-- ─────────────────────────────────────────────────────────────
CREATE POLICY "Authenticated can select employees"
  ON public.employees FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated can insert employees"
  ON public.employees FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated can update employees"
  ON public.employees FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated can delete employees"
  ON public.employees FOR DELETE TO authenticated USING (true);

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
-- profiles (2 — scoped to own row; untouched by B1b/D4)
-- ─────────────────────────────────────────────────────────────
CREATE POLICY "Users can read own profile"
  ON public.profiles FOR SELECT TO authenticated
  USING (id = auth.uid());
CREATE POLICY "Users can update own profile"
  ON public.profiles FOR UPDATE TO authenticated
  USING (id = auth.uid());

-- =============================================================
-- 06-rls-policies.sql
-- Row Level Security policies for all public tables.
--
-- Exported: 2026-05-07  (reconstructed from:
--   • create_booking_documents_table.sql (authoritative)
--   • Observed app behaviour — all CRUD routes use the
--     service role key, which bypasses RLS; RLS therefore
--     acts as a safety net rather than primary auth gate)
--
-- Current security model:
--   • Service role key  — bypasses RLS entirely (used by app)
--   • Anon key          — blocked by default RLS (public users)
--   • Authenticated     — hotel staff / admin with a login
--
-- All policies below follow a simple pattern:
--   SELECT / INSERT / UPDATE / DELETE → authenticated users only.
-- Finer-grained role checks (admin vs staff) are enforced in
-- the application layer, not in RLS.
-- =============================================================


-- ── RLS on / off ─────────────────────────────────────────────
ALTER TABLE public.rooms              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.guests             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employees          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bookings           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payments           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.booking_guests     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.booking_documents  ENABLE ROW LEVEL SECURITY;


-- ─────────────────────────────────────────────────────────────
-- rooms
-- ─────────────────────────────────────────────────────────────
CREATE POLICY "Authenticated can read rooms"
  ON public.rooms FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated can insert rooms"
  ON public.rooms FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "Authenticated can update rooms"
  ON public.rooms FOR UPDATE TO authenticated USING (true);

CREATE POLICY "Authenticated can delete rooms"
  ON public.rooms FOR DELETE TO authenticated USING (true);


-- ─────────────────────────────────────────────────────────────
-- guests
-- ─────────────────────────────────────────────────────────────
CREATE POLICY "Authenticated can read guests"
  ON public.guests FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated can insert guests"
  ON public.guests FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "Authenticated can update guests"
  ON public.guests FOR UPDATE TO authenticated USING (true);

CREATE POLICY "Authenticated can delete guests"
  ON public.guests FOR DELETE TO authenticated USING (true);


-- ─────────────────────────────────────────────────────────────
-- profiles
-- ─────────────────────────────────────────────────────────────
CREATE POLICY "Users can read own profile"
  ON public.profiles FOR SELECT TO authenticated
  USING (id = auth.uid());

CREATE POLICY "Users can update own profile"
  ON public.profiles FOR UPDATE TO authenticated
  USING (id = auth.uid());


-- ─────────────────────────────────────────────────────────────
-- employees
-- ─────────────────────────────────────────────────────────────
CREATE POLICY "Authenticated can read employees"
  ON public.employees FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated can insert employees"
  ON public.employees FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "Authenticated can update employees"
  ON public.employees FOR UPDATE TO authenticated USING (true);

CREATE POLICY "Authenticated can delete employees"
  ON public.employees FOR DELETE TO authenticated USING (true);


-- ─────────────────────────────────────────────────────────────
-- bookings
-- ─────────────────────────────────────────────────────────────
CREATE POLICY "Authenticated can read bookings"
  ON public.bookings FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated can insert bookings"
  ON public.bookings FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "Authenticated can update bookings"
  ON public.bookings FOR UPDATE TO authenticated USING (true);

CREATE POLICY "Authenticated can delete bookings"
  ON public.bookings FOR DELETE TO authenticated USING (true);


-- ─────────────────────────────────────────────────────────────
-- payments
-- ─────────────────────────────────────────────────────────────
CREATE POLICY "Authenticated can read payments"
  ON public.payments FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated can insert payments"
  ON public.payments FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "Authenticated can update payments"
  ON public.payments FOR UPDATE TO authenticated USING (true);

CREATE POLICY "Authenticated can delete payments"
  ON public.payments FOR DELETE TO authenticated USING (true);


-- ─────────────────────────────────────────────────────────────
-- booking_guests
-- ─────────────────────────────────────────────────────────────
CREATE POLICY "Authenticated can read booking_guests"
  ON public.booking_guests FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated can insert booking_guests"
  ON public.booking_guests FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "Authenticated can update booking_guests"
  ON public.booking_guests FOR UPDATE TO authenticated USING (true);

CREATE POLICY "Authenticated can delete booking_guests"
  ON public.booking_guests FOR DELETE TO authenticated USING (true);


-- ─────────────────────────────────────────────────────────────
-- booking_documents  ← AUTHORITATIVE from create_booking_documents_table.sql
-- ─────────────────────────────────────────────────────────────
CREATE POLICY "Authenticated can read booking documents"
  ON public.booking_documents FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated can insert booking documents"
  ON public.booking_documents FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "Authenticated can delete booking documents"
  ON public.booking_documents FOR DELETE TO authenticated USING (true);

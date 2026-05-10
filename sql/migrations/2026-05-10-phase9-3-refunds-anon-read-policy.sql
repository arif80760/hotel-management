-- ============================================================
-- Phase 9.3: anon SELECT policy for refunds table
--
-- Invoice route (/bookings/[id]/invoice) is a Server Component
-- that executes with the anon role. It calls listRefunds() to
-- render disbursed refunds in the document. Existing policy on
-- refunds is authenticated-only; without this addition, anon
-- gets an empty array silently (no error, no data).
--
-- Matches the pattern on bookings, guests, payments, rooms,
-- booking_guests, booking_rooms, booking_extra_charges — all
-- already anon-readable for document rendering.
-- ============================================================

CREATE POLICY "Anon can read refunds"
  ON public.refunds FOR SELECT TO anon USING (true);

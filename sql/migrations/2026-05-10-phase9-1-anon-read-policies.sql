-- ============================================================
-- Phase 9.1: anon SELECT policies for document rendering tables
--
-- Document routes (/bookings/[id]/reservation, /invoice) are
-- Server Components that execute with the anon role. They read
-- booking_rooms and booking_extra_charges to render multi-room
-- documents. Existing policies were authenticated-only.
--
-- Matches the pattern on bookings, guests, booking_guests,
-- payments, and rooms — all already anon-readable for the same
-- reason. Phase 10 emailed document links rely on this posture.
--
-- Investigation (2026-05-10):
--   anon SELECT probe results:
--     rooms                  ✅ already anon-readable
--     guests                 ✅ already anon-readable
--     bookings               ✅ already anon-readable
--     booking_guests         ✅ already anon-readable
--     payments               ✅ already anon-readable
--     booking_rooms          ❌ authenticated-only → THIS MIGRATION
--     booking_extra_charges  ❌ authenticated-only → THIS MIGRATION
--
-- Note: sql/schema/06-rls-policies.sql is stale — the live DB
-- already has anon SELECT on the five tables above. That file
-- needs a separate sync; it is not authoritative.
--
-- Single run. No DDL/DML ordering constraints.
-- ============================================================

-- booking_rooms: allow anon reads (needed for Server Component document routes)
CREATE POLICY "Anon can read booking_rooms"
  ON public.booking_rooms FOR SELECT TO anon USING (true);

-- booking_extra_charges: same
CREATE POLICY "Anon can read booking_extra_charges"
  ON public.booking_extra_charges FOR SELECT TO anon USING (true);

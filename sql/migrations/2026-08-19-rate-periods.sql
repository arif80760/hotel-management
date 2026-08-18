-- =============================================================
-- 2026-08-19-rate-periods.sql
-- Rate calendar: seasonal/event pricing periods per room category.
--
-- RECORD OF LIVE STATE — applied and verified in the Supabase SQL
-- editor on 2026-08-19. The exclusion constraint was exercised live:
-- an overlapping deluxe period was correctly rejected with 23P01 on
-- rate_periods_no_overlap (test rows cleaned up). room_categories.slug
-- carries UNIQUE (room_categories_slug_key), so the FK is sound.
--
-- ⚠ FK LOCK (recorded so it is discovered by reading, not by a failed
-- rename): the FK on room_categories(slug) means a category slug can
-- NOT be renamed or deleted while rate periods reference it. Slugs are
-- already immutable by convention (CLAUDE.md Pricing Architecture:
-- "never change a slug") — this constraint now enforces that
-- convention physically wherever a rate period exists.
--
-- DESIGN:
--   • end_date is INCLUSIVE — a period "covers" its end date, matching
--     the booking-form rule (period applies when it covers check-in).
--   • The EXCLUDE constraint (btree_gist) forbids overlapping ACTIVE
--     periods per category; is_active=false rows stop blocking, so a
--     mistake is retired-and-replaced, never deleted.
--   • Rate periods change ONLY the booking form's PREFILLED default:
--     manual entry > covering period > category price. The min-rate
--     floor is untouched, existing bookings never recalculate, and
--     create_booking_with_rooms is deliberately NOT modified — derived
--     nights + the total check remain the server enforcement point.
--   • RLS: authenticated may READ (staff booking-form prefill);
--     writes admin-only via the existing is_admin() helper.
-- =============================================================

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE public.rate_periods (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category    text NOT NULL REFERENCES public.room_categories(slug),
  start_date  date NOT NULL,
  end_date    date NOT NULL,          -- INCLUSIVE (a period "covers" its end date)
  rate        numeric NOT NULL CHECK (rate > 0),
  label       text NOT NULL,          -- "Eid Peak", "December High Season"
  is_active   boolean NOT NULL DEFAULT true,   -- deactivate instead of delete
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date >= start_date),
  CONSTRAINT rate_periods_no_overlap EXCLUDE USING gist (
    category WITH =,
    daterange(start_date, end_date, '[]') WITH &&
  ) WHERE (is_active)
);

ALTER TABLE public.rate_periods ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated can read rate_periods"
  ON public.rate_periods FOR SELECT TO authenticated USING (true);
CREATE POLICY "Admins manage rate_periods"
  ON public.rate_periods FOR ALL TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());

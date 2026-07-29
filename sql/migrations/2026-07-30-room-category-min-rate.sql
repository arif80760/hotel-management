-- =============================================================
-- 2026-07-30-room-category-min-rate.sql
-- Per-category MINIMUM booking rate (floor price).
--
-- WHY:
--   Receptionists could book a room at any rate. This adds an optional
--   per-category floor so staff cannot book below it. Admins may still
--   book below the floor (warn-and-allow confirm in the UI).
--
-- NULLABLE BY DESIGN:
--   min_rate IS NULL  → no floor for that category (existing behaviour,
--   which is what every category gets until an admin sets one). Only a
--   non-null value is enforced, so this migration is a no-op for all
--   current data.
--
-- ENFORCEMENT LOCATION:
--   Client-side only, in the booking form (app/bookings/BookingsClient.tsx).
--   create_booking_with_rooms does total/overlap validation but has never
--   validated the per-room rate; adding a floor RAISE there would also
--   require plumbing an admin-override parameter through the RPC, which
--   this change deliberately does not do. See the feature notes.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + guarded constraint add.
-- =============================================================

ALTER TABLE public.room_categories
  ADD COLUMN IF NOT EXISTS min_rate numeric;

COMMENT ON COLUMN public.room_categories.min_rate IS
  'Optional floor price per night (BDT). NULL = no floor. Staff cannot book below it; admins can override.';

-- min_rate must be >= 0 when set. Guarded so re-running is safe.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_room_categories_min_rate'
      AND conrelid = 'public.room_categories'::regclass
  ) THEN
    ALTER TABLE public.room_categories
      ADD CONSTRAINT chk_room_categories_min_rate
      CHECK (min_rate IS NULL OR min_rate >= 0);
  END IF;
END $$;

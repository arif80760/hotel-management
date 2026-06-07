-- =============================================================
-- 2026-06-07-room-categories-table.sql
-- Stage A of dynamic room categories.
-- Creates the managed room_categories lookup table, seeded from
-- the five values currently in the room_category enum.
-- Purely additive — nothing references this table yet, so this
-- migration cannot affect existing behaviour. The enum-to-text
-- conversion happens in a separate, later migration.
-- =============================================================

CREATE TABLE IF NOT EXISTS public.room_categories (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        TEXT         NOT NULL UNIQUE,   -- stable key: 'single', 'double', ...
  name        TEXT         NOT NULL,          -- display label: 'Single', 'Double', ...
  sort_order  SMALLINT     NOT NULL DEFAULT 0,
  is_active   BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.room_categories IS
  'Managed list of room categories. Replaces the room_category enum. '
  'slug is the stable key stored on rooms.category and in booking snapshots; '
  'name is the editable display label. Retire a category with is_active=false '
  '(never hard-delete one that rooms still reference).';

INSERT INTO public.room_categories (slug, name, sort_order) VALUES
  ('single', 'Single', 1),
  ('double', 'Double', 2),
  ('deluxe', 'Deluxe', 3),
  ('suite',  'Suite',  4),
  ('family', 'Family', 5)
ON CONFLICT (slug) DO NOTHING;

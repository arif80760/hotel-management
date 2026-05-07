-- =============================================================
-- 01-types.sql
-- Custom PostgreSQL enum types used across all tables.
--
-- Exported: 2026-05-07  (reconstructed from observed schema)
--
-- All types live in the public schema.
-- Changes to enum values require ALTER TYPE … ADD VALUE — you
-- cannot DROP a value from a live enum without recreating it.
-- =============================================================

-- ── room_category ────────────────────────────────────────────
-- Lowercase values stored in DB; frontend capitalises for display.
-- Room categories as defined in the live room catalog.
CREATE TYPE public.room_category AS ENUM (
  'single',
  'double',
  'deluxe',
  'suite',
  'family'
);

-- ── room_status ──────────────────────────────────────────────
-- Occupancy state of a physical room.
-- Maintained automatically by trigger fn_sync_room_status.
CREATE TYPE public.room_status AS ENUM (
  'available',
  'reserved',    -- confirmed booking, guest not yet arrived
  'occupied',    -- guest checked in
  'cleaning',    -- guest checked out, room being turned over
  'maintenance'  -- room taken offline by staff
);

-- ── booking_status ───────────────────────────────────────────
-- Lifecycle state of a booking record.
-- Transitions: confirmed → checked_in → checked_out
--                       ↘ cancelled
CREATE TYPE public.booking_status AS ENUM (
  'confirmed',
  'checked_in',
  'checked_out',
  'cancelled'
);

-- ── payment_status ───────────────────────────────────────────
-- Derived from paid_amount vs total_amount.
-- Maintained automatically by trigger fn_sync_payment_status.
CREATE TYPE public.payment_status AS ENUM (
  'unpaid',    -- paid_amount = 0
  'partial',   -- 0 < paid_amount < total_amount
  'paid'       -- paid_amount >= total_amount
);

-- ── payment_method ───────────────────────────────────────────
-- Accepted payment methods.
-- 'bkash' and 'nagad' were added via migration add_payment_method_extras.sql.
-- Legacy values ('online', 'other') may still exist in old payment rows.
CREATE TYPE public.payment_method AS ENUM (
  'cash',
  'card',
  'bank_transfer',
  'bkash',
  'nagad',
  'online',     -- legacy — use 'card' for new payments
  'other'       -- legacy — use most-specific method for new payments
);

-- =============================================================
-- 01-types.sql
-- Custom PostgreSQL enum types used across all tables.
--
-- Exported: 2026-05-07  (reconstructed from observed schema)
-- Updated:  2026-05-08  — booking_status extended with 'checked_out_early'
--                         via migration 2026-05-08-multi-room-enum-prep.sql
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
-- Previously maintained by trigger fn_sync_room_status (retired 2026-05-08).
-- Now maintained by app-layer RPCs (checkout_booking_room, cancel_booking_room, etc.).
CREATE TYPE public.room_status AS ENUM (
  'available',
  'reserved',    -- confirmed booking, guest not yet arrived
  'occupied',    -- guest checked in
  'cleaning',    -- guest checked out, room being turned over
  'maintenance'  -- room taken offline by staff
);

-- ── booking_status ───────────────────────────────────────────
-- Lifecycle state of a booking record (bookings.status) and
-- per-room stay record (booking_rooms.status).
-- 'checked_out_early' added 2026-05-08 via multi-room-enum-prep.sql.
--
-- Booking-level transitions:
--   confirmed → checked_in → checked_out
--            ↘ cancelled
--
-- Room-level transitions (booking_rooms.status):
--   confirmed → checked_in → checked_out
--            ↘ cancelled          ↘ checked_out_early
CREATE TYPE public.booking_status AS ENUM (
  'confirmed',
  'checked_in',
  'checked_out',
  'checked_out_early',   -- room-level only: guest departed before scheduled check_out_date
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

-- ── account_transaction_type ─────────────────────────────────
-- The six distinct money-movement types in the Accounts feature.
-- Direction is expressed by from_account_id / to_account_id:
--   inbound  types → to_account_id NOT NULL, from_account_id NULL
--   outbound types → from_account_id NOT NULL, to_account_id NULL
--   transfer       → both NOT NULL, from <> to
-- Using distinct enum values (not a generic 'debit'/'credit')
-- keeps revenue/expense reports honest: a loan received and a cash
-- injection both move Cash up, but they are not revenue.
CREATE TYPE public.account_transaction_type AS ENUM (
  'revenue_in',      -- money received for a service (counts as revenue)
  'expense_out',     -- money paid out (counts as expense; always from Cash)
  'transfer',        -- internal move between buckets (neutral)
  'injection',       -- outside money added by owner (not revenue; need not be repaid)
  'loan_received',   -- borrowed money received (not revenue; must be repaid)
  'loan_repayment'   -- repaying a loan (not an expense)
);

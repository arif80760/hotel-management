-- =============================================================
-- 04-indexes.sql
-- Explicit indexes beyond PRIMARY KEY and UNIQUE constraints.
--
-- Exported: 2026-05-07  (reconstructed from migration files +
--           query patterns in bookingsService.ts)
-- Updated:  2026-05-08  — Added indexes for booking_rooms,
--           booking_extra_charges, and refunds tables.
--
-- NOTE: Supabase auto-creates B-tree indexes for PK and UNIQUE
--       columns (booking_ref, room_number, storage_path).
--       Only supplemental indexes are listed here.
-- =============================================================

-- ── bookings ─────────────────────────────────────────────────

-- Fast lookup of bookings for a given room (conflict detection,
-- room-board queries). fn_sync_room_status retired 2026-05-08.
CREATE INDEX IF NOT EXISTS idx_bookings_room_id
  ON public.bookings (room_id);

-- Fast lookup of bookings for a given guest (guest profile page).
CREATE INDEX IF NOT EXISTS idx_bookings_primary_guest_id
  ON public.bookings (primary_guest_id);

-- Status filter (most common WHERE clause in booking list queries).
CREATE INDEX IF NOT EXISTS idx_bookings_status
  ON public.bookings (status);

-- Date range queries (conflict detection, check-in/check-out views).
CREATE INDEX IF NOT EXISTS idx_bookings_check_in_date
  ON public.bookings (check_in_date);

CREATE INDEX IF NOT EXISTS idx_bookings_check_out_date
  ON public.bookings (check_out_date);

-- ── payments ─────────────────────────────────────────────────

-- Fast aggregate (SUM) of payments per booking — used by
-- fn_sync_paid_amount and getPaymentsByBookingRef.
CREATE INDEX IF NOT EXISTS idx_payments_booking_id
  ON public.payments (booking_id);

-- ── booking_guests ───────────────────────────────────────────

-- Fast per-booking guest list fetch.
CREATE INDEX IF NOT EXISTS idx_booking_guests_booking_id
  ON public.booking_guests (booking_id);

-- ── booking_documents ────────────────────────────────────────

-- Fast per-booking document list — created in
-- migration create_booking_documents_table.sql.
CREATE INDEX IF NOT EXISTS idx_booking_documents_booking_ref
  ON public.booking_documents (booking_ref);

-- ── rooms ────────────────────────────────────────────────────

-- Filter rooms by status (room-board, availability checks).
CREATE INDEX IF NOT EXISTS idx_rooms_status
  ON public.rooms (status);


-- ── booking_rooms ─────────────────────────────────────────────
-- Added: 2026-05-08 via migration 2026-05-08-multi-room-foundation.sql

-- Per-booking room list (most common fetch — loading a booking's rooms).
CREATE INDEX IF NOT EXISTS idx_booking_rooms_booking_id
  ON public.booking_rooms (booking_id);

-- Per-room booking history and availability checks.
CREATE INDEX IF NOT EXISTS idx_booking_rooms_room_id
  ON public.booking_rooms (room_id);

-- Status filter (active rooms, checking for confirmed/checked_in).
CREATE INDEX IF NOT EXISTS idx_booking_rooms_status
  ON public.booking_rooms (status);

-- Date range queries (stay calendar, board view).
CREATE INDEX IF NOT EXISTS idx_booking_rooms_dates
  ON public.booking_rooms (check_in_date, check_out_date);

-- Conflict detection: active bookings for a room in a date window.
-- Partial index — only indexes rows that can conflict.
CREATE INDEX IF NOT EXISTS idx_booking_rooms_conflict
  ON public.booking_rooms (room_id, check_in_date, check_out_date)
  WHERE status IN ('confirmed', 'checked_in');


-- ── booking_extra_charges ─────────────────────────────────────
-- Added: 2026-05-08 via migration 2026-05-08-multi-room-foundation.sql

-- Per-booking charge list (invoice rendering).
CREATE INDEX IF NOT EXISTS idx_bec_booking_id
  ON public.booking_extra_charges (booking_id);

-- Per-room charge list (per-room invoice line items).
CREATE INDEX IF NOT EXISTS idx_bec_booking_room_id
  ON public.booking_extra_charges (booking_room_id);


-- ── refunds ───────────────────────────────────────────────────
-- Added: 2026-05-08 via migration 2026-05-08-multi-room-foundation.sql

-- Per-booking refund history.
CREATE INDEX IF NOT EXISTS idx_refunds_booking_id
  ON public.refunds (booking_id);

-- Admin pending-refunds queue. Partial index: only pending rows.
CREATE INDEX IF NOT EXISTS idx_refunds_status_pending
  ON public.refunds (created_at)
  WHERE status = 'pending';

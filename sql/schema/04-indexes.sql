-- =============================================================
-- 04-indexes.sql
-- Explicit indexes beyond PRIMARY KEY and UNIQUE constraints.
--
-- Exported: 2026-05-07  (reconstructed from migration files +
--           query patterns in bookingsService.ts)
--
-- NOTE: Supabase auto-creates B-tree indexes for PK and UNIQUE
--       columns (booking_ref, room_number, storage_path).
--       Only supplemental indexes are listed here.
-- =============================================================

-- ── bookings ─────────────────────────────────────────────────

-- Fast lookup of bookings for a given room (conflict detection,
-- fn_sync_room_status, room-board queries).
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

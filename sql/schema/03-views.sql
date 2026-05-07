-- =============================================================
-- 03-views.sql
-- Public-schema views.
--
-- Exported: 2026-05-07  (reconstructed from PostgREST OpenAPI
--           column list + FK structure in bookingsService.ts)
--
-- NOTE: The exact SELECT list was inferred from the OpenAPI
--       spec.  Verify against Supabase Dashboard if in doubt.
-- =============================================================

-- ──────────────────────────────────────────────────────────────
-- booking_summary
-- Denormalised read-only view used by the booking list and
-- room-board queries.  Joins bookings → rooms → guests.
--
-- Does NOT include extra-charge / early-deduction / discount
-- columns — those are fetched directly from bookings when needed
-- (e.g. invoice page, checkout modal).
-- ──────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.booking_summary AS
SELECT
  -- Booking core
  b.id,
  b.booking_ref,
  b.status,
  b.check_in_date,
  b.check_out_date,
  b.nights,
  b.total_guests,
  b.room_category_at_booking,

  -- Room details (current state)
  r.room_number,
  r.floor,
  r.category        AS room_category_current,
  r.status          AS room_status,
  r.price_per_night,

  -- Guest details (primary guest)
  g.name            AS guest_name,
  g.email           AS guest_email,
  g.phone           AS guest_phone,
  g.nationality     AS guest_nationality,
  g.vip             AS guest_vip,

  -- Financial summary
  b.total_amount,
  b.paid_amount,
  b.due_amount,
  b.payment_status,

  -- Override
  b.override_checkout,
  b.override_reason,
  b.override_at,

  -- Lifecycle timestamps
  b.confirmed_at,
  b.checked_in_at,
  b.checked_out_at,
  b.cancelled_at,

  -- Audit timestamps
  b.created_at,
  b.updated_at

FROM public.bookings b
JOIN public.rooms  r ON r.id = b.room_id
JOIN public.guests g ON g.id = b.primary_guest_id;

COMMENT ON VIEW public.booking_summary IS
  'Denormalised booking list view — joins bookings, rooms, guests. '
  'Used by BookingsClient and RoomBoard. Does not include extra charges.';

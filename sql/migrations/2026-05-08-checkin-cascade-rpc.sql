-- ===========================================================================
-- RPC: checkin_booking_atomic
-- File:    sql/migrations/2026-05-08-checkin-cascade-rpc.sql
-- Date:    2026-05-08
-- Apply:   After 2026-05-08-multi-room-rpc.sql
--
-- Problem addressed:
--   updateBookingStatus() previously did a bare UPDATE bookings SET status=...
--   which left booking_rooms.status rows at 'confirmed' after check-in.
--   The Phase 6 edit modal reads per-row status to determine lock state, so
--   all three rooms on a checked-in booking still appeared editable.
--
--   Checkout and cancel already go through RPCs (checkout_booking_room,
--   cancel_booking_room) that atomically cascade booking_rooms.status.
--   Check-in had no equivalent — this RPC closes that gap.
--
-- Function:
--   checkin_booking_atomic(p_booking_id uuid, p_target_status text)
--
--   Handles the confirmed ↔ checked_in axis only. All other transitions
--   (checked_out, checked_out_early, cancelled) go through their own RPCs
--   and must NOT call this one — an exception is raised for those values.
--
--   Within a single transaction:
--     1. Validates p_target_status is 'confirmed' or 'checked_in'.
--     2. UPDATEs bookings.status + bookings.checked_in_at (when →checked_in).
--     3. UPDATEs ALL booking_rooms.status for the same booking_id to the
--        same target status (bulk cascade — all rooms move together on
--        check-in, matching how the UI exposes check-in as a booking-level
--        action, not a per-room action).
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.checkin_booking_atomic(
  p_booking_id    UUID,
  p_target_status TEXT    -- must be 'confirmed' or 'checked_in'
) RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
  -- ── Guard: only confirmed ↔ checked_in transitions are allowed ────────────
  IF p_target_status NOT IN ('confirmed', 'checked_in') THEN
    RAISE EXCEPTION
      'checkin_booking_atomic: invalid target status ''%''. '
      'Use checkout_booking_room for checked_out, '
      'cancel_booking_room for cancelled/checked_out_early.',
      p_target_status;
  END IF;

  -- ── Step 1: Update bookings row ───────────────────────────────────────────
  UPDATE public.bookings
  SET
    status        = p_target_status::public.booking_status,
    checked_in_at = CASE
                      WHEN p_target_status = 'checked_in' AND checked_in_at IS NULL
                        THEN NOW()
                      ELSE checked_in_at          -- preserve existing timestamp
                    END,
    updated_at    = NOW()
  WHERE id = p_booking_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'checkin_booking_atomic: booking % not found', p_booking_id;
  END IF;

  -- ── Step 2: Cascade to all booking_rooms rows for this booking ────────────
  -- Only cascade rows that are in the expected source status to avoid
  -- overwriting rows that have already moved to a terminal state
  -- (e.g., a cancelled room on an otherwise confirmed booking).
  --
  -- confirmed  → checked_in:  update rows where status = 'confirmed'
  -- checked_in → confirmed:   update rows where status = 'checked_in'
  --   (the "undo check-in" admin path — keeps parity)
  UPDATE public.booking_rooms
  SET
    status        = p_target_status::public.booking_status,
    checked_in_at = CASE
                      WHEN p_target_status = 'checked_in' AND checked_in_at IS NULL
                        THEN NOW()
                      ELSE checked_in_at
                    END,
    updated_at    = NOW()
  WHERE booking_id = p_booking_id
    AND status = CASE
                   WHEN p_target_status = 'checked_in' THEN 'confirmed'::public.booking_status
                   WHEN p_target_status = 'confirmed'  THEN 'checked_in'::public.booking_status
                 END;

END;
$$;

COMMENT ON FUNCTION public.checkin_booking_atomic IS
  'Atomically transitions a booking and ALL its active booking_rooms between '
  'confirmed and checked_in. Only handles the confirmed↔checked_in axis — '
  'other transitions (checkout, cancel) have their own dedicated RPCs. '
  'Stamps checked_in_at on both tables when moving to checked_in.';

-- Grant execution to authenticated role (same pattern as other RPCs)
GRANT EXECUTE ON FUNCTION public.checkin_booking_atomic(UUID, TEXT)
  TO authenticated;

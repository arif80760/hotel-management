-- ===========================================================================
-- Phase 7.5: per-room check-in
-- File:    sql/migrations/2026-05-09-checkin-booking-room-rpc.sql
-- Date:    2026-05-09
-- Apply:   After 2026-05-09-phase7-rpc-updates.sql
--
-- Adds checkin_booking_room(p_booking_room_id UUID) — checks in a single
-- booking_rooms row from confirmed → checked_in, sets the physical room to
-- occupied, and re-derives the parent booking status using the same 4-rule
-- pattern used by cancel_booking_room and other Phase 7 RPCs.
--
-- Use case:
--   A multi-room booking may have rooms arrive on different days.
--   E.g. 2 rooms confirmed (booked in advance) + 2 rooms added mid-stay:
--   those later rooms start as confirmed even while the booking is checked_in.
--   This RPC lets a front-desk agent check in each late-arriving room
--   individually without affecting the rest of the booking.
--
-- Source-state guard:
--   Only confirmed → checked_in is allowed.
--   - already checked_in → EXCEPTION (not idempotent; caller must guard first)
--   - cancelled / checked_out / checked_out_early → EXCEPTION
--   Raising on already-checked_in makes calling code more reliable by
--   surfacing double-fire bugs immediately rather than silently no-oping.
--
-- 4-rule booking status derivation (§ 5, docs/multi-room-design.md):
--   1. all cancelled                    → cancelled
--   2. any checked_in                   → checked_in  ← this rule fires here
--   3. none confirmed/checked_in        → checked_out
--   4. else                             → confirmed
--
-- Signature is new — CREATE OR REPLACE safe, no DROP needed.
-- ===========================================================================


CREATE OR REPLACE FUNCTION public.checkin_booking_room(
  p_booking_room_id UUID
) RETURNS VOID
LANGUAGE plpgsql AS $$
DECLARE
  v_booking_id     UUID;
  v_room_id        UUID;
  v_status         public.booking_status;
  v_derived_status public.booking_status;
BEGIN

  -- ── 1. Read current booking_rooms row ─────────────────────────────────
  SELECT booking_id, room_id, status
  INTO   v_booking_id, v_room_id, v_status
  FROM   public.booking_rooms
  WHERE  id = p_booking_room_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'booking_room % not found', p_booking_room_id;
  END IF;

  -- ── 2. Source-state guard ──────────────────────────────────────────────
  IF v_status = 'checked_in' THEN
    RAISE EXCEPTION
      'booking_room % is already checked in. '
      'This RPC only transitions confirmed → checked_in.',
      p_booking_room_id;
  END IF;

  IF v_status <> 'confirmed' THEN
    RAISE EXCEPTION
      'Cannot check in booking_room % — current status is %. '
      'Only rooms with status=confirmed can be checked in.',
      p_booking_room_id, v_status;
  END IF;

  -- ── 3. Update booking_rooms ────────────────────────────────────────────
  UPDATE public.booking_rooms
  SET    status        = 'checked_in'::public.booking_status,
         checked_in_at = NOW(),
         updated_at    = NOW()
  WHERE  id = p_booking_room_id;

  -- ── 4. Update physical room status ────────────────────────────────────
  UPDATE public.rooms
  SET    status     = 'occupied'::public.room_status,
         updated_at = NOW()
  WHERE  id = v_room_id;

  -- ── 5. Derive parent booking status (4-rule) ───────────────────────────
  SELECT
    CASE
      WHEN COUNT(*) = COUNT(*) FILTER (WHERE status = 'cancelled')
        THEN 'cancelled'::public.booking_status
      WHEN COUNT(*) FILTER (WHERE status = 'checked_in') > 0
        THEN 'checked_in'::public.booking_status
      WHEN COUNT(*) FILTER (WHERE status IN ('confirmed', 'checked_in')) = 0
        THEN 'checked_out'::public.booking_status
      ELSE  'confirmed'::public.booking_status
    END
  INTO v_derived_status
  FROM public.booking_rooms
  WHERE booking_id = v_booking_id;

  -- ── 6. Sync booking-level status (IS DISTINCT FROM guard) ─────────────
  -- Avoids a no-op trigger re-stamp when the booking is already checked_in
  -- (e.g. checking in a second room when the first was already checked in).
  UPDATE public.bookings
  SET    status = v_derived_status
  WHERE  id     = v_booking_id
    AND  status IS DISTINCT FROM v_derived_status;

END;
$$;

COMMENT ON FUNCTION public.checkin_booking_room IS
  'Checks in one booking_rooms row (confirmed → checked_in). '
  'Sets physical room status to occupied. '
  'Re-derives and syncs parent booking status using the 4-rule pattern '
  '(§ 5, docs/multi-room-design.md). '
  'Raises if the row is not in confirmed state — not idempotent by design.';


-- ===========================================================================
-- GRANT
-- ===========================================================================

GRANT EXECUTE ON FUNCTION public.checkin_booking_room TO authenticated;


-- ===========================================================================
-- VERIFICATION
-- ===========================================================================

SELECT
  p.proname                                                          AS function_name,
  pg_catalog.pg_get_function_identity_arguments(p.oid)              AS arguments,
  pg_catalog.pg_get_function_result(p.oid)                          AS return_type
FROM pg_catalog.pg_proc p
JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname = 'checkin_booking_room';

-- Expected output:
--   checkin_booking_room | p_booking_room_id uuid | void

-- ===========================================================================
-- END OF MIGRATION
-- ===========================================================================

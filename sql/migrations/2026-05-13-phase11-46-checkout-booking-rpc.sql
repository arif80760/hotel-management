-- ===========================================================================
-- Phase 11 #46: New checkout_booking RPC — bulk checkout all active rooms
-- File:    sql/migrations/2026-05-13-phase11-46-checkout-booking-rpc.sql
-- Date:    2026-05-13
--
-- Nature:
--   DDL only — CREATE OR REPLACE FUNCTION + GRANT.
--   No table changes. No data changes.
--
-- Background:
--   checkout_booking_room accepts one p_booking_room_id UUID and checks
--   out exactly one room. HotelContext.checkoutNormal and checkoutWithOverride
--   derived bookingRoomId as target.rooms?.[0]?.id — always rooms[0].
--
--   For a multi-room booking with 4 active rooms:
--     - Only rooms[0] was checked out server-side
--     - Rooms[1..3] remained Checked In
--     - Extra charge was attributed to rooms[0].booking_rooms.id
--     - Optimistic UI incorrectly showed the whole booking as Checked Out
--     - Second "Check Out" click would re-fire on already-checked-out rooms[0]
--
-- Fix:
--   New checkout_booking(p_booking_id) RPC mirrors the cancel_booking
--   structure:
--     - One bulk UPDATE on booking_rooms (WHERE status IN checked_in/confirmed)
--     - One bulk UPDATE on physical rooms (→ cleaning)
--     - update_booking_total() to keep total_amount in sync
--     - Unconditional bookings.status = 'checked_out' at the end
--
--   Service layer: checkoutNormal and checkoutWithOverride now:
--     - Resolve booking_ref → UUID (Step 0, mirrors cancelBooking)
--     - Call checkout_booking (not checkout_booking_room)
--     - Write booking_extra_charges.booking_room_id = NULL (booking-level
--       charge, per the column's nullable design intent:
--       "NULL = booking-level charge; non-null = attributed to a specific room")
--
--   HotelContext: removes rooms[0] shim (bookingRoomId derivation);
--   optimistic setRooms update now marks ALL booking rooms as Cleaning.
--
-- Edge cases handled:
--   a) All rooms active: all rooms checked out, all → cleaning.
--   b) Mix checked_out_early + checked_in: WHERE filters to active only;
--      early-departed rooms untouched.
--   c) Mix cancelled + checked_in: cancelled rows excluded; only
--      checked_in rows checked out.
--   d/e) All rooms already checked_out or cancelled (0 active rows):
--        WHERE clause is a no-op on rooms; booking status still promoted
--        to checked_out at step 7.
--
-- Early departure params:
--   p_early_nights_deducted and p_deduction_amount are included in the
--   signature for API discoverability but are BLOCKED by a guard at step 2.
--   Applying either to all active rooms simultaneously would deduct the same
--   night count from every room (e.g. 4 rooms × 2 nights = 8 nights wrongly
--   removed from booking total). Per-room early departure is handled by
--   checkout_booking_room via the "Early Out" button — that flow is unchanged.
--
-- Relationship to checkout_booking_room:
--   checkout_booking_room is NOT deprecated. It continues to serve:
--     - "Early Out" per-room early departure (existing flow, unchanged)
--   checkout_booking serves:
--     - Booking-level "Check Out" (final exit, all remaining active rooms)
--
-- Apply mode:
--   SQL Editor (service role). DDL is not reachable via PostgREST.
--   Single-block execution.
--   APPLIED: 2026-05-13 — function live in production (verified via
--   pg_proc query and GRANT confirmation).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Section 1: Create checkout_booking RPC
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.checkout_booking(
  p_booking_id            UUID,
  p_actual_checkout_date  DATE    DEFAULT NULL,
  p_early_nights_deducted INTEGER DEFAULT 0,
  p_deduction_amount      NUMERIC DEFAULT 0
)
RETURNS VOID
LANGUAGE plpgsql AS $$
DECLARE
  v_room_ids UUID[];
BEGIN

  -- ── 1. Validate booking exists ─────────────────────────────────────────────
  IF NOT EXISTS (SELECT 1 FROM public.bookings WHERE id = p_booking_id) THEN
    RAISE EXCEPTION 'booking % not found', p_booking_id;
  END IF;

  -- ── 2. Guard: early departure params are not supported at booking level ─────
  -- Applying p_early_nights_deducted to all active rooms simultaneously would
  -- deduct the same night count from every room (e.g. 4 rooms × 2 nights = 8
  -- nights wrongly removed from total). Per-room early departure is handled by
  -- checkout_booking_room, called via the "Early Out" button.
  -- Fail loud here so a future caller cannot accidentally corrupt booking totals.
  IF p_early_nights_deducted > 0 OR p_deduction_amount > 0 THEN
    RAISE EXCEPTION
      'checkout_booking does not support early_nights_deducted or '
      'deduction_amount. Use checkout_booking_room (per-room Early Out '
      'flow) for individual early departures.';
  END IF;

  -- ── 3. Collect room_ids of active rooms before the update ──────────────────
  -- Snapshot taken here so the subsequent UPDATE doesn't need a self-join.
  -- NULL when 0 active rooms (edge cases d/e) — handled in step 5.
  SELECT array_agg(room_id)
  INTO   v_room_ids
  FROM   public.booking_rooms
  WHERE  booking_id = p_booking_id
    AND  status IN ('confirmed', 'checked_in');

  -- ── 4. Bulk check out all active rooms ─────────────────────────────────────
  -- WHERE clause excludes already-checked-out and cancelled rows cleanly.
  -- 0 matching rows = silent no-op (edge cases d/e).
  -- p_actual_checkout_date applied to all active rooms — correct for the
  -- whole-family-leaves-together scenario.
  -- early_nights_deducted and nights are NOT touched here — the guard above
  -- ensures p_early_nights_deducted = 0; rooms are leaving on schedule.
  UPDATE public.booking_rooms
  SET    status               = 'checked_out',
         checked_out_at       = NOW(),
         actual_checkout_date = COALESCE(p_actual_checkout_date, check_out_date),
         check_out_date       = COALESCE(p_actual_checkout_date, check_out_date),
         updated_at           = NOW()
  WHERE  booking_id = p_booking_id
    AND  status IN ('confirmed', 'checked_in');

  -- ── 5. Set physical rooms to cleaning ──────────────────────────────────────
  -- Skipped when v_room_ids IS NULL (0 active rooms — edge cases d/e).
  IF v_room_ids IS NOT NULL THEN
    UPDATE public.rooms
    SET    status     = 'cleaning',
           updated_at = NOW()
    WHERE  id = ANY(v_room_ids);
  END IF;

  -- ── 6. Recompute booking total ──────────────────────────────────────────────
  -- Picks up any extra_charges already present in booking_extra_charges.
  -- For standard final checkout (p_early_nights_deducted = 0): nights are
  -- unchanged so this is a no-op on total_amount — but still called for
  -- correctness and to keep fn_sync_payment_status in sync.
  PERFORM public.update_booking_total(p_booking_id);

  -- ── 7. Promote booking to checked_out ──────────────────────────────────────
  -- Unconditional — handles all mix states: some rooms already checked out,
  -- some cancelled, or 0 active rooms when operator clicks by mistake.
  -- IS DISTINCT FROM guard prevents a no-op UPDATE from firing triggers.
  UPDATE public.bookings
  SET    status = 'checked_out'
  WHERE  id     = p_booking_id
    AND  status IS DISTINCT FROM 'checked_out';

END;
$$;

COMMENT ON FUNCTION public.checkout_booking IS
  'Checks out all active rooms on a booking in one operation. Sets booking_rooms.status=checked_out, rooms.status=cleaning, recomputes total, promotes bookings.status=checked_out. Mirrors cancel_booking structure. Early departure params blocked by guard — use checkout_booking_room for per-room early departure.';

-- ---------------------------------------------------------------------------
-- Section 2: Grant execute
-- ---------------------------------------------------------------------------

GRANT EXECUTE ON FUNCTION public.checkout_booking(UUID, DATE, INTEGER, NUMERIC)
  TO anon, authenticated;

-- ---------------------------------------------------------------------------
-- Section 3: Verification (run in SQL Editor after applying)
-- ---------------------------------------------------------------------------

-- 3a. Confirm function exists with correct signature
--
-- SELECT proname, pg_get_function_arguments(oid) AS args
-- FROM   pg_proc
-- WHERE  proname = 'checkout_booking';
--
-- Expected: one row,
--   proname           | args
--   checkout_booking  | p_booking_id uuid,
--                     | p_actual_checkout_date date DEFAULT NULL,
--                     | p_early_nights_deducted integer DEFAULT 0,
--                     | p_deduction_amount numeric DEFAULT 0

-- 3b. Confirm grants
--
-- SELECT grantee, privilege_type
-- FROM   information_schema.routine_privileges
-- WHERE  routine_name = 'checkout_booking';
--
-- Expected: rows for anon + authenticated, privilege_type = EXECUTE

-- ===========================================================================
-- END OF MIGRATION
-- ===========================================================================

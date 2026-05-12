-- ===========================================================================
-- Phase 11 #10: checkin_booking_room must enforce a future-date guard
-- File:    sql/migrations/2026-05-12-phase11-10-checkin-room-future-guard.sql
-- Date:    2026-05-12
--
-- Nature:
--   RPC signature change + body change.  No schema additions.
--   The existing checkin_booking_room function is dropped and recreated
--   with an additional p_force_future BOOLEAN DEFAULT FALSE parameter
--   and a new step 2.5 future-date guard in the body.
--
-- Background:
--   Day 9 Batch 1 investigation found that the per-room drawer "Check In"
--   button (BookingsClient.tsx lines ~3997 and ~4494) fires
--   ctxCheckinBookingRoom(r.id) unconditionally — no disabled prop, no
--   canCheckInToday call, no date check of any kind against r.checkInISO.
--   By contrast, the booking-level "Check In" button (same file, lines
--   ~3817–3826) computes isFutureCheckIn = !canCheckInToday(b.checkInISO)
--   and applies disabled + opacity-50 + cursor-not-allowed + tooltip.
--
--   The server-side RPC (checkin_booking_room) had no date check either.
--   A front-desk operator could check a room in days before the guest
--   arrives — wrong physical room status (occupied), wrong booking status
--   (checked_in), and no audit trail that the action was premature.
--
-- Why fix both layers (UI + RPC):
--   The UI guard (Step 2 of Phase 11 #10) prevents accidental early
--   check-ins from the BookingsClient.  The RPC guard (this migration)
--   is defense-in-depth: any direct caller — admin tooling, future API
--   clients, integration tests — gets the same protection without relying
--   on the front-end to enforce it.
--
-- Why DROP FUNCTION + CREATE FUNCTION (not CREATE OR REPLACE):
--   The function signature changes: a new parameter p_force_future is
--   added.  PostgreSQL treats functions with different argument lists as
--   distinct overloads.  CREATE OR REPLACE with a new parameter creates
--   a second overload alongside the old one-argument form.  Over time
--   this causes overload-creep: callers could silently resolve to the
--   wrong overload.  The correct pattern (Day 7 lesson) is to DROP the
--   old signature first, then CREATE the new one.  There is no data loss
--   risk — this is a function definition, not table data.
--
-- Why include p_force_future even though Phase 11 #10 UI uses the
-- fully-disabled pattern (no confirm/force flow):
--   1. Symmetry with bulk_checkin_booking_rooms, which has had
--      p_force_future since Phase 7.6.  Having the single-room path
--      expose a different contract is confusing for future developers.
--   2. Future-proofing: a supervisor override flow (e.g. "early check-in
--      is paid for") is a plausible product requirement.  Adding the
--      parameter now means the RPC never needs another signature change.
--   3. Defense-in-depth: direct callers who need to bypass the guard can
--      do so explicitly (p_force_future=TRUE) rather than the guard being
--      absent.  Explicit override > absent guard.
--
-- Backward compatibility:
--   DEFAULT FALSE means any caller that does not pass p_force_future
--   (including the current bookingsService.checkinBookingRoom, which
--   passes only p_booking_room_id) continues to work unchanged after
--   the service layer is updated in Step 2.  The service layer change
--   is additive only.
--
-- Trigger interactions:
--   None relevant to this migration.  checkin_booking_room writes to
--   booking_rooms.status (checked_in) and bookings.status (checked_in).
--   Neither of those columns is watched by trg_sync_payment_status
--   (which fires on paid_amount, total_amount, status, extra_charge_amount
--   on bookings — the bookings.status write here will fire it, but
--   status='checked_in' does not match the CANCELLED branch, and
--   paid_amount/total_amount are untouched, so payment_status is
--   unaffected).  No IS DISTINCT FROM guard trick is involved here;
--   RAISE EXCEPTION is the guard mechanism, not trigger logic.
--
-- Apply mode:
--   Sections 1 + 2 are DDL — must be run via Supabase SQL Editor
--   (service role key returns 401 for DDL via PostgREST).
--   Section 3 is a commented verification query for SQL Editor only.
--   Single block — no multi-run requirement.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- Section 1: Drop the old function signature
--
-- The old signature is checkin_booking_room(UUID).
-- DROP IF EXISTS is safe on a fresh DB (no rows affected, no error).
-- This drop is required before CREATE because the new signature
-- checkin_booking_room(UUID, BOOLEAN) would otherwise sit alongside
-- the old one as a separate overload (overload-creep, Day 7 lesson).
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.checkin_booking_room(UUID);


-- ---------------------------------------------------------------------------
-- Section 2: Recreate with new signature and future-date guard
--
-- Changes vs the previous version (2026-05-09-checkin-booking-room-rpc.sql):
--   a. Signature: new parameter p_force_future BOOLEAN DEFAULT FALSE.
--   b. DECLARE: two new variables v_check_in_date DATE, v_room_number TEXT.
--   c. New step 2.5 (after status guards, before first mutation):
--      future-date guard that reads check_in_date + room_number from
--      booking_rooms JOIN rooms and raises if check_in_date > CURRENT_DATE
--      and p_force_future = FALSE.
--   All other steps (1, 2, 3, 4, 5, 6) are identical to the prior version.
-- ---------------------------------------------------------------------------

CREATE FUNCTION public.checkin_booking_room(
  p_booking_room_id UUID,
  p_force_future    BOOLEAN DEFAULT FALSE
) RETURNS VOID
LANGUAGE plpgsql AS $$
DECLARE
  v_booking_id     UUID;
  v_room_id        UUID;
  v_status         public.booking_status;
  v_derived_status public.booking_status;
  v_check_in_date  DATE;
  v_room_number    TEXT;
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

  -- ── 2.5 Future-date guard (Phase 11 #10) ──────────────────────────────
  -- Mirrors the bulk_checkin_booking_rooms preflight pattern.
  -- Only blocks when p_force_future = FALSE (the safe default).
  -- Placed after the status guards so we only hit the extra SELECT
  -- when the room is actually in a check-in-able state.
  IF NOT p_force_future THEN
    SELECT br.check_in_date, r.room_number
    INTO   v_check_in_date, v_room_number
    FROM   public.booking_rooms br
    JOIN   public.rooms r ON r.id = br.room_id
    WHERE  br.id = p_booking_room_id;

    IF v_check_in_date > CURRENT_DATE THEN
      RAISE EXCEPTION
        'Cannot check in booking_room % — Room % is scheduled '
        'for % (future date). Today is %. '
        'Use p_force_future=TRUE to override.',
        p_booking_room_id, v_room_number, v_check_in_date, CURRENT_DATE;
    END IF;
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
  'Raises if the row is not in confirmed state — not idempotent by design. '
  'Phase 11 #10 (2026-05-12): added p_force_future BOOLEAN DEFAULT FALSE. '
  'When p_force_future=FALSE (default), raises if booking_rooms.check_in_date '
  'is in the future. Pass p_force_future=TRUE to override (e.g. paid early '
  'check-in). Mirrors the bulk_checkin_booking_rooms guard pattern.';


-- ===========================================================================
-- GRANT
-- ===========================================================================

GRANT EXECUTE ON FUNCTION public.checkin_booking_room(UUID, BOOLEAN) TO authenticated;


-- ---------------------------------------------------------------------------
-- Section 3: Verification
--
-- pg_proc is not reachable via PostgREST.  Run the following directly
-- in the Supabase SQL Editor after applying Sections 1 + 2:
--
--   SELECT proname,
--          pg_get_function_arguments(oid)    AS arguments,
--          pg_get_function_result(oid)        AS return_type
--   FROM   pg_proc
--   WHERE  proname       = 'checkin_booking_room'
--     AND  pronamespace  = 'public'::regnamespace;
--
-- Expected: exactly ONE row (confirms no overload-creep):
--
--   proname              | arguments                                           | return_type
--   checkin_booking_room | p_booking_room_id uuid, p_force_future boolean DEFAULT false | void
--
-- If two rows appear, the old overload was not dropped correctly.
-- In that case run:
--   DROP FUNCTION public.checkin_booking_room(UUID);
-- and re-verify.
-- ---------------------------------------------------------------------------


-- ===========================================================================
-- END OF MIGRATION
-- ===========================================================================

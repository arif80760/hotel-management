-- ===========================================================================
-- RPC Functions: Multi-Room Booking Support
-- File:    sql/migrations/2026-05-08-multi-room-rpc.sql
-- Date:    2026-05-08
-- Apply:   AFTER 2026-05-08-multi-room-foundation.sql
--
-- Functions defined (in dependency order):
--
--   1. update_booking_total(p_booking_id)
--        Helper: recomputes bookings.total_amount from booking_rooms + extras.
--        Called by all mutation RPCs below.
--
--   2. create_booking_with_rooms(...)
--        Creates a booking + N booking_rooms rows + optional initial payment
--        in a single atomic transaction.
--
--   3. add_room_to_booking(...)
--        Adds one room to an existing booking mid-stay.
--
--   4. checkout_booking_room(...)
--        Normal checkout for a single room. Handles early departure
--        (deducts unused nights). Advances booking to checked_out if last room.
--
--   5. cancel_booking_room(...)
--        Per-room cancellation or early departure:
--          'cancelled'         — pre-check-in, zero charge
--          'checked_out_early' — post-check-in, charge actual nights used
--        Recomputes booking total and syncs booking-level status.
--
--   6. extend_booking_room(...)
--        Extends check_out_date for one room. Conflict-checks before committing.
--
-- DESIGN NOTES:
--   • fn_sync_room_status trigger is DROPPED by the foundation migration.
--     These RPCs manually set rooms.status as part of their operations.
--   • trg_stamp_booking_timestamps is KEPT. When any RPC sets bookings.status,
--     the trigger stamps confirmed_at / checked_in_at / etc. automatically.
--   • trg_sync_payment_status is KEPT. update_booking_total updates
--     bookings.total_amount, which fires the trigger and re-derives
--     bookings.payment_status automatically.
--   • Backward compat: bookings.room_id is kept pointing to the first room.
--     bookings.check_in_date, check_out_date, room_category_at_booking are
--     also kept in sync for existing code that reads them directly.
--     These will be dropped in a future migration after Phase 3 completes.
-- ===========================================================================


-- ═══════════════════════════════════════════════════════════════════════════
-- 1. update_booking_total
--
-- Recomputes bookings.total_amount as:
--   SUM(booking_rooms.nights × booking_rooms.booking_rate) for non-cancelled rooms
--   + SUM(booking_extra_charges.amount) for all charges on this booking
--
-- Called by cancel_booking_room, extend_booking_room, checkout_booking_room
-- (when a deduction is applied), and add_room_to_booking.
--
-- Side effect: updating total_amount fires trg_sync_payment_status, which
-- re-derives bookings.payment_status. This is intentional.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.update_booking_total(
  p_booking_id  UUID
) RETURNS NUMERIC
LANGUAGE plpgsql AS $$
DECLARE
  v_rooms_total   NUMERIC;
  v_extras_total  NUMERIC;
  v_new_total     NUMERIC;
BEGIN
  -- Sum active room charges (cancelled rooms contribute ৳0)
  SELECT COALESCE(SUM(nights * booking_rate), 0) INTO v_rooms_total
  FROM public.booking_rooms
  WHERE booking_id = p_booking_id
    AND status <> 'cancelled';

  -- Sum all extra charges on this booking (extras are never cancelled)
  SELECT COALESCE(SUM(amount), 0) INTO v_extras_total
  FROM public.booking_extra_charges
  WHERE booking_id = p_booking_id;

  v_new_total := v_rooms_total + v_extras_total;

  -- Update booking — triggers trg_sync_payment_status automatically
  UPDATE public.bookings
  SET total_amount = v_new_total
  WHERE id = p_booking_id;

  RETURN v_new_total;
END;
$$;

COMMENT ON FUNCTION public.update_booking_total(UUID) IS
  'Recomputes bookings.total_amount from non-cancelled booking_rooms and booking_extra_charges. Fires trg_sync_payment_status as a side effect.';


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. create_booking_with_rooms
--
-- Creates a full booking atomically:
--   a) INSERT into bookings (shell + backward-compat columns from first room)
--   b) INSERT into booking_rooms (one row per room in p_rooms array)
--   c) UPDATE rooms.status → 'reserved' for each room
--   d) INSERT into payments if p_initial_payment > 0
--
-- Returns the new bookings.id (UUID).
--
-- p_rooms JSONB array schema (each element):
--   {
--     "room_id":        "<UUID>",
--     "check_in_date":  "YYYY-MM-DD",
--     "check_out_date": "YYYY-MM-DD",
--     "nights":         <integer>,
--     "category":       "<room_category enum value>",
--     "rate":           <numeric>
--   }
--
-- p_payment_method must be one of the payment_method enum values
-- (cash, card, bank_transfer, bkash, nagad, online, other).
--
-- Called from: bookingsService.ts → createBookingWithRooms()
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.create_booking_with_rooms(
  p_booking_ref        TEXT,
  p_primary_guest_id   UUID,
  p_total_guests       SMALLINT,
  p_rooms              JSONB,      -- array of room specs; see schema above
  p_total_amount       NUMERIC,
  p_initial_payment    NUMERIC     DEFAULT 0,
  p_payment_method     TEXT        DEFAULT NULL,
  p_recorded_by        UUID        DEFAULT NULL   -- auth.users UUID of staff creating booking
) RETURNS UUID
LANGUAGE plpgsql AS $$
DECLARE
  v_booking_id       UUID;
  v_room             JSONB;
  v_first_room_id    UUID;
  v_first_check_in   DATE;
  v_first_check_out  DATE;
  v_first_category   public.room_category;
BEGIN
  -- Pull first-room values for backward-compat columns on bookings
  v_first_room_id   := (p_rooms->0->>'room_id')::UUID;
  v_first_check_in  := (p_rooms->0->>'check_in_date')::DATE;
  v_first_check_out := (p_rooms->0->>'check_out_date')::DATE;
  v_first_category  := (p_rooms->0->>'category')::public.room_category;

  -- ── a) Insert booking shell ────────────────────────────────────────────
  INSERT INTO public.bookings (
    booking_ref,
    primary_guest_id,
    total_guests,
    status,
    total_amount,
    paid_amount,
    payment_status,
    confirmed_at,

    -- Backward-compat columns (deprecated; populated from first room).
    -- Will be dropped in a future migration after Phase 3 completes.
    room_id,
    check_in_date,
    check_out_date,
    room_category_at_booking
  ) VALUES (
    p_booking_ref,
    p_primary_guest_id,
    p_total_guests,
    'confirmed',
    p_total_amount,
    0,
    'unpaid',
    NOW(),

    v_first_room_id,
    v_first_check_in,
    v_first_check_out,
    v_first_category
  )
  RETURNING id INTO v_booking_id;

  -- ── b) Insert booking_rooms rows + c) reserve each physical room ───────
  FOR v_room IN SELECT value FROM jsonb_array_elements(p_rooms) LOOP
    INSERT INTO public.booking_rooms (
      booking_id,
      room_id,
      check_in_date,
      check_out_date,
      nights,
      room_category,
      booking_rate,
      status,
      confirmed_at
    ) VALUES (
      v_booking_id,
      (v_room->>'room_id')::UUID,
      (v_room->>'check_in_date')::DATE,
      (v_room->>'check_out_date')::DATE,
      (v_room->>'nights')::SMALLINT,
      (v_room->>'category')::public.room_category,
      (v_room->>'rate')::NUMERIC,
      'confirmed',
      NOW()
    );

    -- Set physical room to reserved (trigger was dropped; we own this now)
    UPDATE public.rooms
    SET    status     = 'reserved',
           updated_at = NOW()
    WHERE  id = (v_room->>'room_id')::UUID;
  END LOOP;

  -- ── d) Initial payment (if provided) ──────────────────────────────────
  -- This fires trg_sync_paid_amount (bookings.paid_amount +=) and
  -- trg_sync_last_payment_method automatically.
  IF p_initial_payment > 0 AND p_payment_method IS NOT NULL THEN
    INSERT INTO public.payments (
      booking_id, amount, method, recorded_by
    ) VALUES (
      v_booking_id,
      p_initial_payment,
      p_payment_method::public.payment_method,
      p_recorded_by
    );
  END IF;

  RETURN v_booking_id;
END;
$$;

COMMENT ON FUNCTION public.create_booking_with_rooms IS
  'Creates a booking with N rooms atomically. Returns booking UUID. Called via supabase.rpc() from bookingsService.ts.';


-- ═══════════════════════════════════════════════════════════════════════════
-- 3. add_room_to_booking
--
-- Adds one more room to an existing booking. Can be called on a confirmed
-- or checked-in booking (mid-stay add-room scenario).
--
-- p_room_status: pass 'confirmed' if the booking is pre-check-in,
--               'checked_in' if the booking is already active and the new
--               room should be immediately occupied.
--
-- Returns the new booking_rooms.id.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.add_room_to_booking(
  p_booking_id      UUID,
  p_room_id         UUID,
  p_check_in_date   DATE,
  p_check_out_date  DATE,
  p_nights          SMALLINT,
  p_category        public.room_category,
  p_rate            NUMERIC,
  p_room_status     public.booking_status  -- 'confirmed' or 'checked_in'
) RETURNS UUID
LANGUAGE plpgsql AS $$
DECLARE
  v_room_row_id      UUID;
  v_physical_status  public.room_status;
BEGIN
  -- Insert booking_rooms row
  INSERT INTO public.booking_rooms (
    booking_id,
    room_id,
    check_in_date,
    check_out_date,
    nights,
    room_category,
    booking_rate,
    status,
    confirmed_at,
    checked_in_at
  ) VALUES (
    p_booking_id,
    p_room_id,
    p_check_in_date,
    p_check_out_date,
    p_nights,
    p_category,
    p_rate,
    p_room_status,
    NOW(),
    CASE WHEN p_room_status = 'checked_in' THEN NOW() ELSE NULL END
  )
  RETURNING id INTO v_room_row_id;

  -- Recompute booking total (adds p_nights × p_rate to total_amount)
  UPDATE public.bookings
  SET total_amount = total_amount + (p_nights::NUMERIC * p_rate)
  WHERE id = p_booking_id;

  -- Set physical room status
  v_physical_status := CASE p_room_status
    WHEN 'confirmed'  THEN 'reserved'::public.room_status
    WHEN 'checked_in' THEN 'occupied'::public.room_status
    ELSE                   'reserved'::public.room_status
  END;

  UPDATE public.rooms
  SET    status     = v_physical_status,
         updated_at = NOW()
  WHERE  id = p_room_id;

  RETURN v_room_row_id;
END;
$$;

COMMENT ON FUNCTION public.add_room_to_booking IS
  'Adds a room to an existing booking (mid-stay or pre-arrival). Updates total_amount and sets physical room status.';


-- ═══════════════════════════════════════════════════════════════════════════
-- 4. checkout_booking_room
--
-- Normal checkout for one room (end of planned stay, or on-time departure).
-- Also handles early departure — pass deduction fields if guest left before
-- the scheduled check_out_date.
--
-- Sets booking_rooms.status = 'checked_out'.
-- Sets rooms.status = 'cleaning'.
-- Deducts unused nights from bookings.total_amount if p_deduction_amount > 0.
-- Advances bookings.status → 'checked_out' if all rooms are now terminal.
--
-- NOTE: For deliberate early departure tracking use cancel_booking_room with
--   p_status = 'checked_out_early'. This function is for normal end-of-stay.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.checkout_booking_room(
  p_booking_room_id       UUID,
  p_actual_checkout_date  DATE     DEFAULT NULL,  -- NULL = stayed to scheduled date
  p_early_nights_deducted INTEGER  DEFAULT 0,
  p_deduction_amount      NUMERIC  DEFAULT 0
) RETURNS VOID
LANGUAGE plpgsql AS $$
DECLARE
  v_booking_id    UUID;
  v_room_id       UUID;
  v_active_count  INTEGER;
BEGIN
  -- Read context
  SELECT booking_id, room_id
  INTO   v_booking_id, v_room_id
  FROM   public.booking_rooms
  WHERE  id = p_booking_room_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'booking_room % not found', p_booking_room_id;
  END IF;

  -- Update this room's row
  UPDATE public.booking_rooms
  SET status                 = 'checked_out',
      checked_out_at         = NOW(),
      actual_checkout_date   = COALESCE(p_actual_checkout_date, check_out_date),
      early_nights_deducted  = p_early_nights_deducted,
      early_deduction_amount = p_deduction_amount,
      -- Adjust nights and check_out_date if early departure was recorded
      nights                 = CASE WHEN p_early_nights_deducted > 0
                                 THEN nights - p_early_nights_deducted
                                 ELSE nights END,
      check_out_date         = CASE WHEN p_actual_checkout_date IS NOT NULL
                                 THEN p_actual_checkout_date
                                 ELSE check_out_date END,
      updated_at             = NOW()
  WHERE id = p_booking_room_id;

  -- Deduct unused nights from booking total (fires trg_sync_payment_status)
  IF p_deduction_amount > 0 THEN
    UPDATE public.bookings
    SET total_amount = GREATEST(0, total_amount - p_deduction_amount)
    WHERE id = v_booking_id;
  END IF;

  -- Set physical room to cleaning
  UPDATE public.rooms
  SET    status     = 'cleaning',
         updated_at = NOW()
  WHERE  id = v_room_id;

  -- Advance booking to checked_out if no rooms are still active
  SELECT COUNT(*) INTO v_active_count
  FROM   public.booking_rooms
  WHERE  booking_id = v_booking_id
    AND  status IN ('confirmed', 'checked_in');

  IF v_active_count = 0 THEN
    -- trg_stamp_booking_timestamps will stamp checked_out_at on bookings
    UPDATE public.bookings
    SET status = 'checked_out'
    WHERE id = v_booking_id
      AND status IS DISTINCT FROM 'checked_out';
  END IF;

END;
$$;

COMMENT ON FUNCTION public.checkout_booking_room IS
  'Checks out one room. Sets status=checked_out, room=cleaning. Handles early deductions. Advances booking to checked_out when last room completes.';


-- ═══════════════════════════════════════════════════════════════════════════
-- 5. cancel_booking_room
--
-- Per-room cancellation or early departure. Two modes:
--
--   p_status = 'cancelled'
--     • Room was confirmed (never checked in). No charge.
--     • Sets rooms.status → 'available'.
--     • Deducts this room's full planned contribution from bookings.total_amount.
--
--   p_status = 'checked_out_early'
--     • Room was checked_in; guest is leaving before scheduled check_out_date.
--     • p_actual_check_out (required) is the departure date.
--     • Deducts unused nights × booking_rate from bookings.total_amount.
--     • Sets rooms.status → 'cleaning'.
--
-- After either operation:
--   • Calls update_booking_total to recompute bookings.total_amount.
--   • Derives and sets booking-level status from the updated room statuses.
--
-- Booking-level status derivation (per docs/multi-room-design.md § 5):
--   All rooms cancelled, none ever checked_in  → booking = 'cancelled'
--   At least one room checked_in               → booking = 'checked_in'
--   All rooms terminal (no confirmed/checked_in)→ booking = 'checked_out'
--   At least one confirmed, none checked_in    → booking = 'confirmed'
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.cancel_booking_room(
  p_booking_room_id  UUID,
  p_status           TEXT,                -- 'cancelled' | 'checked_out_early'
  p_actual_check_out DATE  DEFAULT NULL   -- required when p_status = 'checked_out_early'
) RETURNS VOID
LANGUAGE plpgsql AS $$
DECLARE
  v_booking_id           UUID;
  v_room_id              UUID;
  v_current_status       public.booking_status;
  v_check_out_date       DATE;
  v_booking_rate         NUMERIC;
  v_nights               SMALLINT;
  v_early_nights         INTEGER;
  v_deduction_amount     NUMERIC;
  v_derived_status       public.booking_status;
BEGIN

  -- ── Read current booking_rooms row ────────────────────────────────────
  SELECT booking_id, room_id, status, check_out_date, booking_rate, nights
  INTO   v_booking_id, v_room_id, v_current_status,
         v_check_out_date, v_booking_rate, v_nights
  FROM   public.booking_rooms
  WHERE  id = p_booking_room_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'booking_room % not found', p_booking_room_id;
  END IF;

  -- ── Validate transition ───────────────────────────────────────────────
  IF p_status NOT IN ('cancelled', 'checked_out_early') THEN
    RAISE EXCEPTION 'Invalid p_status ''%''. Must be ''cancelled'' or ''checked_out_early''.', p_status;
  END IF;

  IF p_status = 'cancelled' AND v_current_status <> 'confirmed' THEN
    RAISE EXCEPTION
      'Can only cancel a room with status=confirmed. Current status: %', v_current_status;
  END IF;

  IF p_status = 'checked_out_early' AND v_current_status <> 'checked_in' THEN
    RAISE EXCEPTION
      'Can only mark checked_out_early a room with status=checked_in. Current status: %', v_current_status;
  END IF;

  IF p_status = 'checked_out_early' AND p_actual_check_out IS NULL THEN
    RAISE EXCEPTION 'p_actual_check_out is required when p_status = ''checked_out_early''.';
  END IF;

  IF p_status = 'checked_out_early'
     AND p_actual_check_out > v_check_out_date THEN
    RAISE EXCEPTION
      'p_actual_check_out (%) cannot be after scheduled check_out_date (%). Use extend_booking_room instead.',
      p_actual_check_out, v_check_out_date;
  END IF;

  -- ── Apply per-status update ───────────────────────────────────────────

  IF p_status = 'checked_out_early' THEN

    v_early_nights     := GREATEST(0, v_check_out_date - p_actual_check_out);
    v_deduction_amount := v_early_nights::NUMERIC * v_booking_rate;

    UPDATE public.booking_rooms
    SET status                 = 'checked_out_early'::public.booking_status,
        actual_checkout_date   = p_actual_check_out,
        early_nights_deducted  = v_early_nights,
        early_deduction_amount = v_deduction_amount,
        -- Shrink check_out_date and nights to reflect actual stay
        check_out_date         = p_actual_check_out,
        nights                 = v_nights - v_early_nights,
        checked_out_at         = NOW(),
        updated_at             = NOW()
    WHERE id = p_booking_room_id;

    -- Room goes to cleaning
    UPDATE public.rooms
    SET    status = 'cleaning', updated_at = NOW()
    WHERE  id = v_room_id;

  ELSIF p_status = 'cancelled' THEN

    UPDATE public.booking_rooms
    SET status       = 'cancelled'::public.booking_status,
        cancelled_at = NOW(),
        updated_at   = NOW()
    WHERE id = p_booking_room_id;

    -- Room goes back to available
    UPDATE public.rooms
    SET    status = 'available', updated_at = NOW()
    WHERE  id = v_room_id;

  END IF;

  -- ── Recompute booking total ───────────────────────────────────────────
  -- update_booking_total sums non-cancelled rooms + extras.
  -- Also fires trg_sync_payment_status via total_amount update.
  PERFORM public.update_booking_total(v_booking_id);

  -- ── Derive and sync booking-level status ─────────────────────────────
  -- Per docs/multi-room-design.md § 5 sync rules.
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

  -- Only write if status actually changed (avoids no-op trigger re-stamps)
  UPDATE public.bookings
  SET    status = v_derived_status
  WHERE  id = v_booking_id
    AND  status IS DISTINCT FROM v_derived_status;

END;
$$;

COMMENT ON FUNCTION public.cancel_booking_room IS
  'Cancels one room (pre-checkin) or marks it checked_out_early (mid-stay departure). Recomputes total_amount. Syncs booking-level status per Section 5 rules.';


-- ═══════════════════════════════════════════════════════════════════════════
-- 6. extend_booking_room
--
-- Extends the check_out_date for one room to p_new_check_out.
-- p_new_check_out must be AFTER the current check_out_date.
--
-- Conflict check: raises EXCEPTION if another booking_rooms row for the same
-- physical room overlaps the extension window [current_checkout, new_checkout).
--
-- Updates booking_rooms.check_out_date, nights, and updated_at.
-- Adds the additional room-nights cost to bookings.total_amount.
--
-- Room status is NOT changed (stays occupied/reserved).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.extend_booking_room(
  p_booking_room_id  UUID,
  p_new_check_out    DATE
) RETURNS VOID
LANGUAGE plpgsql AS $$
DECLARE
  v_booking_id        UUID;
  v_room_id           UUID;
  v_current_checkout  DATE;
  v_booking_rate      NUMERIC;
  v_current_nights    SMALLINT;
  v_extra_nights      INTEGER;
  v_extra_amount      NUMERIC;
  v_conflict_count    INTEGER;
BEGIN

  -- ── Read current booking_rooms row ────────────────────────────────────
  SELECT booking_id, room_id, check_out_date, booking_rate, nights
  INTO   v_booking_id, v_room_id, v_current_checkout, v_booking_rate, v_current_nights
  FROM   public.booking_rooms
  WHERE  id = p_booking_room_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'booking_room % not found', p_booking_room_id;
  END IF;

  -- ── Validate ──────────────────────────────────────────────────────────
  IF p_new_check_out <= v_current_checkout THEN
    RAISE EXCEPTION
      'p_new_check_out (%) must be after current check_out_date (%). Use cancel_booking_room for early departure.',
      p_new_check_out, v_current_checkout;
  END IF;

  -- ── Conflict check (extension window only) ────────────────────────────
  -- Does any other active booking_rooms row for the same room overlap
  -- the extension window [current_checkout, new_checkout)?
  --
  -- Standard half-open interval overlap: A and B overlap when
  --   A.check_in_date < B.check_out_date AND B.check_in_date < A.check_out_date
  --
  -- Extension window: check_in = current_checkout, check_out = new_checkout
  -- So conflict when: other.check_in_date < new_checkout
  --               AND other.check_out_date > current_checkout
  SELECT COUNT(*) INTO v_conflict_count
  FROM   public.booking_rooms
  WHERE  room_id    = v_room_id
    AND  id        <> p_booking_room_id
    AND  status    IN ('confirmed', 'checked_in')
    AND  check_in_date  < p_new_check_out
    AND  check_out_date > v_current_checkout;

  IF v_conflict_count > 0 THEN
    RAISE EXCEPTION
      'Room % is already booked for dates that overlap the extension window (% → %). Cannot extend.',
      v_room_id, v_current_checkout, p_new_check_out;
  END IF;

  -- ── Compute extension ─────────────────────────────────────────────────
  v_extra_nights := p_new_check_out - v_current_checkout;  -- integer (days)
  v_extra_amount := v_extra_nights::NUMERIC * v_booking_rate;

  -- ── Update booking_rooms ──────────────────────────────────────────────
  UPDATE public.booking_rooms
  SET check_out_date = p_new_check_out,
      nights         = v_current_nights + v_extra_nights,
      updated_at     = NOW()
  WHERE id = p_booking_room_id;

  -- ── Update bookings.total_amount ──────────────────────────────────────
  -- Direct increment is safe here (no cancelled-room edge case).
  -- Also fires trg_sync_payment_status via total_amount change.
  UPDATE public.bookings
  SET total_amount = total_amount + v_extra_amount
  WHERE id = v_booking_id;

  -- Also extend the backward-compat check_out_date on bookings if this
  -- is the latest room checkout (keeps legacy reads accurate).
  UPDATE public.bookings
  SET check_out_date = p_new_check_out
  WHERE id = v_booking_id
    AND p_new_check_out > check_out_date;

END;
$$;

COMMENT ON FUNCTION public.extend_booking_room IS
  'Extends check_out_date for one room. Conflict-checks before committing. Adds extra nights cost to bookings.total_amount.';


-- ===========================================================================
-- GRANT execution to authenticated role (Supabase pattern)
-- ===========================================================================

GRANT EXECUTE ON FUNCTION public.update_booking_total(UUID)             TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_booking_with_rooms              TO authenticated;
GRANT EXECUTE ON FUNCTION public.add_room_to_booking                    TO authenticated;
GRANT EXECUTE ON FUNCTION public.checkout_booking_room                  TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_booking_room                    TO authenticated;
GRANT EXECUTE ON FUNCTION public.extend_booking_room                    TO authenticated;


-- ===========================================================================
-- VERIFICATION — confirm all functions exist
-- ===========================================================================

SELECT
  p.proname                                      AS function_name,
  pg_catalog.pg_get_function_identity_arguments(p.oid) AS arguments
FROM pg_catalog.pg_proc p
JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
    'update_booking_total',
    'create_booking_with_rooms',
    'add_room_to_booking',
    'checkout_booking_room',
    'cancel_booking_room',
    'extend_booking_room'
  )
ORDER BY p.proname;

-- ===========================================================================
-- END OF RPC FUNCTIONS FILE
-- ===========================================================================

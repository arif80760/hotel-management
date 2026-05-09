-- ===========================================================================
-- Phase 7: mid-stay RPC updates — add_room, extend_room, cancel_room
-- File:    sql/migrations/2026-05-09-phase7-rpc-updates.sql
-- Date:    2026-05-09
-- Apply:   AFTER 2026-05-08-multi-room-rpc.sql
--
-- Changes in this file:
--
--   1. add_room_to_booking
--      Replace the incremental `UPDATE bookings SET total_amount = total_amount + delta`
--      with a call to update_booking_total(). This ensures the total stays
--      consistent even if a race or prior drift occurred, and eliminates a
--      class of bugs where the delta is computed from stale client values.
--      Signature unchanged → CREATE OR REPLACE (no DROP needed).
--
--   2. extend_booking_room
--      Same incremental-to-recompute replacement.  The backward-compat
--      check_out_date shim UPDATE on bookings is kept intact.
--      Signature unchanged → CREATE OR REPLACE (no DROP needed).
--
--   3. cancel_booking_room
--      • Adds three optional refund parameters:
--            p_refund_amount     NUMERIC  DEFAULT NULL
--            p_refund_reason     TEXT     DEFAULT NULL
--            p_refund_created_by UUID     DEFAULT NULL
--      • Changes return type: VOID → UUID  (refund id, or NULL if no refund).
--      • Inserts a refund row when p_refund_amount IS NOT NULL AND > 0.
--
--      IMPORTANT — return-type change requires a DROP before CREATE OR REPLACE:
--      PostgreSQL treats functions with different return types as different
--      overloads; CREATE OR REPLACE cannot change a return type in-place.
--      DROP FUNCTION IF EXISTS targets the old 3-parameter signature exactly
--      so no other overloads are affected.
--
-- Existing callers:
--   • cancel_booking_room — all existing 3-param callers continue to work.
--     The new params have DEFAULT NULL so they are optional.  The return
--     value (refund UUID or NULL) is newly available; callers that ignore it
--     continue to compile fine.
-- ===========================================================================


-- ===========================================================================
-- 1. add_room_to_booking  (signature unchanged — CREATE OR REPLACE is safe)
--    Only change: replace delta total_amount UPDATE with update_booking_total().
-- ===========================================================================

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

  -- Recompute booking total via update_booking_total().
  -- Replaces the previous incremental delta UPDATE — this is authoritative
  -- and immune to drift from prior edits or cancelled rooms.
  PERFORM public.update_booking_total(p_booking_id);

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
  'Adds a room to an existing booking (mid-stay or pre-arrival). '
  'Calls update_booking_total() to recompute total_amount. Sets physical room status.';


-- ===========================================================================
-- 2. extend_booking_room  (signature unchanged — CREATE OR REPLACE is safe)
--    Only change: replace delta total_amount UPDATE with update_booking_total().
--    The backward-compat bookings.check_out_date shim UPDATE is preserved.
-- ===========================================================================

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

  -- ── Update booking_rooms ──────────────────────────────────────────────
  UPDATE public.booking_rooms
  SET check_out_date = p_new_check_out,
      nights         = v_current_nights + v_extra_nights,
      updated_at     = NOW()
  WHERE id = p_booking_room_id;

  -- ── Recompute bookings.total_amount ───────────────────────────────────
  -- update_booking_total() sums non-cancelled booking_rooms + extras.
  -- Replaces the previous incremental delta UPDATE — authoritative and
  -- consistent across concurrent edits or prior cancelled rooms.
  PERFORM public.update_booking_total(v_booking_id);

  -- ── Backward-compat: extend bookings.check_out_date if this is latest ─
  -- Keeps the legacy column accurate for callsites that haven't migrated.
  UPDATE public.bookings
  SET check_out_date = p_new_check_out
  WHERE id = v_booking_id
    AND p_new_check_out > check_out_date;

END;
$$;

COMMENT ON FUNCTION public.extend_booking_room IS
  'Extends check_out_date for one room. Conflict-checks before committing. '
  'Calls update_booking_total() to recompute booking total_amount.';


-- ===========================================================================
-- 3. cancel_booking_room  (return type change: VOID → UUID)
--
--    Must DROP the old 3-parameter VOID signature first because PostgreSQL
--    cannot change a function's return type via CREATE OR REPLACE — it would
--    create a separate overload instead of replacing the existing function.
--    DROP IF EXISTS is idempotent and safe on a fresh DB.
-- ===========================================================================

DROP FUNCTION IF EXISTS public.cancel_booking_room(
  uuid,    -- p_booking_room_id
  text,    -- p_status
  date     -- p_actual_check_out
);

CREATE OR REPLACE FUNCTION public.cancel_booking_room(
  p_booking_room_id   UUID,
  p_status            TEXT,                  -- 'cancelled' | 'checked_out_early'
  p_actual_check_out  DATE    DEFAULT NULL,  -- required when p_status = 'checked_out_early'
  p_refund_amount     NUMERIC DEFAULT NULL,  -- NULL = no refund record
  p_refund_reason     TEXT    DEFAULT NULL,
  p_refund_created_by UUID    DEFAULT NULL
) RETURNS UUID  -- refund id if a refund row was created; NULL otherwise
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
  v_refund_id            UUID := NULL;
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

  -- ── Optional refund record ────────────────────────────────────────────
  -- Only created when caller explicitly passes p_refund_amount > 0.
  -- NULL amount = operator chose not to issue a refund (no row written).
  IF p_refund_amount IS NOT NULL AND p_refund_amount > 0 THEN
    INSERT INTO public.refunds (
      booking_id,
      booking_room_id,
      amount,
      reason,
      created_by
    ) VALUES (
      v_booking_id,
      p_booking_room_id,
      p_refund_amount,
      p_refund_reason,
      p_refund_created_by
    )
    RETURNING id INTO v_refund_id;
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

  -- Return refund id (NULL if no refund was created)
  RETURN v_refund_id;

END;
$$;

COMMENT ON FUNCTION public.cancel_booking_room IS
  'Cancels one room (pre-checkin) or marks it checked_out_early (mid-stay departure). '
  'Optionally creates a refund record (p_refund_amount, p_refund_reason, p_refund_created_by). '
  'Returns the refund UUID if a refund row was created, or NULL otherwise. '
  'Calls update_booking_total() to recompute total_amount. '
  'Derives and syncs booking-level status per Section 5 rules.';


-- ===========================================================================
-- GRANT execution (re-grant after DROP/CREATE cycle on cancel_booking_room)
-- ===========================================================================

GRANT EXECUTE ON FUNCTION public.add_room_to_booking    TO authenticated;
GRANT EXECUTE ON FUNCTION public.extend_booking_room    TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_booking_room    TO authenticated;


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
  AND p.proname IN (
    'add_room_to_booking',
    'extend_booking_room',
    'cancel_booking_room'
  )
ORDER BY p.proname;

-- Expected output:
--   add_room_to_booking   | p_booking_id uuid, ...  | uuid
--   cancel_booking_room   | p_booking_room_id uuid, p_status text,
--                         |   p_actual_check_out date, p_refund_amount numeric,
--                         |   p_refund_reason text, p_refund_created_by uuid  | uuid
--   extend_booking_room   | p_booking_room_id uuid, p_new_check_out date      | void

-- ===========================================================================
-- END OF MIGRATION
-- ===========================================================================

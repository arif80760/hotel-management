-- ===========================================================================
-- Enforce total_amount = SUM(rate × nights) invariant on booking creation
-- File:    sql/migrations/2026-05-08-create-booking-total-cross-check.sql
-- Date:    2026-05-08
-- Apply:   After 2026-05-08-rpc-add-status-param.sql
--
-- Problem:
--   create_booking_with_rooms accepted p_total_amount from the client
--   without cross-checking it against the room subtotals in p_rooms.
--   If the client's grandTotal memo was stale, wrong, or diverged from
--   the per-room rates at submit time, an incorrect total_amount was
--   persisted permanently (BK-1060: stored 45000, actual 30000).
--
-- Fix:
--   Before the INSERT into bookings, compute the expected total from
--   p_rooms[*].rate × p_rooms[*].nights and raise an exception if
--   p_total_amount differs by more than 0.01 (epsilon for NUMERIC
--   arithmetic, though NUMERIC is exact — safety margin).
--
-- Signature: matches the 9-parameter version introduced in
--   2026-05-08-rpc-add-status-param.sql exactly. No DROP needed —
--   CREATE OR REPLACE replaces the exact same signature in place.
--
-- p_rooms JSON key names (per original function schema):
--   "rate"   → booking_rate  (NUMERIC)
--   "nights" → nights        (integer)
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.create_booking_with_rooms(
  p_booking_ref        TEXT,
  p_primary_guest_id   UUID,
  p_total_guests       SMALLINT,
  p_rooms              JSONB,        -- array of room specs
  p_total_amount       NUMERIC,
  p_initial_payment    NUMERIC     DEFAULT 0,
  p_payment_method     TEXT        DEFAULT NULL,
  p_recorded_by        UUID        DEFAULT NULL,
  p_status             TEXT        DEFAULT 'confirmed'  -- 'confirmed' | 'checked_in'
) RETURNS UUID
LANGUAGE plpgsql AS $$
DECLARE
  v_booking_id           UUID;
  v_room                 JSONB;
  v_first_room_id        UUID;
  v_first_check_in       DATE;
  v_first_check_out      DATE;
  v_first_category       public.room_category;
  v_booking_status       public.booking_status;
  v_physical_room_status public.room_status;
  v_expected_total       NUMERIC;   -- computed from p_rooms; compared to p_total_amount
BEGIN
  -- ── Guard: cross-check p_total_amount against room subtotals ──────────────
  -- Prevents a stale or incorrect client grandTotal from being persisted.
  -- Uses the same keys the booking_rooms INSERT reads: 'rate' and 'nights'.
  SELECT COALESCE(
    SUM( (r->>'rate')::NUMERIC * (r->>'nights')::INTEGER ),
    0
  )
  INTO v_expected_total
  FROM jsonb_array_elements(p_rooms) AS r;

  IF ABS(p_total_amount - v_expected_total) > 0.01 THEN
    RAISE EXCEPTION
      'create_booking_with_rooms: total_amount mismatch — '
      'provided %, computed % from rooms. '
      'Ensure the client grandTotal equals SUM(rate × nights) across all rooms.',
      p_total_amount, v_expected_total;
  END IF;

  -- ── Validate p_status ────────────────────────────────────────────────────
  IF p_status NOT IN ('confirmed', 'checked_in') THEN
    RAISE EXCEPTION
      'Invalid p_status ''%''. create_booking_with_rooms only accepts '
      '''confirmed'' or ''checked_in''. '
      'Use checkout_booking_room or cancel_booking_room for terminal statuses.',
      p_status;
  END IF;

  v_booking_status       := p_status::public.booking_status;
  v_physical_room_status := CASE p_status
    WHEN 'checked_in' THEN 'occupied'::public.room_status
    ELSE                   'reserved'::public.room_status
  END;

  -- ── Pull first-room values for backward-compat columns on bookings ───────
  v_first_room_id   := (p_rooms->0->>'room_id')::UUID;
  v_first_check_in  := (p_rooms->0->>'check_in_date')::DATE;
  v_first_check_out := (p_rooms->0->>'check_out_date')::DATE;
  v_first_category  := (p_rooms->0->>'category')::public.room_category;

  -- ── a) Insert booking shell ───────────────────────────────────────────────
  -- fn_stamp_booking_timestamps fires on UPDATE only, not INSERT.
  -- Timestamps must therefore be stamped explicitly here.
  INSERT INTO public.bookings (
    booking_ref,
    primary_guest_id,
    total_guests,
    status,
    total_amount,
    paid_amount,
    payment_status,
    confirmed_at,
    checked_in_at,

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
    v_booking_status,
    p_total_amount,
    0,
    'unpaid',
    NOW(),                                                         -- confirmed_at (always set)
    CASE WHEN p_status = 'checked_in' THEN NOW() ELSE NULL END,   -- checked_in_at

    v_first_room_id,
    v_first_check_in,
    v_first_check_out,
    v_first_category
  )
  RETURNING id INTO v_booking_id;

  -- ── b) Insert booking_rooms rows + c) set physical room status ───────────
  -- No timestamp trigger on booking_rooms — stamp confirmed_at / checked_in_at
  -- directly in the INSERT based on p_status.
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
      confirmed_at,
      checked_in_at
    ) VALUES (
      v_booking_id,
      (v_room->>'room_id')::UUID,
      (v_room->>'check_in_date')::DATE,
      (v_room->>'check_out_date')::DATE,
      (v_room->>'nights')::SMALLINT,
      (v_room->>'category')::public.room_category,
      (v_room->>'rate')::NUMERIC,
      v_booking_status,
      NOW(),                                                         -- confirmed_at (always set)
      CASE WHEN p_status = 'checked_in' THEN NOW() ELSE NULL END    -- checked_in_at
    );

    -- Set physical room status (fn_sync_room_status trigger was retired in
    -- 2026-05-08-multi-room-foundation.sql; RPCs own rooms.status directly).
    UPDATE public.rooms
    SET    status     = v_physical_room_status,
           updated_at = NOW()
    WHERE  id = (v_room->>'room_id')::UUID;
  END LOOP;

  -- ── d) Initial payment (if provided) ─────────────────────────────────────
  -- Fires trg_sync_paid_amount (bookings.paid_amount +=) and
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
  'Creates a booking with N rooms atomically. Returns booking UUID. '
  'Raises an exception if p_total_amount ≠ SUM(rate × nights) across p_rooms '
  '(enforces the total_amount invariant at the DB boundary). '
  'p_status controls initial status: ''confirmed'' (default) or ''checked_in'' (walk-in). '
  'Sets bookings.status, booking_rooms.status, and rooms.status consistently. '
  'Stamps lifecycle timestamps manually (fn_stamp_booking_timestamps fires on UPDATE only). '
  'Called via supabase.rpc() from bookingsService.ts.';

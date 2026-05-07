-- ===========================================================================
-- Migration: create_booking_with_rooms — add p_status parameter
-- File:    sql/migrations/2026-05-08-rpc-add-status-param.sql
-- Date:    2026-05-08
-- Apply:   AFTER 2026-05-08-multi-room-rpc.sql
--
-- Problem: create_booking_with_rooms hardcoded status='confirmed' in both
--          bookings and booking_rooms rows, ignoring any status the caller
--          intended (e.g. a walk-in guest that should be immediately
--          checked in).  Discovered during Phase 5.2 smoke test.
--
-- Change:
--   Adds p_status TEXT DEFAULT 'confirmed' as the last parameter so all
--   existing callers continue to work without change.
--
--   Allowed values: 'confirmed' | 'checked_in'
--   Any other value raises EXCEPTION — 'cancelled', 'checked_out', and
--   'checked_out_early' cannot be the initial status of a new booking.
--
-- Status propagation rules (per decision 2026-05-08):
--
--   p_status = 'confirmed':
--     bookings.status        = 'confirmed'
--     booking_rooms.status   = 'confirmed'
--     rooms.status           = 'reserved'
--     bookings.confirmed_at  = NOW()   (trigger doesn't fire on INSERT)
--     bookings.checked_in_at = NULL
--     booking_rooms.confirmed_at  = NOW()
--     booking_rooms.checked_in_at = NULL
--
--   p_status = 'checked_in':
--     bookings.status        = 'checked_in'
--     booking_rooms.status   = 'checked_in'
--     rooms.status           = 'occupied'
--     bookings.confirmed_at  = NOW()   (walk-in still has a confirmed_at; mirrors
--     bookings.checked_in_at = NOW()    how fn_stamp_booking_timestamps preserves
--     booking_rooms.confirmed_at  = NOW() confirmed_at when transitioning confirmed→
--     booking_rooms.checked_in_at = NOW() checked_in via UPDATE)
--
-- Trigger note:
--   fn_stamp_booking_timestamps fires BEFORE UPDATE OF status ON bookings —
--   it does NOT fire on INSERT.  Timestamps are therefore stamped manually
--   inside this function.  Same applies to booking_rooms (no timestamp
--   trigger exists on that table).
-- ===========================================================================


-- Drop the old 8-parameter version if it exists.
-- Required because CREATE OR REPLACE only replaces an exact signature match —
-- adding p_status creates a new overload instead of replacing the old one.
-- DROP IF EXISTS makes this idempotent (safe to re-run on a fresh DB).
DROP FUNCTION IF EXISTS public.create_booking_with_rooms(
  text, uuid, smallint, jsonb, numeric, numeric, text, uuid
);

CREATE OR REPLACE FUNCTION public.create_booking_with_rooms(
  p_booking_ref        TEXT,
  p_primary_guest_id   UUID,
  p_total_guests       SMALLINT,
  p_rooms              JSONB,        -- array of room specs
  p_total_amount       NUMERIC,
  p_initial_payment    NUMERIC     DEFAULT 0,
  p_payment_method     TEXT        DEFAULT NULL,
  p_recorded_by        UUID        DEFAULT NULL,
  p_status             TEXT        DEFAULT 'confirmed'  -- NEW: 'confirmed' | 'checked_in'
) RETURNS UUID
LANGUAGE plpgsql AS $$
DECLARE
  v_booking_id          UUID;
  v_room                JSONB;
  v_first_room_id       UUID;
  v_first_check_in      DATE;
  v_first_check_out     DATE;
  v_first_category      public.room_category;
  v_booking_status      public.booking_status;
  v_physical_room_status public.room_status;
BEGIN
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
    NOW(),                                                         -- confirmed_at (always set; mirrors trigger pattern where confirmed_at is preserved on confirmed→checked_in transition)
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
      CASE WHEN p_status = 'checked_in' THEN NOW() ELSE NULL END   -- checked_in_at
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
  'p_status controls initial status: ''confirmed'' (default) or ''checked_in'' (walk-in). '
  'Sets bookings.status, booking_rooms.status, and rooms.status consistently. '
  'Stamps lifecycle timestamps manually (fn_stamp_booking_timestamps fires on UPDATE only). '
  'Called via supabase.rpc() from bookingsService.ts.';


-- ===========================================================================
-- VERIFICATION — confirm new signature includes p_status
-- ===========================================================================
SELECT
  p.proname                                                          AS function_name,
  pg_catalog.pg_get_function_identity_arguments(p.oid)              AS arguments
FROM pg_catalog.pg_proc p
JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname = 'create_booking_with_rooms';

-- Expected output:
--   function_name              | arguments
--   create_booking_with_rooms  | p_booking_ref text, p_primary_guest_id uuid,
--                              |   p_total_guests smallint, p_rooms jsonb,
--                              |   p_total_amount numeric, p_initial_payment numeric,
--                              |   p_payment_method text, p_recorded_by uuid,
--                              |   p_status text     <-- NEW

-- ===========================================================================
-- END OF MIGRATION
-- ===========================================================================

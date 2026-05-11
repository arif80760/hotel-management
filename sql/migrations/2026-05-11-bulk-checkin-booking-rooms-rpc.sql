-- Migration: sql/migrations/2026-05-11-bulk-checkin-booking-rooms-rpc.sql
-- Phase 7.6 — Bulk per-room check-in
-- Atomic preflight + commit. Mirrors checkin_booking_room single-room logic
-- across N rooms in one RPC call.

CREATE OR REPLACE FUNCTION public.bulk_checkin_booking_rooms(
  p_booking_room_ids UUID[],
  p_force_future     BOOLEAN DEFAULT FALSE
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_today          DATE := CURRENT_DATE;
  v_failures       JSONB := '[]'::JSONB;
  v_booking_ids    UUID[];
  v_room_ids       UUID[];
  v_input_count    INT;
  v_found_count    INT;
  v_booking_id     UUID;
  v_derived_status public.booking_status;
BEGIN
  -- 0. Empty input guard
  IF p_booking_room_ids IS NULL OR array_length(p_booking_room_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'No booking_room_ids provided';
  END IF;

  v_input_count := array_length(p_booking_room_ids, 1);

  -- 1. PREFLIGHT: collect all failures before mutating anything
  -- 1a. Validate existence (all IDs must resolve)
  SELECT COUNT(*) INTO v_found_count
  FROM public.booking_rooms
  WHERE id = ANY(p_booking_room_ids);

  IF v_found_count <> v_input_count THEN
    RAISE EXCEPTION 'One or more booking_room_ids not found (expected %, found %)',
                     v_input_count, v_found_count;
  END IF;

  -- 1b. Validate status (must be 'confirmed')
  -- 1c. Validate dates (warn future unless force=true)
  WITH preflight AS (
    SELECT br.id,
           br.status,
           br.check_in_date,
           r.room_number
      FROM public.booking_rooms br
      JOIN public.rooms r ON r.id = br.room_id
     WHERE br.id = ANY(p_booking_room_ids)
  )
  SELECT COALESCE(jsonb_agg(failure), '[]'::jsonb)
    INTO v_failures
    FROM (
      SELECT jsonb_build_object(
               'booking_room_id', id,
               'room_number',     room_number,
               'reason',
                 CASE
                   WHEN status = 'checked_in' THEN
                     format('Room %s already checked in', room_number)
                   WHEN status <> 'confirmed' THEN
                     format('Room %s is %s (must be confirmed)', room_number, status)
                   WHEN check_in_date > v_today AND NOT p_force_future THEN
                     format('Room %s scheduled for %s (future date)',
                            room_number, check_in_date::text)
                 END
             ) AS failure
        FROM preflight
       WHERE status <> 'confirmed'
          OR (check_in_date > v_today AND NOT p_force_future)
    ) f;

  -- 2. ABORT if any preflight failures (atomic — no partial state)
  IF jsonb_array_length(v_failures) > 0 THEN
    RETURN jsonb_build_object(
      'success',    false,
      'checked_in', '[]'::jsonb,
      'failures',   v_failures
    );
  END IF;

  -- 3. COMMIT — mirror per-room logic across all rooms

  -- 3a. Update booking_rooms (all in one statement)
  UPDATE public.booking_rooms
     SET status        = 'checked_in',
         checked_in_at = NOW(),
         updated_at    = NOW()
   WHERE id = ANY(p_booking_room_ids);

  -- 3b. Update physical rooms (collect distinct room_ids first)
  SELECT array_agg(DISTINCT room_id) INTO v_room_ids
    FROM public.booking_rooms
   WHERE id = ANY(p_booking_room_ids);

  UPDATE public.rooms
     SET status     = 'occupied',
         updated_at = NOW()
   WHERE id = ANY(v_room_ids);

  -- 3c. Derive + sync parent bookings.status for each affected booking
  SELECT array_agg(DISTINCT booking_id) INTO v_booking_ids
    FROM public.booking_rooms
   WHERE id = ANY(p_booking_room_ids);

  FOREACH v_booking_id IN ARRAY v_booking_ids LOOP
    SELECT CASE
      WHEN COUNT(*) = COUNT(*) FILTER (WHERE status = 'cancelled') THEN 'cancelled'
      WHEN COUNT(*) FILTER (WHERE status = 'checked_in') > 0       THEN 'checked_in'
      WHEN COUNT(*) FILTER (WHERE status IN ('confirmed','checked_in')) = 0 THEN 'checked_out'
      ELSE 'confirmed'
    END
    INTO v_derived_status
    FROM public.booking_rooms WHERE booking_id = v_booking_id;

    UPDATE public.bookings
       SET status = v_derived_status
     WHERE id = v_booking_id
       AND status IS DISTINCT FROM v_derived_status;
  END LOOP;

  -- 4. Return success payload
  RETURN jsonb_build_object(
    'success',    true,
    'checked_in', to_jsonb(p_booking_room_ids),
    'failures',   '[]'::jsonb
  );
END;
$$;

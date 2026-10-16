-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-10-16 — Check-in per-row date guard (BK-2118). RECORD OF LIVE STATE —
-- applied by Arif in the Supabase SQL editor on 2026-10-16 and
-- probe-verified the same day.
--
-- Incident BK-2118: a 6-room staged booking (check-ins Oct 13/16/17) was
-- checked in at booking level on Oct 13 — checkin_booking_atomic cascaded
-- EVERY confirmed row with no date validation, flipping the Oct 16/17 rooms
-- too (all six rows carried the identical checked_in_at; one
-- booking.checked_in activity entry). The client gate (canCheckInToday)
-- checked only the booking-level EARLIEST date, so a staged booking became
-- fully flippable the moment room 1's day arrived. Sweep found the same
-- class on BK-2179 (room 110) and BK-2178 (room 101): cascades on Oct 16
-- grabbed Oct 17 rows. Data corrected 2026-10-16 (rows reverted to
-- confirmed, checked_in_at cleared, physical room statuses recomputed,
-- booking statuses re-derived; BK-2118's 406 left confirmed-not-cancelled
-- deliberately — Arif cancels it through the normal flow for the activity
-- trail).
--
-- Changes (all three check-in RPCs):
--
-- 1. checkin_booking_atomic — DROP + CREATE (return type void → jsonb):
--    • checked_in cascade flips ONLY confirmed rows with
--      check_in_date <= (now() AT TIME ZONE 'Asia/Dhaka')::date —
--      back-dating allowed, future rows stay confirmed until their day;
--    • RAISES fail-loud when ZERO rows are eligible (names Dhaka-today and
--      the earliest scheduled date) — an all-future booking cannot check in;
--    • returns {checked_in_count, skipped:[{room_number, check_in_date}]}
--      so the client reports "N rooms checked in, M remain scheduled";
--    • booking status DERIVED from rows after the cascade (same CASE as
--      checkin_booking_room / bulk), not forced;
--    • flipped rooms now go physically 'occupied' (the old RPC never
--      touched rooms.status — why BK-2118's checked-in rooms sat
--      'reserved'); the undo direction sets them 'reserved'.
--
-- 2. checkin_booking_room + bulk_checkin_booking_rooms — their existing
--    per-row future guards switch from CURRENT_DATE (UTC) to Dhaka-local.
--    The UTC comparison never permitted a future check-in, but wrongly
--    BLOCKED legitimate ones between midnight and 6 AM Dhaka. p_force_future
--    kept on both (deliberate override; the UI never sends true, and the
--    incident did not come through it — it came through the unguarded
--    cascade).
--
-- Client half (same batch): both canCheckInToday copies → Dhaka-local
-- (localTodayISO); HotelContext's optimistic cascade mirrors the per-row
-- date filter and changeBookingStatus returns the RPC result
-- (refetch-on-success / rollback-on-error); both action handlers surface
-- "N rooms checked in · M remain scheduled (room: date)". The per-room
-- Check In button for staged stays already existed in the expanded room
-- rows (enabled on each row's own date) — now Dhaka-gated.
-- ─────────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.checkin_booking_atomic(uuid, text);
CREATE FUNCTION public.checkin_booking_atomic(p_booking_id uuid, p_target_status text)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_today    date := (now() AT TIME ZONE 'Asia/Dhaka')::date;
  v_room_ids uuid[];
  v_count    int := 0;
  v_skipped  jsonb := '[]'::jsonb;
  v_earliest date;
  v_derived  public.booking_status;
BEGIN
  IF p_target_status NOT IN ('confirmed', 'checked_in') THEN
    RAISE EXCEPTION
      'checkin_booking_atomic: invalid target status ''%''. '
      'Use checkout_booking_room for checked_out, '
      'cancel_booking_room for cancelled/checked_out_early.',
      p_target_status;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.bookings WHERE id = p_booking_id) THEN
    RAISE EXCEPTION 'checkin_booking_atomic: booking % not found', p_booking_id;
  END IF;

  IF p_target_status = 'checked_in' THEN
    -- BK-2118: only rows whose own check-in day has arrived (Dhaka).
    WITH flipped AS (
      UPDATE public.booking_rooms
      SET status        = 'checked_in'::public.booking_status,
          checked_in_at = COALESCE(checked_in_at, NOW()),
          updated_at    = NOW()
      WHERE booking_id = p_booking_id
        AND status = 'confirmed'
        AND check_in_date <= v_today
      RETURNING room_id
    )
    SELECT array_agg(room_id) INTO v_room_ids FROM flipped;
    v_count := COALESCE(array_length(v_room_ids, 1), 0);

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'room_number', r.room_number, 'check_in_date', br.check_in_date) ORDER BY br.check_in_date), '[]'::jsonb)
    INTO v_skipped
    FROM public.booking_rooms br
    JOIN public.rooms r ON r.id = br.room_id
    WHERE br.booking_id = p_booking_id
      AND br.status = 'confirmed'
      AND br.check_in_date > v_today;

    IF v_count = 0 THEN
      SELECT MIN(check_in_date) INTO v_earliest
      FROM public.booking_rooms WHERE booking_id = p_booking_id AND status = 'confirmed';
      RAISE EXCEPTION
        'checkin_booking_atomic: no room on booking % has reached its check-in date (today is % in Dhaka; earliest scheduled is %).',
        p_booking_id, v_today, v_earliest;
    END IF;

    UPDATE public.rooms
    SET status = 'occupied'::public.room_status, updated_at = NOW()
    WHERE id = ANY (v_room_ids);

  ELSE
    -- Undo direction (admin): checked_in rows back to confirmed.
    WITH flipped AS (
      UPDATE public.booking_rooms
      SET status = 'confirmed'::public.booking_status, updated_at = NOW()
      WHERE booking_id = p_booking_id AND status = 'checked_in'
      RETURNING room_id
    )
    SELECT array_agg(room_id) INTO v_room_ids FROM flipped;
    v_count := COALESCE(array_length(v_room_ids, 1), 0);

    UPDATE public.rooms
    SET status = 'reserved'::public.room_status, updated_at = NOW()
    WHERE id = ANY (v_room_ids);
  END IF;

  -- Booking status derived from rows (same CASE as the sibling RPCs).
  SELECT CASE
    WHEN COUNT(*) = COUNT(*) FILTER (WHERE status = 'cancelled') THEN 'cancelled'
    WHEN COUNT(*) FILTER (WHERE status = 'checked_in') > 0       THEN 'checked_in'
    WHEN COUNT(*) FILTER (WHERE status IN ('confirmed','checked_in')) = 0 THEN 'checked_out'
    ELSE 'confirmed'
  END::public.booking_status
  INTO v_derived
  FROM public.booking_rooms WHERE booking_id = p_booking_id;

  UPDATE public.bookings
  SET status        = v_derived,
      checked_in_at = CASE WHEN v_derived = 'checked_in' AND checked_in_at IS NULL THEN NOW() ELSE checked_in_at END,
      updated_at    = NOW()
  WHERE id = p_booking_id;

  RETURN jsonb_build_object('checked_in_count', v_count, 'skipped', v_skipped);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.checkin_booking_atomic(uuid, text) TO authenticated;

-- checkin_booking_room: guard date UTC → Dhaka (body otherwise verbatim).
CREATE OR REPLACE FUNCTION public.checkin_booking_room(p_booking_room_id uuid, p_force_future boolean DEFAULT false)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_booking_id     UUID;
  v_room_id        UUID;
  v_status         public.booking_status;
  v_derived_status public.booking_status;
  v_check_in_date  DATE;
  v_room_number    TEXT;
  v_today          DATE := (now() AT TIME ZONE 'Asia/Dhaka')::date;
BEGIN

  SELECT booking_id, room_id, status
  INTO   v_booking_id, v_room_id, v_status
  FROM   public.booking_rooms
  WHERE  id = p_booking_room_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'booking_room % not found', p_booking_room_id;
  END IF;

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

  IF NOT p_force_future THEN
    SELECT br.check_in_date, r.room_number
    INTO   v_check_in_date, v_room_number
    FROM   public.booking_rooms br
    JOIN   public.rooms r ON r.id = br.room_id
    WHERE  br.id = p_booking_room_id;

    IF v_check_in_date > v_today THEN
      RAISE EXCEPTION
        'Cannot check in booking_room % — Room % is scheduled '
        'for % (future date). Today is % in Dhaka. '
        'Use p_force_future=TRUE to override.',
        p_booking_room_id, v_room_number, v_check_in_date, v_today;
    END IF;
  END IF;

  UPDATE public.booking_rooms
  SET    status        = 'checked_in'::public.booking_status,
         checked_in_at = NOW(),
         updated_at    = NOW()
  WHERE  id = p_booking_room_id;

  UPDATE public.rooms
  SET    status     = 'occupied'::public.room_status,
         updated_at = NOW()
  WHERE  id = v_room_id;

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

  UPDATE public.bookings
  SET    status = v_derived_status
  WHERE  id     = v_booking_id
    AND  status IS DISTINCT FROM v_derived_status;

END;
$function$;

-- bulk_checkin_booking_rooms: guard date UTC → Dhaka (body otherwise verbatim).
CREATE OR REPLACE FUNCTION public.bulk_checkin_booking_rooms(p_booking_room_ids uuid[], p_force_future boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_today          DATE := (now() AT TIME ZONE 'Asia/Dhaka')::date;
  v_failures       JSONB := '[]'::JSONB;
  v_booking_ids    UUID[];
  v_room_ids       UUID[];
  v_input_count    INT;
  v_found_count    INT;
  v_booking_id     UUID;
  v_derived_status public.booking_status;
BEGIN
  IF p_booking_room_ids IS NULL OR array_length(p_booking_room_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'No booking_room_ids provided';
  END IF;

  v_input_count := array_length(p_booking_room_ids, 1);

  SELECT COUNT(*) INTO v_found_count
  FROM public.booking_rooms
  WHERE id = ANY(p_booking_room_ids);

  IF v_found_count <> v_input_count THEN
    RAISE EXCEPTION 'One or more booking_room_ids not found (expected %, found %)',
                     v_input_count, v_found_count;
  END IF;

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

  IF jsonb_array_length(v_failures) > 0 THEN
    RETURN jsonb_build_object(
      'success',    false,
      'checked_in', '[]'::jsonb,
      'failures',   v_failures
    );
  END IF;

  UPDATE public.booking_rooms
     SET status        = 'checked_in',
         checked_in_at = NOW(),
         updated_at    = NOW()
   WHERE id = ANY(p_booking_room_ids);

  SELECT array_agg(DISTINCT room_id) INTO v_room_ids
    FROM public.booking_rooms
   WHERE id = ANY(p_booking_room_ids);

  UPDATE public.rooms
     SET status     = 'occupied',
         updated_at = NOW()
   WHERE id = ANY(v_room_ids);

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

  RETURN jsonb_build_object(
    'success',    true,
    'checked_in', to_jsonb(p_booking_room_ids),
    'failures',   '[]'::jsonb
  );
END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Verification (2026-10-16, ROLLBACK-wrapped): staged synthetic booking with
-- rows dated yesterday / today / tomorrow → checkin_booking_atomic returned
-- checked_in_count = 2 with the tomorrow row in skipped (correct date), the
-- two flipped rows checked_in + their rooms 'occupied', the tomorrow row
-- still confirmed, booking checked_in; per-room checkin_booking_room on the
-- future row raised the scheduled-date guard; an all-future booking's
-- cascade raised 'no room ... has reached its check-in date'. PASSED.
--
-- Sweep (2026-10-16): future-dated checked_in rows — BK-2118 (106, 306),
-- BK-2179 (110), BK-2178 (101); >1-day-premature checked_in_at — BK-2118
-- only (406/106/306). All corrected same day via the guarded scripts.
-- ─────────────────────────────────────────────────────────────────────────────

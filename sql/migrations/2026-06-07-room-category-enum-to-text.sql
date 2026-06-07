-- =============================================================
-- 2026-06-07-room-category-enum-to-text.sql
-- Stage B of dynamic room categories — the atomic conversion.
--
-- Converts the room_category enum into plain text backed by the
-- room_categories table (from 2026-06-07-room-categories-table.sql):
--   rooms.category                     enum -> text + FK to room_categories(slug)
--   bookings.room_category_at_booking  enum -> text  (frozen snapshot, no FK)
--   booking_rooms.room_category        enum -> text  (frozen snapshot, no FK)
--
-- Also drops/recreates booking_summary (depends on two of those columns),
-- rewrites create_booking_with_rooms and add_room_to_booking to stop
-- referencing the enum, then drops the enum type.
--
-- Single transaction: if ANY step fails, everything rolls back.
-- Run as ONE script in the Supabase SQL Editor.
-- =============================================================

BEGIN;

-- ── 1. Drop the view that depends on the columns we're retyping ─────────────
DROP VIEW IF EXISTS public.booking_summary;

-- ── 2. Convert the three enum columns to text ───────────────────────────────
ALTER TABLE public.rooms
  ALTER COLUMN category TYPE text USING category::text;
ALTER TABLE public.bookings
  ALTER COLUMN room_category_at_booking TYPE text USING room_category_at_booking::text;
ALTER TABLE public.booking_rooms
  ALTER COLUMN room_category TYPE text USING room_category::text;

-- ── 3. Tie the LIVE column to the managed table ─────────────────────────────
-- Snapshots deliberately get NO FK, so history stays truthful if a category
-- is later renamed or retired.
ALTER TABLE public.rooms
  ADD CONSTRAINT rooms_category_fkey
  FOREIGN KEY (category) REFERENCES public.room_categories(slug)
  ON UPDATE CASCADE ON DELETE RESTRICT;

-- ── 4. Recreate booking_summary exactly as it was ───────────────────────────
CREATE VIEW public.booking_summary AS
SELECT
  b.id,
  b.booking_ref,
  b.status,
  b.check_in_date,
  b.check_out_date,
  b.nights,
  b.total_guests,
  b.room_category_at_booking,
  r.room_number,
  r.floor,
  r.category        AS room_category_current,
  r.status          AS room_status,
  r.price_per_night,
  g.name            AS guest_name,
  g.email           AS guest_email,
  g.phone           AS guest_phone,
  g.nationality     AS guest_nationality,
  g.vip             AS guest_vip,
  b.total_amount,
  b.paid_amount,
  b.payment_status,
  b.override_checkout,
  b.override_reason,
  b.override_at,
  b.confirmed_at,
  b.checked_in_at,
  b.checked_out_at,
  b.cancelled_at,
  b.created_at,
  b.updated_at
FROM public.bookings b
JOIN public.rooms  r ON r.id = b.room_id
JOIN public.guests g ON g.id = b.primary_guest_id;

COMMENT ON VIEW public.booking_summary IS
  'Denormalised booking list view — joins bookings, rooms, guests. '
  'Used by BookingsClient and RoomBoard. Does not include extra charges.';

-- Restore the view's grants (a fresh view grants to nobody but its owner)
GRANT ALL ON public.booking_summary TO anon, authenticated, service_role;

-- ── 5. Rewrite create_booking_with_rooms (enum refs in BODY only) ───────────
-- Signature unchanged, so CREATE OR REPLACE preserves its grants.
CREATE OR REPLACE FUNCTION public.create_booking_with_rooms(
  p_booking_ref text,
  p_primary_guest_id uuid,
  p_total_guests smallint,
  p_rooms jsonb,
  p_total_amount numeric,
  p_initial_payment numeric DEFAULT 0,
  p_payment_method text DEFAULT NULL::text,
  p_recorded_by uuid DEFAULT NULL::uuid,
  p_status text DEFAULT 'confirmed'::text
)
 RETURNS uuid
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_booking_id           UUID;
  v_room                 JSONB;
  v_first_room_id        UUID;
  v_first_check_in       DATE;
  v_first_check_out      DATE;
  v_first_category       TEXT;   -- was public.room_category
  v_booking_status       public.booking_status;
  v_physical_room_status public.room_status;
  v_expected_total       NUMERIC;
BEGIN
  -- Guard: cross-check p_total_amount against room subtotals
  SELECT COALESCE(SUM( (r->>'rate')::NUMERIC * (r->>'nights')::INTEGER ), 0)
  INTO v_expected_total
  FROM jsonb_array_elements(p_rooms) AS r;

  IF ABS(p_total_amount - v_expected_total) > 0.01 THEN
    RAISE EXCEPTION
      'create_booking_with_rooms: total_amount mismatch — provided %, computed % from rooms.',
      p_total_amount, v_expected_total;
  END IF;

  -- Validate p_status
  IF p_status NOT IN ('confirmed', 'checked_in') THEN
    RAISE EXCEPTION
      'Invalid p_status ''%''. Only ''confirmed'' or ''checked_in'' accepted.', p_status;
  END IF;

  v_booking_status       := p_status::public.booking_status;
  v_physical_room_status := CASE p_status
    WHEN 'checked_in' THEN 'occupied'::public.room_status
    ELSE                   'reserved'::public.room_status
  END;

  -- First-room values for backward-compat columns on bookings
  v_first_room_id   := (p_rooms->0->>'room_id')::UUID;
  v_first_check_in  := (p_rooms->0->>'check_in_date')::DATE;
  v_first_check_out := (p_rooms->0->>'check_out_date')::DATE;
  v_first_category  := (p_rooms->0->>'category');   -- was ::public.room_category

  -- a) Insert booking shell
  INSERT INTO public.bookings (
    booking_ref, primary_guest_id, total_guests, status,
    total_amount, paid_amount, payment_status, confirmed_at, checked_in_at,
    room_id, check_in_date, check_out_date, room_category_at_booking
  ) VALUES (
    p_booking_ref, p_primary_guest_id, p_total_guests, v_booking_status,
    p_total_amount, 0, 'unpaid', NOW(),
    CASE WHEN p_status = 'checked_in' THEN NOW() ELSE NULL END,
    v_first_room_id, v_first_check_in, v_first_check_out, v_first_category
  )
  RETURNING id INTO v_booking_id;

  -- b) Insert booking_rooms rows + c) set physical room status
  FOR v_room IN SELECT value FROM jsonb_array_elements(p_rooms) LOOP
    INSERT INTO public.booking_rooms (
      booking_id, room_id, check_in_date, check_out_date, nights,
      room_category, booking_rate, status, confirmed_at, checked_in_at
    ) VALUES (
      v_booking_id,
      (v_room->>'room_id')::UUID,
      (v_room->>'check_in_date')::DATE,
      (v_room->>'check_out_date')::DATE,
      (v_room->>'nights')::SMALLINT,
      (v_room->>'category'),                 -- was ::public.room_category
      (v_room->>'rate')::NUMERIC,
      v_booking_status,
      NOW(),
      CASE WHEN p_status = 'checked_in' THEN NOW() ELSE NULL END
    );

    UPDATE public.rooms
    SET    status = v_physical_room_status, updated_at = NOW()
    WHERE  id = (v_room->>'room_id')::UUID;
  END LOOP;

  -- d) Initial payment (if provided)
  IF p_initial_payment > 0 AND p_payment_method IS NOT NULL THEN
    INSERT INTO public.payments (booking_id, amount, method, recorded_by)
    VALUES (v_booking_id, p_initial_payment, p_payment_method::public.payment_method, p_recorded_by);
  END IF;

  RETURN v_booking_id;
END;
$function$;

-- ── 6. Recreate add_room_to_booking with p_category as text ─────────────────
-- Enum is in the SIGNATURE here, so it must be dropped and recreated
-- (a parameter type can't be changed in place). Dropping discards its grants,
-- so we re-grant immediately after.
DROP FUNCTION IF EXISTS public.add_room_to_booking(
  uuid, uuid, date, date, smallint, public.room_category, numeric, public.booking_status
);

CREATE FUNCTION public.add_room_to_booking(
  p_booking_id uuid,
  p_room_id uuid,
  p_check_in_date date,
  p_check_out_date date,
  p_nights smallint,
  p_category text,                          -- was room_category
  p_rate numeric,
  p_room_status public.booking_status
)
 RETURNS uuid
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_room_row_id      UUID;
  v_physical_status  public.room_status;
BEGIN
  INSERT INTO public.booking_rooms (
    booking_id, room_id, check_in_date, check_out_date, nights,
    room_category, booking_rate, status, confirmed_at, checked_in_at
  ) VALUES (
    p_booking_id, p_room_id, p_check_in_date, p_check_out_date, p_nights,
    p_category, p_rate, p_room_status, NOW(),
    CASE WHEN p_room_status = 'checked_in' THEN NOW() ELSE NULL END
  )
  RETURNING id INTO v_room_row_id;

  PERFORM public.update_booking_total(p_booking_id);

  v_physical_status := CASE p_room_status
    WHEN 'confirmed'  THEN 'reserved'::public.room_status
    WHEN 'checked_in' THEN 'occupied'::public.room_status
    ELSE                   'reserved'::public.room_status
  END;

  UPDATE public.rooms
  SET    status = v_physical_status, updated_at = NOW()
  WHERE  id = p_room_id;

  RETURN v_room_row_id;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.add_room_to_booking(
  uuid, uuid, date, date, smallint, text, numeric, public.booking_status
) TO anon, authenticated, service_role;

-- ── 7. Drop the now-unused enum type ────────────────────────────────────────
-- Plain DROP (no CASCADE): if anything still references it, this errors and
-- the whole transaction rolls back — a safety net, not a risk.
DROP TYPE public.room_category;

COMMIT;

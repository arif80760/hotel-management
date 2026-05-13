-- =============================================================
-- 07-functions.sql
-- RPC function definitions (PostgREST-callable via supabase.rpc()).
--
-- These are app-layer RPCs invoked by bookingsService.ts.
-- Trigger functions live in 05-triggers.sql, not here.
--
-- Tracking started: 2026-05-13 (Phase 11 #46).
-- Prior RPCs exist only in their migration files:
--   checkout_booking_room      → 2026-05-08-multi-room-rpc.sql
--   cancel_booking_room        → 2026-05-09-phase7-rpc-updates.sql
--   cancel_booking             → 2026-05-09-phase8.6-atomic-cancel-with-disbursement.sql
--   bulk_checkin_booking_rooms → 2026-05-11-bulk-checkin-booking-rooms-rpc.sql
--   update_booking_total       → 2026-05-08-multi-room-rpc.sql
-- =============================================================


-- ──────────────────────────────────────────────────────────────
-- checkout_booking
-- Checks out all active rooms on a booking atomically.
-- Mirrors cancel_booking structure (bulk UPDATE, no per-room loop).
-- Per-room early departure: use checkout_booking_room instead.
-- Added: 2026-05-13 via migration
--        2026-05-13-phase11-46-checkout-booking-rpc.sql
-- ──────────────────────────────────────────────────────────────
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
  SELECT array_agg(room_id)
  INTO   v_room_ids
  FROM   public.booking_rooms
  WHERE  booking_id = p_booking_id
    AND  status IN ('confirmed', 'checked_in');

  -- ── 4. Bulk check out all active rooms ─────────────────────────────────────
  UPDATE public.booking_rooms
  SET    status               = 'checked_out',
         checked_out_at       = NOW(),
         actual_checkout_date = COALESCE(p_actual_checkout_date, check_out_date),
         check_out_date       = COALESCE(p_actual_checkout_date, check_out_date),
         updated_at           = NOW()
  WHERE  booking_id = p_booking_id
    AND  status IN ('confirmed', 'checked_in');

  -- ── 5. Set physical rooms to cleaning ──────────────────────────────────────
  IF v_room_ids IS NOT NULL THEN
    UPDATE public.rooms
    SET    status     = 'cleaning',
           updated_at = NOW()
    WHERE  id = ANY(v_room_ids);
  END IF;

  -- ── 6. Recompute booking total ──────────────────────────────────────────────
  PERFORM public.update_booking_total(p_booking_id);

  -- ── 7. Promote booking to checked_out ──────────────────────────────────────
  UPDATE public.bookings
  SET    status = 'checked_out'
  WHERE  id     = p_booking_id
    AND  status IS DISTINCT FROM 'checked_out';

END;
$$;

GRANT EXECUTE ON FUNCTION public.checkout_booking(UUID, DATE, INTEGER, NUMERIC)
  TO anon, authenticated;

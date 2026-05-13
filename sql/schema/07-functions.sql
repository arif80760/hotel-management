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
-- Computes per-room early deductions from each room's own
-- check_out_date — correct for multi-room bookings with mixed
-- checkout schedules.
-- CTE-based bulk UPDATE — no cursor.
-- Added: 2026-05-13 via migration
--        2026-05-13-phase11-46-checkout-booking-rpc.sql
-- Revised: 2026-05-13 via migration
--        2026-05-13-phase11-48-checkout-booking-per-room-deductions.sql
--        Signature: (UUID, DATE, INTEGER, NUMERIC) → (UUID, DATE)
--        Guard removed; RPC now computes per-room deductions internally.
-- ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.checkout_booking(
  p_booking_id           UUID,
  p_actual_checkout_date DATE DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql AS $$
DECLARE
  v_room_ids UUID[];
BEGIN

  -- ── 1. Validate booking exists ────────────────────────────────────────────
  IF NOT EXISTS (SELECT 1 FROM public.bookings WHERE id = p_booking_id) THEN
    RAISE EXCEPTION 'booking % not found', p_booking_id;
  END IF;

  -- ── 2. Per-room early deductions + bulk checkout via CTE ──────────────────
  -- active_rooms snapshots each active room and pre-computes:
  --   early_nights = GREATEST(0, scheduled_date − actual_date)
  --                  0 when p_actual_checkout_date IS NULL (on-time checkout)
  --   deduction_amt = early_nights × booking_rate
  --
  -- The upd CTE bulk-UPDATEs booking_rooms using these values and RETURNs
  -- room_id for step 3. Both CTEs execute atomically in one statement.
  --
  -- Status convention (matches cancel_booking_room):
  --   early_nights > 0 → checked_out_early
  --   early_nights = 0 → checked_out
  --
  -- GREATEST(1, ar.nights - ar.early_nights): floor prevents nights = 0 in
  -- the degenerate case where p_actual_checkout_date = check_in_date.
  WITH active_rooms AS (
    SELECT id                                                              AS room_row_id,
           room_id,
           check_out_date,
           booking_rate,
           nights,
           GREATEST(0,
             check_out_date
             - COALESCE(p_actual_checkout_date, check_out_date)
           )                                                               AS early_nights,
           GREATEST(0,
             check_out_date
             - COALESCE(p_actual_checkout_date, check_out_date)
           )::NUMERIC * booking_rate                                       AS deduction_amt
    FROM   public.booking_rooms
    WHERE  booking_id = p_booking_id
      AND  status IN ('confirmed', 'checked_in')
  ),
  upd AS (
    UPDATE public.booking_rooms br
    SET    status                 = CASE
                                      WHEN ar.early_nights > 0
                                      THEN 'checked_out_early'::public.booking_status
                                      ELSE 'checked_out'::public.booking_status
                                    END,
           checked_out_at         = NOW(),
           actual_checkout_date   = COALESCE(p_actual_checkout_date, ar.check_out_date),
           check_out_date         = COALESCE(p_actual_checkout_date, ar.check_out_date),
           early_nights_deducted  = ar.early_nights,
           early_deduction_amount = ar.deduction_amt,
           nights                 = GREATEST(1, ar.nights - ar.early_nights),
           updated_at             = NOW()
    FROM   active_rooms ar
    WHERE  br.id = ar.room_row_id
    RETURNING br.room_id
  )
  SELECT array_agg(room_id)
  INTO   v_room_ids
  FROM   upd;

  -- ── 3. Set physical rooms to cleaning ────────────────────────────
  -- v_room_ids is NULL when 0 active rows (already-terminal booking).
  -- Guard prevents a vacuous ANY(NULL) match.
  IF v_room_ids IS NOT NULL THEN
    UPDATE public.rooms
    SET    status     = 'cleaning',
           updated_at = NOW()
    WHERE  id = ANY(v_room_ids);
  END IF;

  -- ── 4. Recompute booking total ────────────────────────────────────────────────────
  -- update_booking_total sums SUM(nights × booking_rate) from non-cancelled
  -- booking_rooms. Step 2 already reduced per-room nights, so this yields
  -- the correct lower total automatically. Fires trg_sync_payment_status.
  PERFORM public.update_booking_total(p_booking_id);

  -- ── 5. Promote booking to checked_out ────────────────────────────────────────────
  -- IS DISTINCT FROM guard prevents a no-op UPDATE from firing triggers.
  UPDATE public.bookings
  SET    status = 'checked_out'
  WHERE  id     = p_booking_id
    AND  status IS DISTINCT FROM 'checked_out';

END;
$$;

GRANT EXECUTE ON FUNCTION public.checkout_booking(UUID, DATE)
  TO anon, authenticated;

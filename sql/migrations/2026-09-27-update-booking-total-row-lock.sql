-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-09-27 — update_booking_total: booking-row lock before the recompute.
-- RECORD OF LIVE STATE — applied by Arif in the Supabase SQL editor on
-- 2026-09-27 and probe-verified the same day.
--
-- Incident BK-1928: rooms 406 + 401 were added to the booking 114 ms apart
-- (booking_rooms.created_at 08:41:40.226 / .340) — the Add Room dialog
-- fired one un-awaited addRoomToBooking per selected room, so two RPC
-- transactions ran in PARALLEL. Each one's update_booking_total SUM ran
-- under READ COMMITTED and could not see the other's uncommitted row; the
-- last commit (401's view: 505+506+401 = 5,500) clobbered the total while
-- the four rooms really summed 7,500. The invoice printed line items
-- totalling 7,500 above a TOTAL DUE of 5,500; Add Payment capped at the
-- phantom due and the checkout guard would have opened 2,000 short.
--
-- NOT a missing-recompute bug: add_room_to_booking has called
-- update_booking_total since 2026-09-05 — the recompute itself raced.
-- BK-1928 self-healed on 2026-09-27 when checking out rooms 505/506 re-ran
-- the recompute serially; a full sweep (all 855 non-cancelled bookings,
-- stored total vs SUM(nights×rate) over non-cancelled rooms) found ZERO
-- other drifted rows, so no data corrections were needed anywhere.
--
-- Fix: PERFORM … FOR UPDATE on the bookings row BEFORE the SUM. A
-- concurrent caller blocks at the lock until the first commits; its SUM
-- then runs on a fresh statement snapshot (READ COMMITTED) and sees the
-- committed row. Protects EVERY caller (create, add, edit, all checkout
-- doors) — the total can never again be written from a stale view. No
-- deadlock exposure: every path takes this lock at the same point, after
-- its own row work.
--
-- Client half (same batch): HotelContext.addRoomToBooking returns its
-- promise (always resolves; rollback stays internal) and the Add Room
-- dialog awaits each add SEQUENTIALLY.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.update_booking_total(p_booking_id uuid)
 RETURNS numeric
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_rooms_total NUMERIC;
BEGIN
  -- Serialize concurrent recomputes for the same booking (BK-1928 race).
  PERFORM 1 FROM public.bookings WHERE id = p_booking_id FOR UPDATE;

  -- Sum active room charges only (cancelled rooms contribute 0).
  SELECT COALESCE(SUM(nights * booking_rate), 0) INTO v_rooms_total
  FROM public.booking_rooms
  WHERE booking_id = p_booking_id
    AND status <> 'cancelled';

  -- total_amount = rooms subtotal ONLY. Extra charges are carried by the
  -- scalar bookings.extra_charge_amount and added to "owed" downstream by
  -- fn_sync_payment_status / calcTrueDue / recordPayment. Folding the itemized
  -- booking_extra_charges in here double-counted the extra. Removed.
  UPDATE public.bookings
  SET total_amount = v_rooms_total
  WHERE id = p_booking_id;

  RETURN v_rooms_total;
END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Verification (2026-09-27, ROLLBACK-wrapped): synthetic confirmed booking
-- (1 room, 1000 × 2 nights → total 2000), then add_room_to_booking (second
-- room, 1500 × 2 nights); asserted total_amount rose to exactly 5000 —
-- the add-room total-rise assertion the earlier rejoin probe never made
-- (it checked nights/dates only, which is exactly where BK-1928 slipped
-- through). PASSED. True parallelism is not reproducible in one session;
-- the FOR UPDATE lock is the deterministic protection.
-- ─────────────────────────────────────────────────────────────────────────────

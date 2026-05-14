-- ===========================================================================
-- Phase 11 #56 — Backfill booking_rate=0 on historical bookings
-- File:    sql/migrations/2026-05-14-phase11-56-backfill-booking-rate.sql
-- Date:    2026-05-14
--
-- Nature:
--   One-time data backfill. No DDL, no function or trigger changes.
--
-- Background:
--   booking_rooms.booking_rate column was zero on the 5 earliest bookings
--   (BK-1006 through BK-1010), all created before booking_rate was being
--   consistently captured at booking creation time. Because bookings.
--   total_amount is computed by update_booking_total() as
--   SUM(nights * booking_rate), a zero booking_rate would normally produce
--   total_amount=0, but the early bookings have total_amount values that
--   were set independently (likely manually or via different code path).
--
--   The visible symptom: invoice line items show "1 night × ৳0 = ৳0"
--   while Total Due shows the correct bookings.total_amount value.
--   Display inconsistency.
--
--   Preflight audit (2026-05-14) found exactly 5 affected bookings, all
--   single-room, all with total_amount and nights values that divide cleanly:
--     BK-1006: total=3000, nights=1 → rate should be 3000
--     BK-1007: total=12000, nights=2 → rate should be 6000
--     BK-1008: total=8000, nights=2 → rate should be 4000
--     BK-1009: total=12000, nights=3 → rate should be 4000
--     BK-1010: total=5000, nights=2 → rate should be 2500
--
--   For single-room bookings: booking_rate = total_amount / nights is
--   correct by construction (update_booking_total invariant).
--
-- Fix:
--   UPDATE booking_rooms SET booking_rate = total_amount / nights for
--   single-room bookings where booking_rate = 0. Filter explicitly to
--   single-room to avoid attempting this on multi-room bookings (where
--   per-room rate cannot be derived from booking-level total alone).
--
-- Idempotency:
--   WHERE booking_rate = 0 ensures the UPDATE only fires on un-backfilled
--   rows. Safe to re-run.
--
-- Trigger cascade:
--   booking_rooms UPDATE does NOT fire update_booking_total automatically;
--   update_booking_total is only called from RPCs (cancel_booking,
--   checkout_booking, checkout_booking_room). Since we are setting
--   booking_rate to a value that already matches the existing total_amount
--   (by construction: total/nights), no total recomputation is needed.
--   The bookings.total_amount values remain unchanged.
--
-- Verification:
--   Post-backfill, all 5 bookings should show booking_rate != 0 and
--   nights * booking_rate = total_amount.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- Section 1: Backfill UPDATE
-- ---------------------------------------------------------------------------

UPDATE public.booking_rooms br
SET    booking_rate = (
         SELECT b.total_amount
         FROM   public.bookings b
         WHERE  b.id = br.booking_id
       ) / br.nights
WHERE  br.booking_rate = 0
  AND  br.nights > 0
  AND  br.booking_id IN (
         SELECT br2.booking_id
         FROM   public.booking_rooms br2
         GROUP BY br2.booking_id
         HAVING COUNT(*) = 1  -- Single-room bookings only
       );


-- ---------------------------------------------------------------------------
-- Section 2: Verification (run separately after applying Section 1)
-- ---------------------------------------------------------------------------

-- Q1: Confirm no remaining zero-rate single-room bookings
-- Expected: 0 rows
SELECT b.booking_ref, b.total_amount, br.nights, br.booking_rate
FROM   public.bookings b
JOIN   public.booking_rooms br ON br.booking_id = b.id
WHERE  br.booking_rate = 0
  AND  b.id IN (
         SELECT booking_id
         FROM   public.booking_rooms
         GROUP BY booking_id
         HAVING COUNT(*) = 1
       );

-- Q2: Spot-check the 5 known affected bookings
-- Expected:
--   BK-1006: rate=3000, nights*rate=3000=total  ✓
--   BK-1007: rate=6000, nights*rate=12000=total ✓
--   BK-1008: rate=4000, nights*rate=8000=total  ✓
--   BK-1009: rate=4000, nights*rate=12000=total ✓
--   BK-1010: rate=2500, nights*rate=5000=total  ✓
SELECT b.booking_ref,
       b.total_amount,
       br.nights,
       br.booking_rate,
       (br.nights * br.booking_rate)              AS computed_total,
       (br.nights * br.booking_rate) = b.total_amount AS math_checks_out
FROM   public.bookings b
JOIN   public.booking_rooms br ON br.booking_id = b.id
WHERE  b.booking_ref IN ('BK-1006', 'BK-1007', 'BK-1008', 'BK-1009', 'BK-1010')
ORDER BY b.booking_ref;


-- ===========================================================================
-- END OF MIGRATION
-- ===========================================================================

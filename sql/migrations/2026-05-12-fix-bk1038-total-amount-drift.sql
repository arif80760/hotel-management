-- ===========================================================================
-- Fix: BK-1038 total_amount drift
-- File:    sql/migrations/2026-05-12-fix-bk1038-total-amount-drift.sql
-- Date:    2026-05-12
--
-- Nature:
--   One-time data fix.  This is NOT a schema change.  No tables,
--   functions, triggers, or policies are altered.
--
-- Background:
--   BK-1038 (id: 792f7e5b-8a4c-411c-a4cc-a8dc3325996a) has
--   bookings.total_amount = 10,000 but the canonical value derived
--   from booking_rooms is 8,000 (1 room × ৳4,000/night × 2 nights,
--   zero extra charges).  The booking is status=confirmed and has
--   not been checked out, so no invoice has been printed yet — but
--   if printed in the current state it would show internally
--   inconsistent figures: line items summing to ৳8,000 against a
--   "Total Due" of ৳10,000.
--
-- Root cause: UNKNOWN.
--   No edit trail, no migration accounts for total_amount becoming
--   10,000 on a single ৳4,000×2 room booking with zero extras.
--   This migration fixes the symptom, not the cause.
--
-- Risk going forward:
--   If the same drift mechanism (whatever it is) recurs, BK-1038
--   or other bookings could drift again.  Recommend periodic SELECT
--   checks to detect new drift early (compare bookings.total_amount
--   against SUM(booking_rooms.nights * booking_rooms.booking_rate)
--   + SUM(booking_extra_charges.amount) for all confirmed bookings).
--   If new drift appears, treat as a high-priority investigation —
--   do not just re-run this fix.
--
-- Fix approach — Path A: call update_booking_total RPC.
--   update_booking_total is the canonical, authoritative recompute
--   function called by every add-room, cancel-room, and extend-
--   checkout RPC.  It computes:
--     v_rooms_total  = SUM(nights * booking_rate) WHERE status <> 'cancelled'
--     v_extras_total = SUM(booking_extra_charges.amount)
--     total_amount   = v_rooms_total + v_extras_total
--   For BK-1038: 1 confirmed room, 2 nights, ৳4,000/night, 0 extras
--   → total = 8,000.  It then issues UPDATE bookings SET total_amount
--   = 8,000, returns 8,000, and the trigger cascade runs atomically.
--
--   Path B (manual UPDATE bookings SET total_amount = 8000) was
--   rejected because it hardcodes a value derived by mental
--   arithmetic.  Path A is idempotent by construction: if
--   booking_rooms ever change, re-running Path A gives the correct
--   answer without recalculation.
--
-- Why update_booking_total is safe here:
--   BK-1038's booking_rooms.nights = 2 matches the computed date
--   span exactly (check_in 2026-05-13, check_out 2026-05-15 = 2
--   days).  No item #18 nights-drift affects this booking.
--   update_booking_total uses stored booking_rooms.nights, not
--   date arithmetic — if nights-drift ever appeared on BK-1038,
--   this fix would produce the wrong value and need redesign.
--   Verified clear at preflight time (2026-05-12).
--
-- Trigger cascade:
--   UPDATE bookings SET total_amount fires trg_sync_payment_status
--   (BEFORE UPDATE OF paid_amount, total_amount ON bookings,
--   05-triggers.sql line 160).  For BK-1038: paid_amount=1000,
--   new total_amount=8000 → 0 < 1000 < 8000 → payment_status
--   remains 'partial'.  No visible payment_status change.
--
-- chk_paid_not_exceed_total:
--   Constraint is CHECK (paid_amount <= total_amount).
--   After fix: 1000 <= 8000 — satisfied.  Not a blocking concern.
--
-- Fresh-DB behaviour:
--   On a database without this booking the SELECT returns NULL
--   (update_booking_total returns NULL when no booking_rooms exist
--   and the booking id is not found — the UPDATE matches zero rows).
--   The verification queries will show no rows.  This is a no-op
--   in effect.
--
-- Execution mode:
--   Single block — no DDL, no multi-run requirement.  Must be run
--   via service role to bypass RLS on the bookings table UPDATE
--   issued inside update_booking_total.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- Section 1: Apply fix
--
-- Calls update_booking_total, which recomputes total_amount from
-- booking_rooms and booking_extra_charges, issues the UPDATE on
-- bookings, and returns the new value.
-- ---------------------------------------------------------------------------

SELECT update_booking_total('792f7e5b-8a4c-411c-a4cc-a8dc3325996a')
    AS new_total_amount;

-- Expected output:
--   new_total_amount
--   ----------------
--   8000.00


-- ---------------------------------------------------------------------------
-- Section 2: Verification
-- ---------------------------------------------------------------------------

-- 2a. BK-1038 booking row
--     Expect: total_amount=8000, paid_amount=1000,
--             payment_status='partial', status='confirmed'
SELECT
  booking_ref,
  total_amount,
  paid_amount,
  payment_status,
  status
FROM   public.bookings
WHERE  id = '792f7e5b-8a4c-411c-a4cc-a8dc3325996a';

-- Expected:
--   booking_ref | total_amount | paid_amount | payment_status | status
--   BK-1038     | 8000.00      | 1000.00     | partial        | confirmed

-- 2b. Canonical cross-check
--     Computes the same value update_booking_total used, then
--     compares it against the now-stored total_amount.
--     Both figures must match; the delta must be 0.
SELECT
  b.booking_ref,
  b.total_amount                                      AS stored_total,
  COALESCE(SUM(br.nights * br.booking_rate), 0)
    + COALESCE(ec.extras_total, 0)                    AS canonical_total,
  b.total_amount
    - (COALESCE(SUM(br.nights * br.booking_rate), 0)
       + COALESCE(ec.extras_total, 0))                AS delta
FROM   public.bookings b
LEFT   JOIN public.booking_rooms br
         ON br.booking_id = b.id AND br.status <> 'cancelled'
LEFT   JOIN (
         SELECT booking_id, COALESCE(SUM(amount), 0) AS extras_total
         FROM   public.booking_extra_charges
         WHERE  booking_id = '792f7e5b-8a4c-411c-a4cc-a8dc3325996a'
         GROUP  BY booking_id
       ) ec ON ec.booking_id = b.id
WHERE  b.id = '792f7e5b-8a4c-411c-a4cc-a8dc3325996a'
GROUP  BY b.booking_ref, b.total_amount, ec.extras_total;

-- Expected:
--   booking_ref | stored_total | canonical_total | delta
--   BK-1038     | 8000.00      | 8000.00         | 0.00


-- ===========================================================================
-- END OF MIGRATION
-- ===========================================================================

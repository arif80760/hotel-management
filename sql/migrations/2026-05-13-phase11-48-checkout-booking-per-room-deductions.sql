-- ===========================================================================
-- Phase 11 #48: checkout_booking — per-room early deductions
-- File:    sql/migrations/2026-05-13-phase11-48-checkout-booking-per-room-deductions.sql
-- Date:    2026-05-13
--
-- Nature:
--   DDL only — DROP old signature, CREATE OR REPLACE new signature, GRANT.
--   No table changes. No data changes.
--
-- Background:
--   The Phase 11 #46 checkout_booking RPC had a defensive guard that blocked
--   all early-deduction params (p_early_nights_deducted, p_deduction_amount).
--   This was correct for the initial multi-room fix but prevented the
--   booking-level Check Out from deducting unused nights for guests who
--   leave early.
--
--   The real workflow:
--     - 4-room booking: rooms 1,2 scheduled May 14; rooms 3,4 May 16.
--     - May 13: rooms 1,2 leave via per-room "Early Out" (cancel_booking_room,
--       unchanged).
--     - May 15: operator clicks booking-level "Check Out" for rooms 3,4.
--       The RPC must compute each room's own deduction from its own
--       check_out_date, not a booking-wide scalar.
--
-- Fix:
--   New checkout_booking(p_booking_id, p_actual_checkout_date) drops the two
--   early-deduction params entirely. The RPC computes per-room deductions
--   internally via a CTE UPDATE:
--     active_rooms CTE: snapshots early_nights and deduction_amt per room
--     upd CTE: bulk UPDATE booking_rooms using CTE values, RETURNING room_id
--     SELECT INTO v_room_ids: collects room_ids in one statement
--
--   Status convention (matches cancel_booking_room):
--     early_nights > 0 → checked_out_early
--     early_nights = 0 → checked_out
--
--   update_booking_total() then sums SUM(nights × booking_rate) from the
--   already-reduced nights, yielding the correct lower total.
--
-- Signature change:
--   OLD: checkout_booking(UUID, DATE, INTEGER, NUMERIC)
--   NEW: checkout_booking(UUID, DATE)
--   The old overload is DROPped first to avoid leaving a dead 4-param ghost.
--
-- Service layer:
--   bookingsService.checkoutNormal + checkoutWithOverride no longer pass
--   p_early_nights_deducted / p_deduction_amount. The RPC call shrinks to
--   { p_booking_id, p_actual_checkout_date }.
--
-- Relationship to checkout_booking_room:
--   checkout_booking_room is NOT deprecated. It continues to serve per-room
--   "Early Out" (cancel_booking_room path). checkout_booking serves the
--   booking-level "Check Out" final exit.
--
-- Apply mode:
--   SQL Editor (service role). DDL is not reachable via PostgREST.
--   Section 1 (DROP) and Section 2 (CREATE + GRANT) can run as one block.
--   APPLIED: 2026-05-13 — function live in production (old 4-param overload
--   dropped; new 2-param signature verified via pg_proc query).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Section 1: Drop old 4-param signature
-- ---------------------------------------------------------------------------
-- CREATE OR REPLACE cannot change the parameter list — it only replaces when
-- the signature matches exactly. Without this DROP the old overload survives
-- as a dead ghost callable via the old param names.

DROP FUNCTION IF EXISTS public.checkout_booking(UUID, DATE, INTEGER, NUMERIC);

-- ---------------------------------------------------------------------------
-- Section 2: Create new 2-param checkout_booking
-- ---------------------------------------------------------------------------

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

  -- ── 3. Set physical rooms to cleaning ────────────────────────────────────
  -- v_room_ids is NULL when 0 active rows (already-terminal booking).
  -- Guard prevents a vacuous ANY(NULL) match.
  IF v_room_ids IS NOT NULL THEN
    UPDATE public.rooms
    SET    status     = 'cleaning',
           updated_at = NOW()
    WHERE  id = ANY(v_room_ids);
  END IF;

  -- ── 4. Recompute booking total ────────────────────────────────────────────
  -- update_booking_total sums SUM(nights × booking_rate) from non-cancelled
  -- booking_rooms. Step 2 already reduced per-room nights, so this yields
  -- the correct lower total automatically. Fires trg_sync_payment_status.
  PERFORM public.update_booking_total(p_booking_id);

  -- ── 5. Promote booking to checked_out ────────────────────────────────────
  -- IS DISTINCT FROM guard prevents a no-op UPDATE from firing triggers.
  UPDATE public.bookings
  SET    status = 'checked_out'
  WHERE  id     = p_booking_id
    AND  status IS DISTINCT FROM 'checked_out';

END;
$$;

COMMENT ON FUNCTION public.checkout_booking IS
  'Checks out all active rooms on a booking. Computes per-room early deductions from each room''s own check_out_date. Sets booking_rooms.status=checked_out(_early), rooms.status=cleaning, reduces nights, recomputes total, promotes bookings.status=checked_out. CTE-based bulk UPDATE — no cursor.';

-- ---------------------------------------------------------------------------
-- Section 3: Grant execute
-- ---------------------------------------------------------------------------

GRANT EXECUTE ON FUNCTION public.checkout_booking(UUID, DATE)
  TO anon, authenticated;

-- ---------------------------------------------------------------------------
-- Section 4: Verification (run in SQL Editor after applying)
-- ---------------------------------------------------------------------------

-- 4a. Confirm old 4-param signature is gone, new 2-param signature exists
--
-- SELECT proname, pg_get_function_arguments(oid) AS args
-- FROM   pg_proc
-- WHERE  proname = 'checkout_booking';
--
-- Expected: exactly ONE row —
--   proname           | args
--   checkout_booking  | p_booking_id uuid,
--                     | p_actual_checkout_date date DEFAULT NULL

-- 4b. Confirm grants
--
-- SELECT grantee, privilege_type
-- FROM   information_schema.routine_privileges
-- WHERE  routine_name = 'checkout_booking';
--
-- Expected: rows for anon + authenticated, privilege_type = EXECUTE

-- ===========================================================================
-- END OF MIGRATION
-- ===========================================================================

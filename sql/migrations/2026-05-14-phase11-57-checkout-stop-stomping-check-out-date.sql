-- ===========================================================================
-- Phase 11 #57: Stop checkout RPCs from stomping check_out_date
-- File:    sql/migrations/2026-05-14-phase11-57-checkout-stop-stomping-check-out-date.sql
-- Date:    2026-05-14
--
-- Nature:
--   Two RPC replacements (CREATE OR REPLACE). No schema changes.
--   No data changes. No trigger changes.
--
-- Background:
--   checkout_booking (Phase 11 #48) and checkout_booking_room
--   (2026-05-08-multi-room-rpc.sql) both wrote p_actual_checkout_date into
--   check_out_date when the guest left early. This corrupted the column that
--   holds the ORIGINAL scheduled checkout date:
--
--   checkout_booking upd CTE, line 132:
--     check_out_date = COALESCE(p_actual_checkout_date, ar.check_out_date)
--   checkout_booking_room UPDATE, lines 364-366:
--     check_out_date = CASE WHEN p_actual_checkout_date IS NOT NULL
--                       THEN p_actual_checkout_date
--                       ELSE check_out_date END
--
--   Downstream symptom 1 — invoice nights wrong:
--     computedNights was derived from check_out_date - check_in_date. After the
--     stomp, check_out_date equalled the early departure date, so nights showed
--     the short actual stay instead of the originally booked span.
--
--   Downstream symptom 2 — chk_br_dates constraint violation:
--     BK-1076: same-day check-in and early-departure. Stomping
--     check_out_date = p_actual_checkout_date = check_in_date violated
--     the CHECK (check_out_date > check_in_date) constraint.
--
--   actual_checkout_date already exists for recording the real departure date.
--   check_out_date should remain the ORIGINAL scheduled checkout date — the
--   column that bookings were made against.
--
-- Fix:
--   Section 1 — checkout_booking: remove the check_out_date assignment from
--     the upd CTE SET clause. actual_checkout_date still receives
--     COALESCE(p_actual_checkout_date, ar.check_out_date) unchanged.
--   Section 2 — checkout_booking_room: remove the check_out_date CASE block
--     from the UPDATE SET clause. actual_checkout_date still receives
--     COALESCE(p_actual_checkout_date, check_out_date) unchanged.
--
-- cancel_booking_room NOT touched:
--   cancel_booking_room also writes check_out_date (line 499 of
--   2026-05-08-multi-room-rpc.sql). That write is intentional — it shrinks
--   the scheduled date to match the early departure date as part of the
--   per-room Early Out flow. Do not remove it.
--
-- Invoice fix (companion change):
--   app/bookings/[id]/invoice/page.tsx computedNights now uses
--   actualCheckoutDate ?? checkOutISO (the actual departure if recorded,
--   else the original scheduled date). This ensures invoice nights reflect
--   what was actually charged, not the original booking span.
--
-- Idempotency:
--   Both functions use CREATE OR REPLACE — safe to re-run.
--
-- Apply mode:
--   SQL Editor (service role). Sections 1 and 2 can run as one block.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- Section 1: Replace checkout_booking — remove check_out_date stomp
--
-- Change vs Phase 11 #48 version:
--   Removed from upd CTE SET clause:
--     check_out_date = COALESCE(p_actual_checkout_date, ar.check_out_date),
--   actual_checkout_date assignment is unchanged.
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
           -- check_out_date intentionally omitted — stays as original scheduled date
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
  'Checks out all active rooms on a booking. Computes per-room early deductions from each room''s own check_out_date. Sets booking_rooms.status=checked_out(_early), rooms.status=cleaning, reduces nights, recomputes total, promotes bookings.status=checked_out. check_out_date is preserved as original scheduled date; actual_checkout_date records the real departure. CTE-based bulk UPDATE — no cursor.';

GRANT EXECUTE ON FUNCTION public.checkout_booking(UUID, DATE)
  TO anon, authenticated;


-- ---------------------------------------------------------------------------
-- Section 2: Replace checkout_booking_room — remove check_out_date stomp
--
-- Change vs 2026-05-08-multi-room-rpc.sql version:
--   Removed from UPDATE SET clause:
--     check_out_date = CASE WHEN p_actual_checkout_date IS NOT NULL
--                       THEN p_actual_checkout_date
--                       ELSE check_out_date END,
--   (and its preceding comment)
--   actual_checkout_date assignment is unchanged.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.checkout_booking_room(
  p_booking_room_id       UUID,
  p_actual_checkout_date  DATE     DEFAULT NULL,  -- NULL = stayed to scheduled date
  p_early_nights_deducted INTEGER  DEFAULT 0,
  p_deduction_amount      NUMERIC  DEFAULT 0
) RETURNS VOID
LANGUAGE plpgsql AS $$
DECLARE
  v_booking_id    UUID;
  v_room_id       UUID;
  v_active_count  INTEGER;
BEGIN
  -- Read context
  SELECT booking_id, room_id
  INTO   v_booking_id, v_room_id
  FROM   public.booking_rooms
  WHERE  id = p_booking_room_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'booking_room % not found', p_booking_room_id;
  END IF;

  -- Update this room's row
  UPDATE public.booking_rooms
  SET status                 = 'checked_out',
      checked_out_at         = NOW(),
      actual_checkout_date   = COALESCE(p_actual_checkout_date, check_out_date),
      early_nights_deducted  = p_early_nights_deducted,
      early_deduction_amount = p_deduction_amount,
      -- Adjust nights if early departure was recorded
      nights                 = CASE WHEN p_early_nights_deducted > 0
                                 THEN nights - p_early_nights_deducted
                                 ELSE nights END,
      -- check_out_date intentionally omitted — stays as original scheduled date
      updated_at             = NOW()
  WHERE id = p_booking_room_id;

  -- Deduct unused nights from booking total (fires trg_sync_payment_status)
  IF p_deduction_amount > 0 THEN
    UPDATE public.bookings
    SET total_amount = GREATEST(0, total_amount - p_deduction_amount)
    WHERE id = v_booking_id;
  END IF;

  -- Set physical room to cleaning
  UPDATE public.rooms
  SET    status     = 'cleaning',
         updated_at = NOW()
  WHERE  id = v_room_id;

  -- Advance booking to checked_out if no rooms are still active
  SELECT COUNT(*) INTO v_active_count
  FROM   public.booking_rooms
  WHERE  booking_id = v_booking_id
    AND  status IN ('confirmed', 'checked_in');

  IF v_active_count = 0 THEN
    -- trg_stamp_booking_timestamps will stamp checked_out_at on bookings
    UPDATE public.bookings
    SET status = 'checked_out'
    WHERE id = v_booking_id
      AND status IS DISTINCT FROM 'checked_out';
  END IF;

END;
$$;

COMMENT ON FUNCTION public.checkout_booking_room IS
  'Checks out one room. Sets status=checked_out, room=cleaning. Handles early deductions. check_out_date is preserved as original scheduled date; actual_checkout_date records the real departure. Advances booking to checked_out when last room completes.';

GRANT EXECUTE ON FUNCTION public.checkout_booking_room(UUID, DATE, INTEGER, NUMERIC)
  TO anon, authenticated;


-- ---------------------------------------------------------------------------
-- Section 3: Verification (run in SQL Editor after applying Sections 1–2)
-- ---------------------------------------------------------------------------

-- V1: Confirm checkout_booking signature is unchanged (2-param)
--
-- SELECT proname, pg_get_function_arguments(oid) AS args
-- FROM   pg_proc
-- WHERE  proname = 'checkout_booking';
--
-- Expected: exactly ONE row with args:
--   p_booking_id uuid, p_actual_checkout_date date DEFAULT NULL

-- V2: Confirm checkout_booking_room signature is unchanged (4-param)
--
-- SELECT proname, pg_get_function_arguments(oid) AS args
-- FROM   pg_proc
-- WHERE  proname = 'checkout_booking_room';
--
-- Expected: exactly ONE row with args:
--   p_booking_room_id uuid,
--   p_actual_checkout_date date DEFAULT NULL,
--   p_early_nights_deducted integer DEFAULT 0,
--   p_deduction_amount numeric DEFAULT 0

-- V3: Spot-check BK-1076 (same-day checkout, the constraint-violation booking)
--
-- SELECT br.booking_id, br.check_in_date, br.check_out_date,
--        br.actual_checkout_date, br.nights, br.status
-- FROM   public.booking_rooms br
-- JOIN   public.bookings b ON b.id = br.booking_id
-- WHERE  b.booking_ref = 'BK-1076';
--
-- Expected post-fix checkout: check_out_date = original scheduled date
--   (NOT overwritten to actual departure date)

-- V4: Confirm no check_out_date < check_in_date violations
--
-- SELECT booking_ref, br.check_in_date, br.check_out_date
-- FROM   public.booking_rooms br
-- JOIN   public.bookings b ON b.id = br.booking_id
-- WHERE  br.check_out_date <= br.check_in_date;
--
-- Expected: 0 rows


-- ===========================================================================
-- END OF MIGRATION
-- ===========================================================================

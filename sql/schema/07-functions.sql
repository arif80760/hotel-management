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
--   disburse_refund            → 2026-05-09-phase8.5-refund-disbursement.sql
--                                Revised: 2026-05-15-phase11-58a-overpayment-auto-refund.sql
--                                (pre_adjusted branch — see Section 4 of that migration)
--   deny_refund                → 2026-05-09-phase8.5-refund-disbursement.sql
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
-- Revised: 2026-05-14 via migration
--        2026-05-14-phase11-57-checkout-stop-stomping-check-out-date.sql
--        Removed check_out_date stomp from upd CTE.
-- Revised: 2026-05-15 via migration
--        2026-05-15-phase11-58a-overpayment-auto-refund.sql
--        Added step 3.5: overpayment detection + pending refund auto-creation.
-- Revised: 2026-05-16 via migration
--        2026-05-16-phase11-58b-discount-in-rpc.sql
--        Signature: added p_additional_discount_amount/reason/by params.
--        Step 3.5: v_discount now sourced from parameter (not DB column).
--        Added step 3.6: write additional_discount_* columns inside RPC.
-- Revised: 2026-05-16 via migration
--        2026-05-16-phase11-58b-fix-discount-by-type.sql
--        p_additional_discount_by: TEXT → UUID (matches bookings column type).
-- ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.checkout_booking(
  p_booking_id                   UUID,
  p_actual_checkout_date         DATE    DEFAULT NULL,
  p_additional_discount_amount   NUMERIC DEFAULT 0,
  p_additional_discount_reason   TEXT    DEFAULT NULL,
  p_additional_discount_by       UUID    DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_room_ids        UUID[];
  -- Step 3.5 / 3.6: overpayment detection + discount write
  v_new_rooms_total NUMERIC;
  v_paid_amount     NUMERIC;
  v_extra_charge    NUMERIC;
  v_discount        NUMERIC;
  v_effective_total NUMERIC;
  v_overpayment     NUMERIC;
  v_refund_id       UUID;
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

  -- ── 3. Set physical rooms to cleaning ─────────────────────────────────────
  -- v_room_ids is NULL when 0 active rows (already-terminal booking).
  -- Guard prevents a vacuous ANY(NULL) match.
  IF v_room_ids IS NOT NULL THEN
    UPDATE public.rooms
    SET    status     = 'cleaning',
           updated_at = NOW()
    WHERE  id = ANY(v_room_ids);
  END IF;

  -- ── 3.5. Detect overpayment and auto-create pending refund ────────────────
  -- v_discount is sourced from p_additional_discount_amount (not the DB column)
  -- so the overpayment check accounts for the discount being applied in step 3.6.
  -- Must run BEFORE step 3.6 (discount write) and step 4 (update_booking_total)
  -- so that paid_amount is already decremented when chk_paid_not_exceed_total
  -- evaluates.
  --
  -- Reads booking_rooms.nights AFTER step 2's CTE reduced them — same values
  -- update_booking_total will sum. If no overpayment, this block is a no-op.
  SELECT COALESCE(SUM(br.nights * br.booking_rate), 0),
         b.paid_amount,
         COALESCE(b.extra_charge_amount, 0)
  INTO   v_new_rooms_total, v_paid_amount, v_extra_charge
  FROM   public.bookings b
  LEFT JOIN public.booking_rooms br
         ON br.booking_id = b.id
        AND br.status NOT IN ('cancelled')
  WHERE  b.id = p_booking_id
  GROUP BY b.paid_amount, b.extra_charge_amount;

  v_discount        := p_additional_discount_amount;
  v_effective_total := v_new_rooms_total + v_extra_charge - v_discount;

  IF v_paid_amount > v_effective_total THEN
    v_overpayment := v_paid_amount - v_effective_total;

    INSERT INTO public.refunds (booking_id, booking_room_id, amount, reason, status, created_by, pre_adjusted)
    VALUES (p_booking_id, NULL, v_overpayment, 'Auto-created from checkout — overpayment ৳' || v_overpayment::TEXT, 'pending', NULL, TRUE)
    RETURNING id INTO v_refund_id;

    INSERT INTO public.payments (booking_id, amount, method, notes, refund_id)
    VALUES (p_booking_id, -v_overpayment, 'other'::public.payment_method, 'Auto-refund pre-adjustment — refund row ' || v_refund_id::TEXT, v_refund_id);
    -- trg_sync_paid_amount fires; paid_amount now = v_effective_total
  END IF;

  -- ── 3.6. Write additional_discount_* columns ─────────────────────────────
  -- Runs after step 3.5 so the overpayment check saw the correct effective_total.
  -- Runs before step 4 (update_booking_total) so the total is recomputed with
  -- the discount already written. chk_paid_not_exceed_total is safe because
  -- step 3.5 already decremented paid_amount if needed.
  IF p_additional_discount_amount > 0 THEN
    UPDATE public.bookings
    SET    additional_discount_amount = p_additional_discount_amount,
           additional_discount_reason = p_additional_discount_reason,
           additional_discount_by     = p_additional_discount_by,
           additional_discount_at     = NOW()
    WHERE  id = p_booking_id;
  END IF;

  -- ── 4. Recompute booking total ────────────────────────────────────────────
  -- Step 3.5 already decremented paid_amount when needed, so
  -- chk_paid_not_exceed_total will not fire. Fires trg_sync_payment_status.
  PERFORM public.update_booking_total(p_booking_id);

  -- ── 5. Promote booking to checked_out ─────────────────────────────────────
  -- IS DISTINCT FROM guard prevents a no-op UPDATE from firing triggers.
  UPDATE public.bookings
  SET    status = 'checked_out'
  WHERE  id     = p_booking_id
    AND  status IS DISTINCT FROM 'checked_out';

END;
$$;

GRANT EXECUTE ON FUNCTION public.checkout_booking(UUID, DATE, NUMERIC, TEXT, UUID)
  TO anon, authenticated;


-- ──────────────────────────────────────────────────────────────
-- room_analytics_by_room
-- Per-room performance metrics for a date range.
-- Returns one row per room with bookings, occupied/available nights,
-- revenue, ADR (NULL for never-booked rooms), RevPAR, and occupancy%.
-- Revenue basis is booking_rate × nights; extra charges excluded so
-- ADR/RevPAR stay true to standard hotel definitions.
-- room_status is returned so the client can exclude maintenance rooms
-- from KPI denominators.
-- Added: 2026-06-07 via migration 2026-06-07-room-analytics-rpcs.sql.
-- ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.room_analytics_by_room(p_from date, p_to date)
RETURNS TABLE (
  room_id uuid, room_number text, floor smallint, category text,
  room_status text, price_per_night numeric, bookings bigint,
  occupied_nights bigint, available_nights integer, revenue numeric,
  adr numeric, revpar numeric, occupancy_pct numeric
)
LANGUAGE sql
STABLE
AS $$
  WITH params AS (
    SELECT (p_to - p_from + 1)::int AS avail_nights
  ),
  -- aggregate REAL booking_rooms rows only, so no NULL-row arithmetic
  br_agg AS (
    SELECT
      br.room_id,
      SUM(GREATEST(0,
        LEAST(COALESCE(br.actual_checkout_date, br.check_out_date), p_to + 1)
        - GREATEST(br.check_in_date, p_from))) AS occupied_nights,
      COUNT(*) FILTER (WHERE GREATEST(0,
        LEAST(COALESCE(br.actual_checkout_date, br.check_out_date), p_to + 1)
        - GREATEST(br.check_in_date, p_from)) > 0) AS bookings,
      SUM(GREATEST(0,
        LEAST(COALESCE(br.actual_checkout_date, br.check_out_date), p_to + 1)
        - GREATEST(br.check_in_date, p_from)) * br.booking_rate) AS revenue
    FROM public.booking_rooms br
    WHERE br.status <> 'cancelled'
      AND br.check_in_date <= p_to
      AND COALESCE(br.actual_checkout_date, br.check_out_date) > p_from
    GROUP BY br.room_id
  )
  SELECT
    r.id, r.room_number, r.floor, r.category, r.status::text, r.price_per_night,
    COALESCE(a.bookings, 0)        AS bookings,
    COALESCE(a.occupied_nights, 0) AS occupied_nights,
    p.avail_nights                 AS available_nights,
    COALESCE(a.revenue, 0)         AS revenue,
    CASE WHEN COALESCE(a.occupied_nights,0) > 0
         THEN ROUND(a.revenue / a.occupied_nights, 2) END AS adr,
    CASE WHEN p.avail_nights > 0
         THEN ROUND(COALESCE(a.revenue,0) / p.avail_nights, 2) END AS revpar,
    CASE WHEN p.avail_nights > 0
         THEN ROUND(100.0 * COALESCE(a.occupied_nights,0) / p.avail_nights, 1) END AS occupancy_pct
  FROM public.rooms r
  CROSS JOIN params p
  LEFT JOIN br_agg a ON a.room_id = r.id
  ORDER BY COALESCE(a.revenue,0) DESC;
$$;

GRANT EXECUTE ON FUNCTION public.room_analytics_by_room(date, date) TO authenticated, service_role;


-- ──────────────────────────────────────────────────────────────
-- room_occupancy_trend
-- One row per calendar day in [p_from, p_to].
-- occupied_rooms = DISTINCT rooms with an active booking on that day
--   (cancelled bookings excluded).
-- available_rooms = total rooms NOT in maintenance status (snapshot
--   of current status — maintenance changes are not time-tracked).
-- occupancy_pct = 100 * occupied / available (NULL if no avail rooms).
-- Caps at 100%+ only when genuine double-bookings exist.
-- Added: 2026-06-07 via migration 2026-06-07-room-analytics-rpcs.sql.
-- ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.room_occupancy_trend(p_from date, p_to date)
RETURNS TABLE (
  day date,
  occupied_rooms integer,
  available_rooms integer,
  occupancy_pct numeric
)
LANGUAGE sql
STABLE
AS $$
  WITH days AS (
    SELECT generate_series(p_from, p_to, interval '1 day')::date AS day
  ),
  avail AS (
    SELECT COUNT(*)::int AS available_rooms
    FROM public.rooms
    WHERE status <> 'maintenance'
  ),
  occ AS (
    SELECT d.day,
           COUNT(DISTINCT br.room_id) AS occupied_rooms
    FROM days d
    LEFT JOIN public.booking_rooms br
      ON br.status <> 'cancelled'
     AND br.check_in_date <= d.day
     AND COALESCE(br.actual_checkout_date, br.check_out_date) > d.day
    GROUP BY d.day
  )
  SELECT
    o.day,
    o.occupied_rooms::int,
    a.available_rooms,
    CASE WHEN a.available_rooms > 0
         THEN ROUND(100.0 * o.occupied_rooms / a.available_rooms, 1) END AS occupancy_pct
  FROM occ o CROSS JOIN avail a
  ORDER BY o.day;
$$;

GRANT EXECUTE ON FUNCTION public.room_occupancy_trend(date, date) TO authenticated, service_role;

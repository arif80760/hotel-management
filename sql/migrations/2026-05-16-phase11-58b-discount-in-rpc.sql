-- =============================================================
-- 2026-05-16-phase11-58b-discount-in-rpc.sql
-- Phase 11 #58b — Move additional_discount_* write into checkout_booking RPC
--
-- Problem:
--   checkout_booking step 3.5 (overpayment detection) reads
--   bookings.additional_discount_amount from the DB column.
--   At RPC call time the column is always 0 — the discount is written
--   in checkoutNormal / checkoutWithOverride Step 2 AFTER the RPC returns.
--   When a fully-paid booking has a discount applied at checkout, the
--   overpayment check sees effective_total too high, skips refund creation,
--   and then Step 2's UPDATE hits chk_paid_not_exceed_total because
--   paid_amount > total_amount - discount.
--
-- Fix (Option B1):
--   1. Add p_additional_discount_amount / _reason / _by params to checkout_booking.
--   2. Step 3.5 sources v_discount from the parameter, not the DB column.
--   3. New step 3.6: write additional_discount_* to bookings AFTER step 3.5
--      (paid_amount already decremented) and BEFORE step 4 (update_booking_total).
--      Constraint proof: after step 3.5, paid_amount = effective_total.
--      After step 3.6 writes the discount, paid_amount = rooms + extra - discount
--      = total_amount (post-update_booking_total). Constraint holds at every point.
--   4. bookingsService.ts Step 2: remove additional_discount_* from POST-RPC
--      bookingsPayload / updatePayload. Extra charge columns stay in Step 2.
--
-- Overload note:
--   checkout_booking(UUID, DATE) is a different overload from
--   checkout_booking(UUID, DATE, NUMERIC, TEXT, TEXT).
--   We DROP the old 2-param overload first to avoid PostgREST ambiguity.
--
-- GRANT note:
--   GRANT TO anon is intentional. This app uses the anon key for all
--   authenticated-user calls (Supabase anon key + RLS). The SECURITY
--   DEFINER on this function handles the privilege escalation needed
--   for cross-table writes.
-- =============================================================


-- ── Section 1: DROP old 2-param overload ────────────────────────────────────
-- Required before CREATE OR REPLACE — changing the param list creates a new
-- overload, not a replacement. PostgREST would surface both, causing ambiguity.
DROP FUNCTION IF EXISTS public.checkout_booking(UUID, DATE);


-- ── Section 2: checkout_booking (5-param) ───────────────────────────────────
CREATE OR REPLACE FUNCTION public.checkout_booking(
  p_booking_id                   UUID,
  p_actual_checkout_date         DATE    DEFAULT NULL,
  p_additional_discount_amount   NUMERIC DEFAULT 0,
  p_additional_discount_reason   TEXT    DEFAULT NULL,
  p_additional_discount_by       TEXT    DEFAULT NULL
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

GRANT EXECUTE ON FUNCTION public.checkout_booking(UUID, DATE, NUMERIC, TEXT, TEXT)
  TO anon, authenticated;

-- Reload PostgREST schema cache so the new overload is visible immediately.
NOTIFY pgrst, 'reload schema';

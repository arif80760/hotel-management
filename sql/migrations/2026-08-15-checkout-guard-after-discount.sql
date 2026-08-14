-- =============================================================
-- 2026-08-15-checkout-guard-after-discount.sql
-- Move the checkout balance guard AFTER the discount write.
--
-- RECORD OF LIVE STATE — applied and verified in the Supabase SQL
-- editor on 2026-08-15 (reversal_applied = true). Committed for
-- history. SQL below is VERBATIM the live body.
--
-- WHAT CHANGED (vs 2026-08-14-checkout-balance-guard.sql, whose
-- checkout_booking body this SUPERSEDES — assert_checkout_allowed and
-- checkout_booking_room are unchanged from that file):
--   The PERFORM public.assert_checkout_allowed(p_booking_id,
--   p_override) moved from BEFORE step 3.6 (the additional_discount_*
--   write) to AFTER it. Nothing else differs.
--
-- WHY (decision by Arif, 2026-08-15):
--   A discount up to the outstanding balance should clear it and
--   allow checkout WITHOUT an admin override. With the guard after
--   3.6, assert_checkout_allowed reads the balance with this
--   checkout's discount already applied (its due expression subtracts
--   additional_discount_amount). validateAndBuildDiscount caps the
--   discount at the billable total client-side, so staff cannot
--   discount more than is owed.
--
-- TRADE-OFF, ACCEPTED KNOWINGLY:
--   This reopens the full-total-discount route that the 2026-08-14
--   placement closed (the route behind nine write-offs totalling
--   ৳33,900). Mitigations in place: the discount fields sit collapsed
--   behind the amber "Apply Discount" disclosure button (Add Payment
--   is the prominent path), the discount reason is recorded, and
--   additional_discount_by names the applier. The admin override (and
--   its mandatory reason) is now required only when a balance REMAINS
--   after the discount.
--
-- checkout_booking_room is UNAFFECTED — it has no discount parameter;
-- its guard stays between its status check and first UPDATE.
-- =============================================================

CREATE OR REPLACE FUNCTION public.checkout_booking(p_booking_id uuid, p_actual_checkout_date date DEFAULT NULL::date, p_additional_discount_amount numeric DEFAULT 0, p_additional_discount_reason text DEFAULT NULL::text, p_additional_discount_by uuid DEFAULT NULL::uuid, p_override boolean DEFAULT false)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
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
  v_final_status    public.booking_status;   -- step 5: checked_out vs checked_out_early
BEGIN

  -- ── 1. Validate booking exists ────────────────────────────────────────────
  IF NOT EXISTS (SELECT 1 FROM public.bookings WHERE id = p_booking_id) THEN
    RAISE EXCEPTION 'booking % not found', p_booking_id;
  END IF;

  -- ── 2. Per-room early deductions + bulk checkout via CTE ──────────────────
  -- early_nights is now floored at (nights - 1) so the recorded deduction can
  -- never zero out a checked-in room's charge — matches the GREATEST(1, …) on
  -- nights below. No money change: nights was already floored before.
  WITH active_rooms AS (
    SELECT id                                                              AS room_row_id,
           room_id,
           check_out_date,
           booking_rate,
           nights,
           -- ⬇ CHANGED: cap unused nights at (nights - 1) so ≥1 night stays charged
           LEAST(
             GREATEST(0,
               check_out_date
               - COALESCE(p_actual_checkout_date, check_out_date)
             ),
             GREATEST(0, nights - 1)
           )                                                               AS early_nights,
           -- ⬇ CHANGED: same capped expression × rate
           LEAST(
             GREATEST(0,
               check_out_date
               - COALESCE(p_actual_checkout_date, check_out_date)
             ),
             GREATEST(0, nights - 1)
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

  -- ── 3. Free physical rooms to available ───────────────────────────────────
  IF v_room_ids IS NOT NULL THEN
    UPDATE public.rooms
    SET    status     = 'available',
           updated_at = NOW()
    WHERE  id = ANY(v_room_ids);
  END IF;

  -- ── 3.5. Detect overpayment and auto-create pending refund ────────────────
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
  IF p_additional_discount_amount > 0 THEN
    UPDATE public.bookings
    SET    additional_discount_amount = p_additional_discount_amount,
           additional_discount_reason = p_additional_discount_reason,
           additional_discount_by     = p_additional_discount_by,
           additional_discount_at     = NOW()
    WHERE  id = p_booking_id;
  END IF;

  -- ── Balance guard — AFTER step 3.6, deliberately ─────────────────────────
  -- REVERSED 2026-08-15 at Arif's instruction (was before 3.6): the guard
  -- now reads the balance WITH this checkout's discount already written, so
  -- a discount up to the outstanding balance clears it and checkout proceeds
  -- without an admin override. validateAndBuildDiscount caps the discount at
  -- the billable total client-side. NOTE: this reopens the full-total-
  -- discount route that the before-3.6 placement closed (nine write-offs,
  -- ৳33,900); accepted mitigations: the discount fields sit behind the amber
  -- disclosure button, the reason is recorded, and additional_discount_by
  -- names the applier.
  PERFORM public.assert_checkout_allowed(p_booking_id, p_override);

  -- ── 4. Recompute booking total ────────────────────────────────────────────
  PERFORM public.update_booking_total(p_booking_id);

  -- ── 5. Promote booking to checked_out / checked_out_early ─────────────────
  v_final_status := CASE
    WHEN EXISTS (
      SELECT 1 FROM public.booking_rooms br
      WHERE br.booking_id = p_booking_id
        AND br.status = 'checked_out_early'
    )
    THEN 'checked_out_early'::public.booking_status
    ELSE 'checked_out'::public.booking_status
  END;

  UPDATE public.bookings
  SET    status = v_final_status
  WHERE  id     = p_booking_id
    AND  status IS DISTINCT FROM v_final_status;

END;
$function$;

-- =============================================================
-- 2026-08-20-checkout-dhaka-clamp.sql
-- Departure-date clamp in BOTH checkout RPCs — Dhaka-local.
--
-- RECORD OF LIVE STATE — applied in the Supabase SQL editor on
-- 2026-08-20 (comments stripped in the applied paste; code below is
-- byte-identical to what runs live).
--
-- WHY: pressing Check Out late stamped press-day as
-- actual_checkout_date (10 of the 13 post-launch overlap pairs — a
-- completed stay then "occupies" the room past its real departure,
-- via COALESCE(actual, check_out) in the availability guards). The
-- 53 pre-existing late stamps carried ZERO nights/refund damage
-- (verified 2026-08-19). Staff-facing fix: the departure-date picker
-- in both checkout modals (defaults today, bounded [check-in, local
-- today]). This clamp is the SERVER backstop:
--
--   actual_eff = GREATEST(check_in_date,
--                  LEAST(COALESCE(p_actual_checkout_date, check_out_date),
--                        (now() AT TIME ZONE 'Asia/Dhaka')::date))
--
-- DHAKA-LOCAL, not current_date: current_date follows the session
-- timezone (UTC on Supabase) — between 00:00 and 06:00 Dhaka it is
-- still "yesterday", which would rewind a legitimate 2am checkout,
-- fire a phantom early deduction, and auto-create a refund +
-- negative payment. Money-moving midnight bug, caught in review.
--
-- Everything outside the clamp is byte-identical to the live bodies
-- pasted by Arif on 2026-08-19 (multi-room CTE checkout_booking;
-- checkout_booking_room per 2026-08-17 migration + added
-- v_check_in_date read).
-- =============================================================

CREATE OR REPLACE FUNCTION public.checkout_booking(p_booking_id uuid, p_actual_checkout_date date DEFAULT NULL::date, p_additional_discount_amount numeric DEFAULT 0, p_additional_discount_reason text DEFAULT NULL::text, p_additional_discount_by uuid DEFAULT NULL::uuid, p_override boolean DEFAULT false)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_room_ids        UUID[];
  v_new_rooms_total NUMERIC;
  v_paid_amount     NUMERIC;
  v_extra_charge    NUMERIC;
  v_discount        NUMERIC;
  v_effective_total NUMERIC;
  v_overpayment     NUMERIC;
  v_refund_id       UUID;
  v_final_status    public.booking_status;
BEGIN

  -- ── 1. Validate booking exists ────────────────────────────────────────────
  IF NOT EXISTS (SELECT 1 FROM public.bookings WHERE id = p_booking_id) THEN
    RAISE EXCEPTION 'booking % not found', p_booking_id;
  END IF;

  -- ── 2. Per-room early deductions + bulk checkout via CTE ──────────────────
  -- CLAMP (2026-08-20): actual_eff bounded to [check_in_date, Dhaka today].
  WITH active_rooms AS (
    SELECT id                                                              AS room_row_id,
           room_id,
           check_out_date,
           booking_rate,
           nights,
           GREATEST(check_in_date,
             LEAST(COALESCE(p_actual_checkout_date, check_out_date),
                   (now() AT TIME ZONE 'Asia/Dhaka')::date)
           )                                                               AS actual_eff,
           LEAST(
             GREATEST(0,
               check_out_date
               - GREATEST(check_in_date,
                   LEAST(COALESCE(p_actual_checkout_date, check_out_date),
                         (now() AT TIME ZONE 'Asia/Dhaka')::date))
             ),
             GREATEST(0, nights - 1)
           )                                                               AS early_nights,
           LEAST(
             GREATEST(0,
               check_out_date
               - GREATEST(check_in_date,
                   LEAST(COALESCE(p_actual_checkout_date, check_out_date),
                         (now() AT TIME ZONE 'Asia/Dhaka')::date))
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
           actual_checkout_date   = ar.actual_eff,
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

  -- ── Balance guard — AFTER step 3.6, deliberately (2026-08-15) ────────────
  -- Reads the balance WITH this checkout's discount already written. Two-arg
  -- call resolves via p_booking_room_id DEFAULT NULL — single three-param
  -- signature confirmed live 2026-08-20, no stale overload.
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

-- ─────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.checkout_booking_room(p_booking_room_id uuid, p_actual_checkout_date date DEFAULT NULL::date, p_early_nights_deducted integer DEFAULT 0, p_deduction_amount numeric DEFAULT 0, p_override boolean DEFAULT false)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_booking_id      UUID;
  v_room_id         UUID;
  v_current_status  public.booking_status;
  v_check_in_date   DATE;
  v_check_out_date  DATE;
  v_booking_rate    NUMERIC;
  v_nights          SMALLINT;
  v_actual          DATE;
  v_early_nights    INTEGER;
  v_deduction_amt   NUMERIC := 0;
  v_active_count    INTEGER;
  v_paid_amount     NUMERIC;
  v_current_total   NUMERIC;
  v_extra_charge    NUMERIC;
  v_discount        NUMERIC;
  v_new_total       NUMERIC;
  v_effective_total NUMERIC;
  v_overpayment     NUMERIC;
  v_refund_id       UUID;
  v_final_status    public.booking_status;
BEGIN
  -- 1. Read the room row (check_in_date added 2026-08-20 for the clamp)
  SELECT booking_id, room_id, status, check_in_date, check_out_date, booking_rate, nights
  INTO   v_booking_id, v_room_id, v_current_status, v_check_in_date, v_check_out_date, v_booking_rate, v_nights
  FROM   public.booking_rooms WHERE id = p_booking_room_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'booking_room % not found', p_booking_room_id; END IF;

  -- 2. Guard: only a checked-in room can be checked out
  IF v_current_status <> 'checked_in' THEN
    RAISE EXCEPTION 'Can only check out a room with status=checked_in. Current status: %', v_current_status;
  END IF;

  -- Balance guard — per-room scope (2026-08-17): early return while OTHER
  -- rooms on the booking are still active; full guard on the LAST room.
  PERFORM public.assert_checkout_allowed(v_booking_id, p_override, p_booking_room_id);

  -- 3. Compute floored early nights server-side (same expression as checkout_booking)
  -- CLAMP (2026-08-20): actual bounded to [check_in_date, DHAKA-local today].
  v_actual := GREATEST(v_check_in_date,
                LEAST(COALESCE(p_actual_checkout_date, v_check_out_date),
                      (now() AT TIME ZONE 'Asia/Dhaka')::date));
  v_early_nights  := LEAST(GREATEST(0, v_check_out_date - v_actual), GREATEST(0, v_nights - 1));
  v_deduction_amt := v_early_nights::NUMERIC * v_booking_rate;

  -- 4. Write the room — normal 'checked_out' unless genuinely early
  UPDATE public.booking_rooms
  SET status = CASE WHEN v_early_nights > 0
                    THEN 'checked_out_early'::public.booking_status
                    ELSE 'checked_out'::public.booking_status END,
      checked_out_at         = NOW(),
      actual_checkout_date   = v_actual,
      early_nights_deducted  = v_early_nights,
      early_deduction_amount = v_deduction_amt,
      nights                 = GREATEST(1, v_nights - v_early_nights),  -- respect chk_br_nights (>0)
      updated_at             = NOW()
  WHERE id = p_booking_room_id;

  -- 5. Overpayment auto-refund only if there's an actual deduction
  IF v_deduction_amt > 0 THEN
    SELECT b.paid_amount, b.total_amount,
           COALESCE(b.extra_charge_amount, 0), COALESCE(b.additional_discount_amount, 0)
    INTO   v_paid_amount, v_current_total, v_extra_charge, v_discount
    FROM   public.bookings b WHERE b.id = v_booking_id;

    v_new_total       := GREATEST(0, v_current_total - v_deduction_amt);
    v_effective_total := v_new_total + v_extra_charge - v_discount;

    IF v_paid_amount > v_effective_total THEN
      v_overpayment := v_paid_amount - v_effective_total;
      INSERT INTO public.refunds (booking_id, booking_room_id, amount, reason, status, created_by, pre_adjusted)
      VALUES (v_booking_id, p_booking_room_id, v_overpayment, 'Auto-created from checkout — overpayment ৳' || v_overpayment::TEXT, 'pending', NULL, TRUE)
      RETURNING id INTO v_refund_id;
      INSERT INTO public.payments (booking_id, amount, method, notes, refund_id)
      VALUES (v_booking_id, -v_overpayment, 'other'::public.payment_method, 'Auto-refund pre-adjustment — refund row ' || v_refund_id::TEXT, v_refund_id);
    END IF;
  END IF;

  -- 6. Free the physical room
  UPDATE public.rooms SET status='available', updated_at=NOW() WHERE id = v_room_id;

  -- 7. Recompute booking total (rooms-only, after any negative payment)
  PERFORM public.update_booking_total(v_booking_id);

  -- 8. Derive + sync parent booking status (full multi-room CASE, from cancel_booking_room)
  SELECT CASE
      WHEN COUNT(*) = COUNT(*) FILTER (WHERE status='cancelled') THEN 'cancelled'::public.booking_status
      WHEN COUNT(*) FILTER (WHERE status='checked_in') > 0 THEN 'checked_in'::public.booking_status
      WHEN COUNT(*) FILTER (WHERE status IN ('confirmed','checked_in')) = 0
        THEN CASE WHEN COUNT(*) FILTER (WHERE status='checked_out_early') > 0
                  THEN 'checked_out_early'::public.booking_status
                  ELSE 'checked_out'::public.booking_status END
      ELSE 'confirmed'::public.booking_status
    END
  INTO v_final_status FROM public.booking_rooms WHERE booking_id = v_booking_id;

  UPDATE public.bookings SET status = v_final_status
  WHERE id = v_booking_id AND status IS DISTINCT FROM v_final_status;
END;
$function$;

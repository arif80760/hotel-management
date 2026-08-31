-- =============================================================
-- 2026-08-26-checkout-guard-after-recompute.sql
-- Guard-ordering fix: assert_checkout_allowed now runs AFTER
-- update_booking_total in EVERY checkout door.
--
-- RECORD OF LIVE STATE — all three bodies applied in the Supabase
-- SQL editor on 2026-08-26 and probe-verified the same day:
--   • positive probe (BK-1589, early departure whose deduction
--     settles the balance): completed with NO exception (ROLLBACK-
--     wrapped) — the pre-fix guard raised on exactly this shape.
--   • negative probe (BK-1611, zero-paid): still raises, now
--     quoting the POST-deduction due (2500.00; pre-fix said
--     5000.00) — the guard finally reports the true figure.
--
-- INCIDENT (BK-1575, 2026-08-26): 4-night ৳12,000 stay, paid
-- ৳8,000, leaving 2 nights early (deduction ৳4,000). Client Final
-- Payable correctly showed ৳0; assert_checkout_allowed raised
-- "outstanding balance of 4000.00". CAUSE: the guard ran before
-- update_booking_total, reading the pre-deduction cached
-- bookings.total_amount while the reduced nights were already in
-- booking_rooms. ASYMMETRY: discounts cleared the guard (written at
-- step 3.6, before it); early deductions did not (applied after).
--
-- FIX (approach chosen over teaching the guard to derive from
-- booking_rooms — which would not have fixed the pre-write call
-- sites and would fork the canonical due formula): reorder so
-- update_booking_total runs before the guard in all three doors.
-- Guard body BYTE-UNTOUCHED — one semantics everywhere.
--   1. checkout_booking: two adjacent statements swapped (3.5's
--      overpayment logic computes from booking_rooms — unaffected;
--      its negative-payment insert still precedes the total write,
--      preserving chk_paid_not_exceed_total ordering).
--   2. checkout_booking_room: guard moved from pre-write to after
--      update_booking_total. Safe because the guard's staged-stay
--      early-return counts OTHER rooms only (br.id <>
--      p_booking_room_id) — this room's own flip cannot change the
--      count — and a raise rolls back the whole function atomically.
--   3. cancel_booking_room: same move for its checked_out_early
--      guard (same false-block existed through the cancel door);
--      refund branches now precede the guard, which is correct — an
--      atomic disburse reduces paid before the due check, and
--      refunds only fire on overpayment (due <= 0).
-- The door-4 trigger (trg_guard_checkout_status) was already
-- correct — the bookings-status flip is the last statement in every
-- door, after the recompute.
--
-- RULE (also in CLAUDE.md): any future checkout-shaped door must
-- call update_booking_total BEFORE assert_checkout_allowed, so
-- discounts and early deductions clear the guard symmetrically.
-- =============================================================

-- ── 1. checkout_booking ──

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

  IF NOT EXISTS (SELECT 1 FROM public.bookings WHERE id = p_booking_id) THEN
    RAISE EXCEPTION 'booking % not found', p_booking_id;
  END IF;

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

  IF v_room_ids IS NOT NULL THEN
    UPDATE public.rooms
    SET    status     = 'available',
           updated_at = NOW()
    WHERE  id = ANY(v_room_ids);
  END IF;

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

  IF p_additional_discount_amount > 0 THEN
    UPDATE public.bookings
    SET    additional_discount_amount = p_additional_discount_amount,
           additional_discount_reason = p_additional_discount_reason,
           additional_discount_by     = p_additional_discount_by,
           additional_discount_at     = NOW()
    WHERE  id = p_booking_id;
  END IF;

  PERFORM public.update_booking_total(p_booking_id);

  PERFORM public.assert_checkout_allowed(p_booking_id, p_override);

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

-- ── 2. checkout_booking_room ──

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
  SELECT booking_id, room_id, status, check_in_date, check_out_date, booking_rate, nights
  INTO   v_booking_id, v_room_id, v_current_status, v_check_in_date, v_check_out_date, v_booking_rate, v_nights
  FROM   public.booking_rooms WHERE id = p_booking_room_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'booking_room % not found', p_booking_room_id; END IF;

  IF v_current_status <> 'checked_in' THEN
    RAISE EXCEPTION 'Can only check out a room with status=checked_in. Current status: %', v_current_status;
  END IF;

  v_actual := GREATEST(v_check_in_date,
                LEAST(COALESCE(p_actual_checkout_date, v_check_out_date),
                      (now() AT TIME ZONE 'Asia/Dhaka')::date));
  v_early_nights  := LEAST(GREATEST(0, v_check_out_date - v_actual), GREATEST(0, v_nights - 1));
  v_deduction_amt := v_early_nights::NUMERIC * v_booking_rate;

  UPDATE public.booking_rooms
  SET status = CASE WHEN v_early_nights > 0
                    THEN 'checked_out_early'::public.booking_status
                    ELSE 'checked_out'::public.booking_status END,
      checked_out_at         = NOW(),
      actual_checkout_date   = v_actual,
      early_nights_deducted  = v_early_nights,
      early_deduction_amount = v_deduction_amt,
      nights                 = GREATEST(1, v_nights - v_early_nights),
      updated_at             = NOW()
  WHERE id = p_booking_room_id;

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

  UPDATE public.rooms SET status='available', updated_at=NOW() WHERE id = v_room_id;

  PERFORM public.update_booking_total(v_booking_id);

  PERFORM public.assert_checkout_allowed(v_booking_id, p_override, p_booking_room_id);

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

-- ── 3. cancel_booking_room ──

CREATE OR REPLACE FUNCTION public.cancel_booking_room(p_booking_room_id uuid, p_status text, p_actual_check_out date DEFAULT NULL::date, p_refund_amount numeric DEFAULT NULL::numeric, p_refund_reason text DEFAULT NULL::text, p_refund_created_by uuid DEFAULT NULL::uuid, p_disbursement_method text DEFAULT NULL::text, p_disbursement_notes text DEFAULT NULL::text, p_disbursed_by uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_booking_id           UUID;
  v_room_id              UUID;
  v_current_status       public.booking_status;
  v_check_in_date        DATE;
  v_check_out_date       DATE;
  v_booking_rate         NUMERIC;
  v_nights               SMALLINT;
  v_actual               DATE;
  v_early_nights         INTEGER;
  v_deduction_amount     NUMERIC  := 0;
  v_derived_status       public.booking_status;
  v_refund_id            UUID     := NULL;
  v_paid_amount          NUMERIC;
  v_current_total        NUMERIC;
  v_estimated_new_total  NUMERIC;
  v_overpayment          NUMERIC;
BEGIN

  SELECT booking_id, room_id, status, check_in_date, check_out_date, booking_rate, nights
  INTO   v_booking_id, v_room_id, v_current_status,
         v_check_in_date, v_check_out_date, v_booking_rate, v_nights
  FROM   public.booking_rooms
  WHERE  id = p_booking_room_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'booking_room % not found', p_booking_room_id;
  END IF;

  SELECT paid_amount, total_amount
  INTO   v_paid_amount, v_current_total
  FROM   public.bookings
  WHERE  id = v_booking_id;

  IF p_status NOT IN ('cancelled', 'checked_out_early') THEN
    RAISE EXCEPTION
      'Invalid p_status ''%''. Must be ''cancelled'' or ''checked_out_early''.', p_status;
  END IF;

  IF p_status = 'cancelled' AND v_current_status <> 'confirmed' THEN
    RAISE EXCEPTION
      'Can only cancel a room with status=confirmed. Current status: %', v_current_status;
  END IF;

  IF p_status = 'checked_out_early' AND v_current_status <> 'checked_in' THEN
    RAISE EXCEPTION
      'Can only mark checked_out_early a room with status=checked_in. Current status: %',
      v_current_status;
  END IF;

  IF p_status = 'checked_out_early' AND p_actual_check_out IS NULL THEN
    RAISE EXCEPTION
      'p_actual_check_out is required when p_status = ''checked_out_early''.';
  END IF;

  IF p_status = 'checked_out_early'
     AND p_actual_check_out > v_check_out_date THEN
    RAISE EXCEPTION
      'p_actual_check_out (%) cannot be after scheduled check_out_date (%). '
      'Use extend_booking_room instead.',
      p_actual_check_out, v_check_out_date;
  END IF;

  IF p_status = 'checked_out_early' THEN

    v_actual := GREATEST(v_check_in_date,
                  LEAST(p_actual_check_out,
                        (now() AT TIME ZONE 'Asia/Dhaka')::date));

    v_early_nights     := LEAST(
                            GREATEST(0, v_check_out_date - v_actual),
                            GREATEST(0, v_nights - 1)
                          );
    v_deduction_amount := v_early_nights::NUMERIC * v_booking_rate;

    UPDATE public.booking_rooms
    SET status                 = 'checked_out_early'::public.booking_status,
        actual_checkout_date   = v_actual,
        early_nights_deducted  = v_early_nights,
        early_deduction_amount = v_deduction_amount,
        nights                 = v_nights - v_early_nights,
        checked_out_at         = NOW(),
        updated_at             = NOW()
    WHERE id = p_booking_room_id;

    UPDATE public.rooms
    SET    status = 'available', updated_at = NOW()
    WHERE  id = v_room_id;

  ELSIF p_status = 'cancelled' THEN

    UPDATE public.booking_rooms
    SET status       = 'cancelled'::public.booking_status,
        cancelled_at = NOW(),
        updated_at   = NOW()
    WHERE id = p_booking_room_id;

    UPDATE public.rooms
    SET    status = 'available', updated_at = NOW()
    WHERE  id = v_room_id;

  END IF;

  IF p_disbursement_method IS NOT NULL THEN

    IF p_disbursed_by IS NULL THEN
      RAISE EXCEPTION
        'p_disbursed_by is required when p_disbursement_method is provided.';
    END IF;

    IF p_disbursement_method NOT IN
       ('cash', 'bkash', 'nagad', 'bank_transfer', 'card') THEN
      RAISE EXCEPTION
        'Invalid disbursement method ''%''. '
        'Must be one of: cash, bkash, nagad, bank_transfer, card.',
        p_disbursement_method;
    END IF;

    IF p_refund_amount IS NULL OR p_refund_amount <= 0 THEN
      RAISE EXCEPTION
        'p_refund_amount must be > 0 when p_disbursement_method is provided.';
    END IF;

    IF p_status = 'cancelled' THEN
      v_estimated_new_total := v_current_total - (v_booking_rate * v_nights);
    ELSE
      v_estimated_new_total := v_current_total - v_deduction_amount;
    END IF;

    v_overpayment := v_paid_amount - GREATEST(0, v_estimated_new_total);

    IF v_overpayment > 0 AND p_refund_amount < v_overpayment THEN
      RAISE EXCEPTION
        'Atomic cancel+disburse requires refund amount (%) to be at least '
        'the overpayment % (paid_amount % − estimated new total %). '
        'Provide a larger refund amount or use the pending-refund path '
        'after manually disbursing the overpayment.',
        p_refund_amount,
        v_overpayment,
        v_paid_amount,
        v_estimated_new_total;
    END IF;

    IF p_refund_amount > v_overpayment THEN
      RAISE EXCEPTION
        'Refund amount % exceeds overpayment % '
        '(paid_amount % − estimated new total %). '
        'Cannot disburse more than the overpayment.',
        p_refund_amount,
        v_overpayment,
        v_paid_amount,
        v_estimated_new_total;
    END IF;

  END IF;

  IF p_refund_amount IS NOT NULL AND p_refund_amount > 0 THEN

    IF p_disbursement_method IS NOT NULL THEN

      INSERT INTO public.refunds (
        booking_id,
        booking_room_id,
        amount,
        reason,
        status,
        created_by,
        disbursed_at,
        disbursed_by,
        disbursement_method,
        notes
      ) VALUES (
        v_booking_id,
        p_booking_room_id,
        p_refund_amount,
        p_refund_reason,
        'disbursed',
        p_refund_created_by,
        NOW(),
        p_disbursed_by,
        p_disbursement_method,
        p_disbursement_notes
      )
      RETURNING id INTO v_refund_id;

      INSERT INTO public.payments (
        booking_id,
        amount,
        method,
        recorded_by,
        notes
      ) VALUES (
        v_booking_id,
        -p_refund_amount,
        p_disbursement_method::public.payment_method,
        p_disbursed_by,
        'Refund disbursement: ref ' || v_refund_id::TEXT
      );

    ELSE

      INSERT INTO public.refunds (
        booking_id,
        booking_room_id,
        amount,
        reason,
        created_by
      ) VALUES (
        v_booking_id,
        p_booking_room_id,
        p_refund_amount,
        p_refund_reason,
        p_refund_created_by
      )
      RETURNING id INTO v_refund_id;

    END IF;

  END IF;

  PERFORM public.update_booking_total(v_booking_id);

  IF p_status = 'checked_out_early' THEN
    PERFORM public.assert_checkout_allowed(v_booking_id, false, p_booking_room_id);
  END IF;

  SELECT
    CASE
      WHEN COUNT(*) = COUNT(*) FILTER (WHERE status = 'cancelled')
        THEN 'cancelled'::public.booking_status
      WHEN COUNT(*) FILTER (WHERE status = 'checked_in') > 0
        THEN 'checked_in'::public.booking_status
      WHEN COUNT(*) FILTER (WHERE status IN ('confirmed', 'checked_in')) = 0
        THEN CASE
               WHEN COUNT(*) FILTER (WHERE status = 'checked_out_early') > 0
                 THEN 'checked_out_early'::public.booking_status
               ELSE 'checked_out'::public.booking_status
             END
      ELSE  'confirmed'::public.booking_status
    END
  INTO v_derived_status
  FROM public.booking_rooms
  WHERE booking_id = v_booking_id;

  UPDATE public.bookings
  SET    status = v_derived_status
  WHERE  id     = v_booking_id
    AND  status IS DISTINCT FROM v_derived_status;

  RETURN v_refund_id;

END;
$function$;

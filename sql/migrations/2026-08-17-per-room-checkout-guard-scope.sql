-- =============================================================
-- 2026-08-17-per-room-checkout-guard-scope.sql
-- Per-room checkout guard: intermediate rooms pass, last room guarded.
--
-- RECORD OF LIVE STATE — applied in the Supabase SQL editor on
-- 2026-08-17. Committed for history; SQL below is VERBATIM the live
-- bodies of both functions.
--
-- WHY (BK-1373): a guest may move between rooms under ONE booking —
-- room 106 (14–17 Aug) then room 105 (17–19 Aug), ৳6,500 total with
-- ৳3,000 paid. Reception could not check out room 106 on the 17th
-- because assert_checkout_allowed saw the booking's ৳3,500 balance,
-- even though the guest stays (and settles) until the 19th. Staged
-- stays settle at FINAL departure.
--
-- WHAT CHANGED:
--   • assert_checkout_allowed gains p_booking_room_id uuid DEFAULT
--     NULL. When supplied AND other rooms on the booking are still
--     confirmed/checked_in (the room being checked out itself is
--     excluded via br.id <> p_booking_room_id), the guard RETURNS
--     early — the guest is still in-house and the balance remains
--     collectable. On the LAST active room the guard applies in full
--     — the protection that stopped MR. JAHIR's ৳8,500 walking out
--     (the BK-1168/BK-1169 class). Everything downstream (due
--     expression, override request, DELIBERATE fail-closed NULL
--     auth.uid()) is unchanged. The old two-argument overload was
--     DROPPED — one signature only, no stale overload callable.
--   • checkout_booking_room passes its own p_booking_room_id in the
--     PERFORM call (one line + comment); every other line is
--     byte-identical to the 2026-08-14/15 recording.
--   • checkout_booking is UNCHANGED and keeps calling with two
--     arguments — resolved against the new signature via the DEFAULT,
--     so booking-level checkout stays fully guarded (it is by
--     definition the final settlement of every room).
-- =============================================================

-- ─────────────────────────────────────────────────────────────
-- 1. The guard — third parameter + staged-stay early return
--    (the previous two-argument overload was dropped live before
--    this CREATE; recorded here as the sole surviving signature)
-- ─────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.assert_checkout_allowed(p_booking_id uuid, p_override boolean DEFAULT false, p_booking_room_id uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_due  NUMERIC;
  v_ref  TEXT;
  v_role TEXT;
  v_others INTEGER;
BEGIN
  -- Multi-room staged stays (BK-1373, 2026-08-17): a guest may move between
  -- rooms under one booking and settle at final departure. If other rooms
  -- remain active after this one, the guest is still in-house and the balance
  -- is still collectable — do not block. The guard applies on the LAST room.
  IF p_booking_room_id IS NOT NULL THEN
    SELECT count(*) INTO v_others
    FROM public.booking_rooms br
    WHERE br.booking_id = p_booking_id
      AND br.id <> p_booking_room_id
      AND br.status IN ('confirmed','checked_in');
    IF v_others > 0 THEN
      RETURN;
    END IF;
  END IF;

  SELECT b.booking_ref,
         COALESCE(b.total_amount,0)
           + COALESCE(b.extra_charge_amount,0)
           - COALESCE(b.additional_discount_amount,0)
           - COALESCE(b.paid_amount,0)
    INTO v_ref, v_due
  FROM public.bookings b WHERE b.id = p_booking_id;

  IF v_ref IS NULL THEN
    RAISE EXCEPTION 'Booking % not found', p_booking_id;
  END IF;

  IF v_due <= 0.01 THEN
    RETURN;
  END IF;

  IF NOT p_override THEN
    RAISE EXCEPTION
      'Cannot check out % — outstanding balance of %. Collect payment, or ask an admin to override.',
      v_ref, v_due;
  END IF;

  -- DELIBERATE fail-closed: NULL auth.uid() (service-role, SQL editor) raises.
  SELECT p.role INTO v_role FROM public.profiles p WHERE p.id = auth.uid();
  IF v_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION
      'Cannot check out % — outstanding balance of %. Only an admin may override.',
      v_ref, v_due;
  END IF;
END;
$function$;

-- ─────────────────────────────────────────────────────────────
-- 2. checkout_booking_room — PERFORM passes p_booking_room_id
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
  -- 1. Read the room row
  SELECT booking_id, room_id, status, check_out_date, booking_rate, nights
  INTO   v_booking_id, v_room_id, v_current_status, v_check_out_date, v_booking_rate, v_nights
  FROM   public.booking_rooms WHERE id = p_booking_room_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'booking_room % not found', p_booking_room_id; END IF;

  -- 2. Guard: only a checked-in room can be checked out
  IF v_current_status <> 'checked_in' THEN
    RAISE EXCEPTION 'Can only check out a room with status=checked_in. Current status: %', v_current_status;
  END IF;

  -- Balance guard — after the row read (1) and status guard (2), BEFORE any
  -- UPDATE. Passing p_booking_room_id (2026-08-17): when OTHER rooms on the
  -- booking are still confirmed/checked_in the guard returns early — a guest
  -- moving between rooms on one booking settles at FINAL departure, so an
  -- intermediate room checkout must not be blocked by the booking's balance
  -- (BK-1373: room 106 out on the 17th, guest in 105 until the 19th). On the
  -- LAST active room the guard applies in full — which is what stopped
  -- MR. JAHIR's ৳8,500 walking out (BK-1168/BK-1169 class).
  PERFORM public.assert_checkout_allowed(v_booking_id, p_override, p_booking_room_id);

  -- 3. Compute floored early nights server-side (same expression as checkout_booking)
  v_actual := COALESCE(p_actual_checkout_date, v_check_out_date);
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

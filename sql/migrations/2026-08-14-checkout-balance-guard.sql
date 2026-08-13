-- =============================================================
-- 2026-08-14-checkout-balance-guard.sql
-- Server-side outstanding-balance guard on checkout.
--
-- APPLY LIVE FIRST in the Supabase SQL editor, then this file is the
-- committed record. Until applied, the live checkout functions carry
-- no balance enforcement (client-only guard).
--
-- WHY:
--   The balance gate lived only in two React handlers. Two unguarded
--   paths produced real losses:
--     • per-room checkout (checkout_booking_room) had NO balance check
--       anywhere — BK-1168/BK-1169 checked out unpaid (৳2,500);
--     • the "More Discount" field let staff zero finalPayable BEFORE
--       the client guard evaluated — nine write-offs, ৳33,900.
--   This migration makes the DATABASE the enforcement point:
--   assert_checkout_allowed() raises unless the booking is settled or
--   an admin explicitly overrides.
--
-- DUE EXPRESSION (deliberate — read before "fixing"):
--   due = total_amount + extra_charge_amount
--         − additional_discount_amount − paid_amount
--   early_deduction_amount is deliberately NOT subtracted:
--   update_booking_total already recomputes total_amount from the
--   remaining room-nights, so subtracting the deduction again would
--   DOUBLE-COUNT it and understate the debt. An earlier draft of this
--   guard made exactly that mistake and passed silently on a booking
--   with ৳1,500 outstanding.
--
-- GUARD PLACEMENT (deliberate — do not move):
--   • checkout_booking: the PERFORM runs BEFORE step 3.6 writes
--     additional_discount_*. The guard therefore sees the balance as
--     it stood before this checkout's discount — a staff member
--     entering a full-total discount can no longer zero the balance
--     ahead of the check; with money outstanding, p_override = true
--     from an admin is the only way through.
--   • checkout_booking_room: the PERFORM runs after step 1 (reads
--     v_booking_id) and step 2 (checked_in status guard), BEFORE any
--     UPDATE.
--
-- FAIL-CLOSED (deliberate): when auth.uid() IS NULL (service-role
--   calls, SQL editor) the profiles lookup yields NULL and
--   IS DISTINCT FROM 'admin' raises. Do NOT copy the rev-23 trigger's
--   service-role exemption here — a guard against unpaid checkouts
--   must not have a silent bypass. Consequence: manual corrections on
--   bookings with an outstanding balance must use direct table
--   UPDATEs, not these RPCs.
--
-- SECURITY DEFINER + auth.uid(): resolves the CALLER's JWT (GUCs are
--   request-scoped; DEFINER changes only the privilege role) — the
--   same pattern as the live fn_enforce_override_is_admin (rev 23)
--   and is_admin() (rev 25). auth.uid() is recorded BARE (unqualified)
--   and none of the three functions sets search_path — this works via
--   the default path and is recorded as-is. SUGGESTED FOLLOW-UP (not
--   done here): schema-qualify auth.uid() and/or add SET search_path
--   as hardening.
--
-- SIGNATURE CHANGE: p_override boolean DEFAULT false is APPENDED to
--   both checkout functions. CREATE OR REPLACE with a new parameter
--   would create a second overload and leave the old, unguarded
--   function callable — so the old signatures are DROPped first.
--   EXECUTE is re-granted to authenticated afterwards. Existing
--   client calls omit p_override and get false (fail-closed) — the
--   TS admin-override wrapper must be updated to pass
--   p_override: true (separate code change).
--
-- assert_checkout_allowed is recorded VERBATIM as applied live except
-- for one inserted comment above the role check (announced), marking
-- the fail-closed NULL behaviour as deliberate.
-- =============================================================

-- ─────────────────────────────────────────────────────────────
-- 1. The guard
-- ─────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.assert_checkout_allowed(p_booking_id uuid, p_override boolean DEFAULT false)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_due  NUMERIC;
  v_ref  TEXT;
  v_role TEXT;
BEGIN
  -- Charges still live: rooms not cancelled, minus deductions already applied.
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
  -- DELIBERATE fail-closed: when auth.uid() IS NULL (service-role call,
  -- SQL editor) no profiles row matches, v_role is NULL, and
  -- IS DISTINCT FROM 'admin' raises. A guard against unpaid checkouts
  -- must not have a silent bypass — do NOT add a NULL exemption.
  SELECT p.role INTO v_role FROM public.profiles p WHERE p.id = auth.uid();
  IF v_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION
      'Cannot check out % — outstanding balance of %. Only an admin may override.',
      v_ref, v_due;
  END IF;
END;
$function$;

-- ─────────────────────────────────────────────────────────────
-- 2. checkout_booking — old signature dropped (a new parameter
--    would otherwise create a second, unguarded overload)
-- ─────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.checkout_booking(uuid, date, numeric, text, uuid);

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

  -- ── Balance guard — MUST run BEFORE step 3.6 writes the discount ─────────
  -- The guard reads additional_discount_amount as it stood BEFORE this
  -- checkout, so p_additional_discount_amount cannot zero the balance ahead
  -- of the check. This closes the staff full-total-discount loophole (nine
  -- write-offs, ৳33,900): with money outstanding, p_override = true from an
  -- admin is the only way through. Do NOT move this below 3.6.
  PERFORM public.assert_checkout_allowed(p_booking_id, p_override);

  -- ── 3.6. Write additional_discount_* columns ─────────────────────────────
  IF p_additional_discount_amount > 0 THEN
    UPDATE public.bookings
    SET    additional_discount_amount = p_additional_discount_amount,
           additional_discount_reason = p_additional_discount_reason,
           additional_discount_by     = p_additional_discount_by,
           additional_discount_at     = NOW()
    WHERE  id = p_booking_id;
  END IF;

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
-- 3. checkout_booking_room — old signature dropped (same overload
--    hazard as above)
-- ─────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.checkout_booking_room(uuid, date, integer, numeric);

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
  -- UPDATE. Per-room checkout previously carried NO balance check at all
  -- (BK-1168/BK-1169 checked out unpaid through this path).
  PERFORM public.assert_checkout_allowed(v_booking_id, p_override);

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

-- ─────────────────────────────────────────────────────────────
-- 4. Grants — DROP removed the old functions' ACLs; restore
--    client execute on the two RPCs. assert_checkout_allowed needs
--    no client grant (invoked inside the DEFINER functions), but
--    default PostgreSQL function ACLs may allow it anyway; it is
--    safe either way (returns void or raises).
-- ─────────────────────────────────────────────────────────────

GRANT EXECUTE ON FUNCTION public.checkout_booking(uuid, date, numeric, text, uuid, boolean)      TO authenticated;
GRANT EXECUTE ON FUNCTION public.checkout_booking_room(uuid, date, integer, numeric, boolean)    TO authenticated;

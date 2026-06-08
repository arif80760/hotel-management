-- 2026-06-08 — update_booking_total: total_amount = rooms subtotal ONLY
--
-- WHY:
--   Fixes a latent payment-status double-count. The function previously set
--     total_amount = (sum of active booking_rooms) + (sum of booking_extra_charges)
--   i.e. it folded the *itemized* extra charges into total_amount. But the
--   owed/payment-status calculations elsewhere add the *scalar* column
--   bookings.extra_charge_amount on top of total_amount:
--     • fn_sync_payment_status:  paid >= total_amount + extra_charge_amount - additional_discount_amount
--     • calcTrueDue (UI):        total + extra_charge_amount - additional_discount - paid
--     • recordPayment (service): same formula
--     • checkout_booking:        rooms + extra_charge_amount - discount  (overpayment check)
--   checkoutNormal / checkoutWithOverride write BOTH the scalar AND an itemized
--   booking_extra_charges row for the same charge. They net out today only because
--   the itemized row is inserted AFTER the checkout RPC's update_booking_total runs,
--   so total stays rooms-only. But the moment update_booking_total re-runs on such a
--   booking (e.g. via add_room_to_booking), the itemized extra lands in total_amount
--   while the scalar is still added on top:
--     owed = (rooms + itemized) + scalar - discount   ← extra double-counted
--   silently flipping a fully-paid booking to "partial".
--
-- FIX:
--   total_amount is now rooms-only, matching every other money calculation. The
--   scalar bookings.extra_charge_amount remains the single financial source for
--   extras (the codebase's stated design intent); booking_extra_charges stays
--   display-only.
--
-- DATA STATE AT FIX TIME (diagnosed, not changed):
--   • 13 bookings carry an extra charge (scalar + itemized). Each had total_amount
--     = rooms-only, so the extra was counted once — NOT double-counted yet, but each
--     was one update_booking_total re-run away from flipping. The fix defuses all 13.
--   • No backfill performed: no booking was inflated (total_amount = rooms for every
--     extra-carrying booking). Purely preventive.
--   • 3 unrelated test bookings (BK-1033/1042/1060) have total_amount that doesn't
--     match their room lines and isn't explained by any discount/extra column —
--     inconsistent test data, deliberately left untouched.
--
-- VERIFIED:
--   • pg_get_functiondef confirmed the deployed definition.
--   • A self-rolling-back DO block simulated a checkout extra (scalar + itemized)
--     and confirmed update_booking_total leaves total = rooms-only (no fold-in),
--     then rolled itself back leaving no residue.

CREATE OR REPLACE FUNCTION public.update_booking_total(p_booking_id uuid)
 RETURNS numeric
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_rooms_total NUMERIC;
BEGIN
  -- Sum active room charges only (cancelled rooms contribute 0).
  SELECT COALESCE(SUM(nights * booking_rate), 0) INTO v_rooms_total
  FROM public.booking_rooms
  WHERE booking_id = p_booking_id
    AND status <> 'cancelled';

  -- total_amount = rooms subtotal ONLY. Extra charges are carried by the
  -- scalar bookings.extra_charge_amount and added to "owed" downstream by
  -- fn_sync_payment_status / calcTrueDue / recordPayment. Folding the itemized
  -- booking_extra_charges in here double-counted the extra. Removed.
  UPDATE public.bookings
  SET total_amount = v_rooms_total
  WHERE id = p_booking_id;

  RETURN v_rooms_total;
END;
$function$;

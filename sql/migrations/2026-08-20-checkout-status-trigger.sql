-- =============================================================
-- 2026-08-20-checkout-status-trigger.sql
-- trg_guard_checkout_status — invariant backstop on bookings.status.
--
-- APPLY ORDER (honoured): applied ONLY AFTER the checkoutWithOverride
-- reorder (override fields persisted BEFORE the RPC, commit 5eab531)
-- deployed on Vercel — before that deploy, admin overrides with a due
-- would have been blocked (the old client stamped override_checkout
-- only after the status flip).
--
-- RECORD OF LIVE STATE — applied in the Supabase SQL editor on
-- 2026-08-20 post-deploy. Probe verified same day: ROLLBACK-wrapped
-- bare UPDATE on due-carrying BK-1331 failed with "Cannot check out
-- BK-1331: outstanding balance 22500.00 — admin override required."
-- (fn_guard_checkout_status line 11); tgenabled='O'.
--
-- WHY (BK-1425, door 4 of the checkout-route inventory): RLS allows
-- authenticated UPDATE on bookings/booking_rooms status, so a bare
-- status write could bypass every RPC guard. This trigger enforces
-- the BUSINESS INVARIANT rather than provenance: an active booking
-- (confirmed/checked_in) may transition to checked_out /
-- checked_out_early only when true due ≤ 0 OR override_checkout is
-- already true. It would have caught BK-1425 (cancel_booking_room's
-- re-sync runs after update_booking_total → due ৳2000, no override
-- → raise, whole transaction rolled back).
--
-- DESIGN DECISIONS (Arif, 2026-08-20):
--   • NO is_admin() bypass — an admin bare-update walkout with no
--     recorded reason would be weaker than the override mechanism it
--     stands in for. override_checkout is the ONLY bypass; the flip
--     itself is validated by trg_enforce_override_is_admin (rev 23),
--     and checkoutWithOverride now persists it BEFORE the RPC (a
--     stale stamp on a failed RPC is visible and true — accepted).
--   • Trigger on BOOKINGS only, deliberately NOT booking_rooms:
--     room rows flip at checkout_booking step 2, BEFORE the 3.6
--     discount write — a room-level trigger would re-introduce the
--     pre-3.6 ordering problem reversed on 2026-08-15. The bookings
--     flip happens at step 5, after discount + guard +
--     update_booking_total, so the row the trigger sees carries
--     final figures. Staged-stay intermediate room checkouts never
--     flip the booking → semantics preserved for free.
--   • True-due formula = the canonical one (early deduction is
--     inside total_amount; never subtracted again).
--   • Service-role / SQL-editor corrections with a due: set
--     override_checkout first, or DISABLE TRIGGER inside an explicit
--     transaction — see the runbook in CLAUDE.md.
-- =============================================================

CREATE OR REPLACE FUNCTION public.fn_guard_checkout_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_due numeric;
BEGIN
  IF NEW.status IN ('checked_out', 'checked_out_early')
     AND OLD.status IN ('confirmed', 'checked_in') THEN
    v_due := COALESCE(NEW.total_amount, 0) + COALESCE(NEW.extra_charge_amount, 0)
           - COALESCE(NEW.additional_discount_amount, 0) - COALESCE(NEW.paid_amount, 0);
    IF v_due > 0.009 AND NOT COALESCE(NEW.override_checkout, false) THEN
      RAISE EXCEPTION
        'Cannot check out %: outstanding balance % — admin override required.',
        NEW.booking_ref, v_due;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER trg_guard_checkout_status
  BEFORE UPDATE OF status ON public.bookings
  FOR EACH ROW EXECUTE FUNCTION public.fn_guard_checkout_status();

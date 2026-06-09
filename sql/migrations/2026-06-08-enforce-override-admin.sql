-- 2026-06-08 — Server-side admin enforcement for the checkout override
--
-- WHY:
--   The checkout override (bookings.override_checkout = true) was gated only in
--   the browser. RLS is enabled on bookings, but the UPDATE policy is
--   "Authenticated can update bookings" with qual/with_check = true — i.e. ANY
--   authenticated user (staff or admin) could set override_checkout = true by
--   talking to the API directly. The override is written by a client-side
--   UPDATE in checkoutWithOverride, so nothing on the server enforced "admin".
--
-- WHAT:
--   A BEFORE trigger that fires only when override_checkout transitions to true.
--   It resolves the caller's role via auth.uid() -> profiles.role and rejects
--   the override unless they are 'admin'. It also stamps override_by/override_at
--   from auth.uid() itself, so the audit trail records who actually performed the
--   override rather than trusting a client-supplied value.
--
--   A trigger (not RLS) is used deliberately: RLS WITH CHECK can only evaluate the
--   resulting row, which would wrongly block any later update to an
--   already-overridden booking (e.g. recording a payment) by a non-admin. The
--   trigger checks the off->on TRANSITION, so only the act of overriding is gated.
--
--   Service-role / SQL-editor / migration contexts have no user token
--   (auth.uid() IS NULL) and are already privileged, so they are not subject to
--   the app-role check — migrations and admin SQL are not blocked.
--
-- SCOPE: this locks down the override only. The broad "any authenticated user can
--   update/delete any booking" RLS posture is a separate, larger hardening task.
--
-- VERIFIED: a self-rolling-back test simulated a non-admin token (blocked) and an
--   admin token (allowed, override_by stamped), leaving no residue.

DROP TRIGGER IF EXISTS trg_enforce_override_is_admin ON public.bookings;

CREATE OR REPLACE FUNCTION public.fn_enforce_override_is_admin()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public
AS $function$
DECLARE
  v_uid  uuid := auth.uid();
  v_role text;
BEGIN
  -- Only police the transition that turns the override ON.
  IF NEW.override_checkout IS TRUE
     AND (TG_OP = 'INSERT' OR OLD.override_checkout IS DISTINCT FROM TRUE) THEN

    -- auth.uid() is NULL for service-role / SQL editor / migrations — already
    -- privileged contexts, so they aren't subject to the app-role check.
    IF v_uid IS NOT NULL THEN
      SELECT role INTO v_role FROM public.profiles WHERE id = v_uid;

      IF v_role IS DISTINCT FROM 'admin' THEN
        RAISE EXCEPTION
          'Checkout override requires an admin account (your role: %).',
          COALESCE(v_role, 'unknown')
          USING ERRCODE = 'check_violation';
      END IF;

      -- Authoritative audit trail — don't trust client-supplied values.
      NEW.override_by := v_uid;
      IF NEW.override_at IS NULL THEN
        NEW.override_at := NOW();
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE TRIGGER trg_enforce_override_is_admin
  BEFORE INSERT OR UPDATE OF override_checkout ON public.bookings
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_enforce_override_is_admin();

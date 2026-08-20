-- =============================================================
-- 2026-08-20-deny-refund-zero-row-guard.sql
-- deny_refund: raise on zero-row UPDATE instead of silent success.
--
-- RECORD OF LIVE STATE — applied in the Supabase SQL editor on
-- 2026-08-20. Body is byte-identical to the live body pulled via
-- pg_get_functiondef the same day, PLUS the IF NOT FOUND guard
-- after the UPDATE.
--
-- WHY: deny_refund is SECURITY INVOKER. Under the admin-only
-- refunds UPDATE policy (2026-08-20-rls-hardening.sql) a staff call
-- passed the pre-read (SELECT stayed open), then the UPDATE matched
-- ZERO rows and the function returned SUCCESS — a silent no-op.
-- Third instance of the RLS-silent-write class (see the
-- "RLS-blocked writes report SUCCESS" rule in CLAUDE.md); this is
-- the reference implementation of the row-count check.
--
-- Kept SECURITY INVOKER deliberately (the "tighten" decision):
-- refund decisions are admin actions; the UI gates both Deny and
-- Mark Disbursed behind isAdmin, the DB policy is the boundary for
-- deny, and this guard makes any future bypass loud instead of
-- silent. disburse_refund keeps its live-only SECURITY DEFINER flag
-- unchanged (probably the deliberate fix for May issue #19).
-- =============================================================

CREATE OR REPLACE FUNCTION public.deny_refund(p_refund_id uuid, p_reason text, p_denied_by uuid)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_status TEXT;
BEGIN

  -- ── 1. Read and validate ──────────────────────────────────────────────
  SELECT status INTO v_status
  FROM   public.refunds
  WHERE  id = p_refund_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'refund % not found', p_refund_id;
  END IF;

  IF v_status <> 'pending' THEN
    RAISE EXCEPTION
      'Cannot deny refund % — current status is %. '
      'Only pending refunds can be denied.',
      p_refund_id, v_status;
  END IF;

  -- ── 2. Mark as denied; persist operator reason ───────────────────────
  -- NULLIF(TRIM(p_reason), '') → stores NULL when operator leaves the
  -- reason field blank; no placeholder text pollutes the column.
  -- notes is intentionally omitted: leave whatever value it had before.
  UPDATE public.refunds
  SET    status = 'denied',
         reason = NULLIF(TRIM(p_reason), '')
  WHERE  id = p_refund_id;

  -- ── 3. Zero-row guard (2026-08-20) — RLS filters, it doesn't reject:
  --      a blocked write "succeeds" with zero rows. Never let that
  --      report success. ──
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'deny_refund: UPDATE affected zero rows for refund % — the row exists but the write was blocked (refund updates are admin-only). No change was made.',
      p_refund_id;
  END IF;

END;
$function$;

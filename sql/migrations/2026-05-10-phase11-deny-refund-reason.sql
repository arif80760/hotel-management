-- ===========================================================================
-- Phase 11 item #2: persist user-typed reason on refund denial
-- File:    sql/migrations/2026-05-10-phase11-deny-refund-reason.sql
-- Date:    2026-05-10
-- Apply:   After 2026-05-09-phase8.5-refund-disbursement.sql
--
-- Problem:
--   deny_refund was writing p_reason to the notes column
--   (CONCAT(notes, ' / DENIED: ', p_reason)), silently dropping the
--   operator's typed reason text and polluting notes with a hardcoded
--   prefix. The dedicated refunds.reason column was left NULL on every
--   denied refund.
--
-- Fix:
--   Write p_reason to refunds.reason (NULLIF(TRIM(p_reason), '') so
--   that empty/whitespace input stores NULL rather than a blank string).
--   Leave the notes column entirely untouched.
--
-- Signature is unchanged:  (p_refund_id UUID, p_reason TEXT, p_denied_by UUID)
-- No DROP required — CREATE OR REPLACE updates the body in place without
-- creating a new overload.
-- ===========================================================================


CREATE OR REPLACE FUNCTION public.deny_refund(
  p_refund_id UUID,
  p_reason    TEXT,
  p_denied_by UUID
) RETURNS VOID
LANGUAGE plpgsql AS $$
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

END;
$$;

COMMENT ON FUNCTION public.deny_refund IS
  'Marks a pending refund as denied. Stores the operator-supplied reason '
  'in refunds.reason (NULL when blank). notes column is not modified. '
  'No payment row inserted, no paid_amount change. '
  'p_denied_by is reserved for future audit columns (denied_at / denied_by).';


-- ===========================================================================
-- GRANTS (re-applied; idempotent)
-- ===========================================================================

GRANT EXECUTE ON FUNCTION public.deny_refund TO authenticated;


-- ===========================================================================
-- VERIFICATION
-- ===========================================================================

-- Expect exactly one row: deny_refund | p_refund_id uuid, p_reason text, p_denied_by uuid | void
SELECT
  p.proname                                                     AS function_name,
  pg_catalog.pg_get_function_identity_arguments(p.oid)         AS arguments,
  pg_catalog.pg_get_function_result(p.oid)                     AS return_type
FROM pg_catalog.pg_proc     p
JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname   = 'public'
  AND p.proname   = 'deny_refund';

-- ===========================================================================
-- END OF MIGRATION
-- ===========================================================================

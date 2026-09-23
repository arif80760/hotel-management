-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-09-24 — deny_refund: disallow denying pre_adjusted (auto-overpayment)
-- refunds. RECORD OF LIVE STATE — applied by Arif in the Supabase SQL editor
-- on 2026-09-24 and probe-verified the same day.
--
-- Incident BK-1820 (finding 3): checkout_booking's step 3.5 creates an
-- auto-refund for an overpaid checkout AND simultaneously writes the paired
-- NEGATIVE payment (pre_adjusted = true, linked via payments.refund_id) —
-- the books return the money at refund CREATION, not disbursement, because
-- chk_paid_not_exceed_total forbids a "hotel keeps the overpayment" state.
-- Denying such a refund therefore left the negative payment in force: the
-- ledger claimed ৳800 left the drawer that never physically did (phantom
-- cash outflow, drawer over books by the refund amount).
--
-- Design decision (option ii — disallow, NOT literal reversal): a deny that
-- simply reversed the negative payment would raise paid_amount back above
-- total + extra_charge − discount and violate chk_paid_not_exceed_total on
-- its own. The only constraint-legal exits are (a) disburse the refund
-- (money physically returned) or (b) keep the money by recording an extra
-- charge of the same amount with a reason — the exception text tells the
-- operator exactly that. Plain (non-pre_adjusted) refunds deny as before.
--
-- Also: the UPDATE now has a row-count guard (RLS-silent-write rule — an
-- RLS-blocked UPDATE reports success with 0 rows). The 2026-08-20 zero-row
-- guard covered the SELECT path; this covers the UPDATE itself.
--
-- SECURITY INVOKER kept (UI gates refund decisions admin-only).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.deny_refund(p_refund_id uuid, p_reason text, p_denied_by uuid)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_status TEXT;
  v_pre_adjusted BOOLEAN;
  v_amount NUMERIC;
BEGIN

  -- ── 1. Read and validate ──────────────────────────────────────────────
  SELECT status, pre_adjusted, amount
  INTO   v_status, v_pre_adjusted, v_amount
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

  -- ── 2. BK-1820: a pre_adjusted refund's money has ALREADY left the
  --       books (negative payment written at creation) — deny is illegal.
  IF v_pre_adjusted THEN
    RAISE EXCEPTION
      'Cannot deny refund % — it is an auto-refund from overpayment: the books already '
      'returned ৳% as a negative payment. Denying would leave the ledger claiming money '
      'left that never did. Either disburse the refund, or keep the money by recording '
      'an extra charge of ৳% with a reason.',
      p_refund_id, v_amount, v_amount;
  END IF;

  -- ── 3. Mark as denied; persist operator reason ───────────────────────
  -- NULLIF(TRIM(p_reason), '') → stores NULL when operator leaves the
  -- reason field blank; no placeholder text pollutes the column.
  -- notes is intentionally omitted: leave whatever value it had before.
  UPDATE public.refunds
  SET    status = 'denied',
         reason = NULLIF(TRIM(p_reason), '')
  WHERE  id = p_refund_id;

  -- RLS-silent-write guard: a blocked UPDATE "succeeds" with zero rows.
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'deny_refund: UPDATE affected zero rows for % — RLS block or concurrent change.',
      p_refund_id;
  END IF;

END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Verification (both run 2026-09-24):
--
-- 1. Deny-guard probe: BEGIN; flip BK-1820's refund (8d9eaed9-…) back to
--    'pending'; call deny_refund → raised 'Cannot deny refund … auto-refund
--    from overpayment …' as designed; ROLLBACK.
--
-- 2. BK-1820 regression probe (ROLLBACK-wrapped replay of the incident's
--    shape): synthetic booking, room span [Dhaka-yesterday, Dhaka-tomorrow)
--    at ৳1,200 ×2 nights (post-extension), extra_charge ৳1,200 persisted
--    BEFORE the RPC (the waived deduction, exactly as the fixed client
--    writes it), payment ৳2,000, then checkout_booking(actual = Dhaka-today,
--    p_additional_discount_amount = 400). Asserted: ZERO refund rows created
--    and effective total (total + extra − discount) = ৳2,000 = paid,
--    status checked_out(_early). PASSED — the auto-refund no longer fires
--    when the in-modal extra charge and discount settle the bill.
--
-- Client half (same batch, services/bookingsService.ts + both checkout
-- modals): extra_charge_* persisted pre-RPC (checkoutNormal Step 0.6;
-- folded into checkoutWithOverride Step 0.5), "charge the unused night(s)"
-- toggle with mandatory reason, FD discount validator unified to the
-- billable-total rule.
--
-- BK-1820 data correction (one-off, applied 2026-09-24, variant B):
-- extra_charge +1,200 (extension night, deduction waived), payment +800
-- cash (deny reversal — money never returned), additional_discount 400
-- (agreed extension price ৳8,000). Drawer and books now agree.
-- ─────────────────────────────────────────────────────────────────────────────

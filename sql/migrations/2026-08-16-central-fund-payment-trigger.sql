-- =============================================================
-- 2026-08-16-central-fund-payment-trigger.sql
-- Central fund: every payment-driven daybook row uses Cash in Hand.
--
-- RECORD OF LIVE STATE — applied and verified in the Supabase SQL
-- editor on 2026-08-16 (central_fund_applied = true,
-- still_has_hardcoded_uuid = false). Committed for history; SQL below
-- is VERBATIM the live body.
--
-- DECISION (Arif + GM, 2026-08-16): Cash in Hand is the single
-- central fund. Every revenue receipt — cash, bKash, card, Nagad,
-- Revenue Management, any source — credits Cash in Hand. payment
-- method stays on the payment row as DESCRIPTIVE information only; it
-- no longer determines the account. Movements to Bank/bKash/Nagad or
-- director accounts are explicit transfers made separately. The
-- companion client change (Revenue Management's fixed "Received in"
-- line) shipped as 18b06fc; this trigger covers the booking/checkout
-- payment path, which was the only other revenue_in writer.
--
-- WHAT CHANGED vs the previous live body (recorded 2026-05-23, later
-- amended live for disbursement-moment timestamps):
--   • The two CASE NEW.method → hardcoded-UUID blocks are GONE. One
--     lookup resolves the central fund from the accounts table
--     (is_spendable = true) — never by hardcoded id/name — and feeds
--     all three money branches: revenue_in credits it; the refund
--     disbursement (UPDATE branch) and negative-payment (INSERT ELSE
--     branch) expense_out rows debit it.
--   • Method validation is preserved as explicit whitelists with the
--     original fail-loud messages — a new payment_method enum value
--     must still be a conscious decision here.
--   • Everything else (DELETE branch, refund-id skips, disbursement-
--     moment timestamps, amounts, attribution) is byte-identical.
--
-- HISTORICAL-REFUND ARTIFACT (stated here so it is discovered by
-- reading, not by reconciling): a refund disbursed after this change
-- against a PRE-changeover payment whose revenue landed in Bank or
-- bKash will debit Cash in Hand while the original credit stays in
-- the Bank/bKash balance — the two accounts are misstated in opposite
-- directions by the refund amount, hotel-total money stays correct,
-- and the guest is unaffected. One-off changeover artifact, only for
-- refunds on old payments; the clean-up if it occurs is a matching
-- explicit transfer (Bank → Cash in Hand). New-model payments refund
-- symmetrically (in via Cash, out via Cash), so it cannot recur.
--
-- NOTE: existing balances do not move — this trigger fires only on
-- new payment events. Bank/bKash/Nagad now change only via explicit
-- transfers and the guarded remuneration source-account drawdowns.
-- =============================================================

CREATE OR REPLACE FUNCTION public.fn_sync_account_transactions()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_bucket_id UUID;
BEGIN

  -- ── DELETE branch ─────────────────────────────────────────
  IF TG_OP = 'DELETE' THEN
    DELETE FROM public.account_transactions
    WHERE booking_payment_id = OLD.id;
    RETURN OLD;
  END IF;

  -- ── CENTRAL FUND (2026-08-16, Arif + GM) ──────────────────
  -- Every payment-driven daybook row now uses Cash in Hand — the single
  -- central fund — on BOTH sides: revenue_in credits it, refund/negative
  -- expense_out rows debit it. payment.method is descriptive only and no
  -- longer determines the account. Resolved from the accounts table
  -- (is_spendable = true), never by hardcoded id/name. Movements to
  -- Bank/bKash/Nagad are explicit transfers made separately.
  SELECT id INTO v_bucket_id
  FROM   public.accounts
  WHERE  is_spendable
  LIMIT  1;

  IF v_bucket_id IS NULL THEN
    RAISE EXCEPTION
      'fn_sync_account_transactions: no spendable (central fund) account found in public.accounts.';
  END IF;

  -- ── UPDATE branch ─────────────────────────────────────────
  -- The only intended UPDATE path is disburse_refund Path A: a pending
  -- pre-adjustment payment row gets its method flipped from 'other' to
  -- the actual disbursement method (cash/bkash/nagad/bank_transfer/card).
  -- At this moment money has physically moved, so the daybook row is born.
  --
  -- The daybook row's txn_date and created_at reflect the disbursement
  -- moment (current_date, now()), NOT the original pre-adjustment's
  -- created_at — the pre-adjustment was an accounting placeholder, the
  -- disbursement is the real cash event.
  --
  -- CENTRAL FUND: the refund is paid FROM Cash in Hand regardless of
  -- method — revenue no longer feeds Bank/bKash/Nagad, so a card refund
  -- drawing from Bank would overdraw an account that never receives.
  --
  -- Any other UPDATE is ignored — we don't currently have such paths in
  -- the codebase, but the guard keeps us safe if one is added later.
  IF TG_OP = 'UPDATE' THEN
    IF OLD.method = 'other'
       AND NEW.method <> 'other'
       AND NEW.refund_id IS NOT NULL
    THEN
      -- Method whitelist preserved as a fail-loud guard (was implicit in
      -- the old CASE mapping).
      IF NEW.method NOT IN ('cash', 'bkash', 'nagad', 'bank_transfer', 'card') THEN
        RAISE EXCEPTION
          'fn_sync_account_transactions UPDATE branch: unmapped method %. '
          'disburse_refund should only set method to cash/bkash/nagad/bank_transfer/card.',
          NEW.method;
      END IF;

      -- account_transactions.amount is positive-only; the pre-adjustment
      -- was a negative payment so we write an expense_out with ABS(amount).
      -- txn_date and created_at = disbursement moment (NOT NEW.created_at,
      -- which is the original pre-adjustment timestamp).
      INSERT INTO public.account_transactions (
        txn_date, type, amount,
        from_account_id, to_account_id,
        booking_payment_id, note, created_by, created_at
      ) VALUES (
        current_date,                  -- was: NEW.created_at::date
        'expense_out',
        ABS(NEW.amount),
        v_bucket_id,
        NULL,
        NEW.id,
        NEW.notes,
        NEW.recorded_by,
        now()                          -- was: NEW.created_at
      );
    END IF;
    RETURN NEW;
  END IF;

  -- ── INSERT branch ─────────────────────────────────────────
  -- For fresh INSERTs, NEW.created_at IS today (the payment is being
  -- recorded right now), so NEW.created_at::date == current_date.

  IF NEW.refund_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- Method whitelist preserved as a fail-loud guard (was implicit in the
  -- old CASE mapping): a new payment_method enum value must still be a
  -- conscious decision here even though it no longer picks the account.
  IF NEW.method NOT IN ('cash', 'bkash', 'nagad', 'bank_transfer', 'card', 'online', 'other') THEN
    RAISE EXCEPTION
      'fn_sync_account_transactions INSERT branch: unmapped payment method %. '
      'A new payment_method enum value was added without updating this trigger.',
      NEW.method;
  END IF;

  IF NEW.amount > 0 THEN
    INSERT INTO public.account_transactions (
      txn_date, type, amount,
      from_account_id, to_account_id,
      booking_payment_id, note, created_by, created_at
    ) VALUES (
      NEW.created_at::date,
      'revenue_in',
      NEW.amount,
      NULL,
      v_bucket_id,
      NEW.id,
      NEW.notes,
      NEW.recorded_by,
      NEW.created_at
    );
  ELSE
    -- Negative payment without refund_id (direct refund-shaped outflow):
    -- CENTRAL FUND — also paid from Cash in Hand, same rationale as the
    -- UPDATE branch.
    INSERT INTO public.account_transactions (
      txn_date, type, amount,
      from_account_id, to_account_id,
      booking_payment_id, note, created_by, created_at
    ) VALUES (
      NEW.created_at::date,
      'expense_out',
      ABS(NEW.amount),
      v_bucket_id,
      NULL,
      NEW.id,
      NEW.notes,
      NEW.recorded_by,
      NEW.created_at
    );
  END IF;

  RETURN NEW;
END;
$function$;

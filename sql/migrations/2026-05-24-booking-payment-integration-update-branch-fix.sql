-- sql/migrations/2026-05-24-booking-payment-integration-update-branch-fix.sql
-- Amendment to fn_sync_account_transactions UPDATE branch:
--   set txn_date and created_at to the disbursement moment (now()),
--   not to the pre-adjustment payment's original created_at.
--
-- ─── STATUS ───────────────────────────────────────────────────
-- APPLIED 2026-05-24 (Day 19) — production fn_sync_account_transactions
-- swapped to disbursement-dated daybook rows. Verified via pg_get_functiondef.
-- ──────────────────────────────────────────────────────────────
--
-- Why this exists:
--   When the Day 19 day-close immutability trigger was designed, we
--   discovered an interaction with the booking-payment integration:
--   the UPDATE branch of fn_sync_account_transactions inserts a daybook
--   row using the ORIGINAL payment record's created_at (which can be
--   weeks or months old, since pre-adjustments persist as 'other'-method
--   payments until disbursement).
--
--   If any day-close exists with close_date >= the pre-adjustment's
--   original created_at, the immutability trigger would reject this
--   INSERT, aborting the entire disburse_refund transaction with an
--   opaque error to the user.
--
--   This is wrong on its own merits, independent of day-close. The
--   trigger's own comment says: "At this moment money has physically
--   moved, so the daybook row is born." The daybook row represents the
--   disbursement event, not the pre-adjustment. txn_date and created_at
--   should reflect *when the disbursement happened*, not when the
--   placeholder pre-adjustment row was first inserted.
--
-- What changes:
--   In the UPDATE branch's INSERT, two columns swap their source:
--     txn_date    NEW.created_at::date  →  current_date
--     created_at  NEW.created_at        →  now()
--   No other path changes. INSERT branch keeps NEW.created_at::date
--   because for fresh payment inserts, that already IS today (the
--   payment is being recorded right now).
--
-- Re-running on production is safe: CREATE OR REPLACE FUNCTION means
-- no duplication, just body replacement.
-- =============================================================


CREATE OR REPLACE FUNCTION public.fn_sync_account_transactions()
RETURNS TRIGGER AS $$
DECLARE
  v_bucket_id UUID;
BEGIN

  -- ── DELETE branch ─────────────────────────────────────────
  IF TG_OP = 'DELETE' THEN
    DELETE FROM public.account_transactions
    WHERE booking_payment_id = OLD.id;
    RETURN OLD;
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
  -- Any other UPDATE is ignored — we don't currently have such paths in
  -- the codebase, but the guard keeps us safe if one is added later.
  IF TG_OP = 'UPDATE' THEN
    IF OLD.method = 'other'
       AND NEW.method <> 'other'
       AND NEW.refund_id IS NOT NULL
    THEN
      v_bucket_id := CASE NEW.method
        WHEN 'cash'          THEN 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'::uuid
        WHEN 'bkash'         THEN 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33'::uuid
        WHEN 'nagad'         THEN 'd0eebc99-9c0b-4ef8-bb6d-6bb9bd380a44'::uuid
        WHEN 'bank_transfer' THEN 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22'::uuid
        WHEN 'card'          THEN 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22'::uuid
      END;

      IF v_bucket_id IS NULL THEN
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
  -- Unchanged from 2026-05-23-booking-payment-integration-trigger.sql.
  -- For fresh INSERTs, NEW.created_at IS today (the payment is being
  -- recorded right now), so NEW.created_at::date == current_date.

  IF NEW.refund_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  v_bucket_id := CASE NEW.method
    WHEN 'cash'          THEN 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'::uuid
    WHEN 'bkash'         THEN 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33'::uuid
    WHEN 'nagad'         THEN 'd0eebc99-9c0b-4ef8-bb6d-6bb9bd380a44'::uuid
    WHEN 'bank_transfer' THEN 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22'::uuid
    WHEN 'card'          THEN 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22'::uuid
    WHEN 'online'        THEN 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22'::uuid
    WHEN 'other'         THEN 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22'::uuid
  END;

  IF v_bucket_id IS NULL THEN
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
$$ LANGUAGE plpgsql;

-- NOTE: trigger registration (CREATE TRIGGER trg_sync_account_transactions)
-- is NOT in this file. The trigger from 2026-05-23-...trigger.sql is
-- still bound to the function name; CREATE OR REPLACE FUNCTION above
-- swaps the function body in place. No DROP/CREATE TRIGGER needed.

-- =============================================================
-- Verification queries — run AFTER applying:
--
--   -- Q1: function body should have current_date and now() in the
--   -- UPDATE branch (not NEW.created_at::date / NEW.created_at).
--   SELECT pg_get_functiondef(p.oid)
--   FROM pg_proc p
--   JOIN pg_namespace n ON n.oid = p.pronamespace
--   WHERE n.nspname = 'public' AND p.proname = 'fn_sync_account_transactions';
--
--   -- Q2: trigger registration is unchanged — still 3 triggers on payments.
--   SELECT tgname FROM pg_trigger
--   WHERE tgrelid = 'public.payments'::regclass
--     AND NOT tgisinternal
--   ORDER BY tgname;
--   -- Expected: trg_sync_account_transactions, trg_sync_last_payment_method,
--   -- trg_sync_paid_amount.
-- =============================================================

-- sql/migrations/2026-05-23-booking-payment-integration-trigger.sql
-- Booking-payment integration — Stage 2 of 2: install the auto-sync trigger.
--
-- ─── STATUS ───────────────────────────────────────────────────
-- APPLIED TO PRODUCTION: 2026-05-23
-- Verified post-application via:
--   Q5: 3 triggers on public.payments (this one fires first alphabetically)
--   Q6: pg_proc.prosrc matches this file's CREATE OR REPLACE body exactly
--
-- Re-running on production is safe — DROP TRIGGER IF EXISTS +
-- CREATE OR REPLACE FUNCTION means no duplication or version drift.
-- Fresh-environment setup should apply the backfill migration first,
-- then this one.
-- ──────────────────────────────────────────────────────────────
--
-- After this migration, every INSERT, UPDATE, or DELETE on public.payments
-- is mirrored into public.account_transactions per the discriminator set:
--
--   INSERT  refund_id IS NULL                   → write daybook row
--   INSERT  refund_id IS NOT NULL               → skip (pre-adjustment; money pending)
--   UPDATE  OLD.method = 'other'                → write daybook row (pre-adjustment disbursed)
--           AND NEW.method <> 'other'
--           AND NEW.refund_id IS NOT NULL
--   UPDATE  (any other)                         → skip
--   DELETE                                       → cascade-delete daybook row by booking_payment_id
--
-- Trigger ordering on public.payments (Postgres fires AFTER triggers
-- alphabetically by name):
--   trg_sync_account_transactions  <-- this migration  (fires FIRST)
--   trg_sync_last_payment_method
--   trg_sync_paid_amount
--
-- All run inside the same SQL transaction as the originating DML. If
-- trg_sync_paid_amount RAISEs (e.g. disbursement > paid_amount), the whole
-- transaction rolls back including our account_transactions write. Atomic
-- by construction.
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

      -- disburse_refund constrains NEW.method to the 5 values above; an
      -- unmapped value here is a code-path error elsewhere, fail loud.
      IF v_bucket_id IS NULL THEN
        RAISE EXCEPTION
          'fn_sync_account_transactions UPDATE branch: unmapped method %. '
          'disburse_refund should only set method to cash/bkash/nagad/bank_transfer/card.',
          NEW.method;
      END IF;

      -- account_transactions.amount is positive-only; the pre-adjustment
      -- was a negative payment so we write an expense_out with ABS(amount).
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
    -- All other UPDATE patterns: do nothing (the daybook row, if any,
    -- already exists; we don't currently support edits to the underlying
    -- payment record).
    RETURN NEW;
  END IF;

  -- ── INSERT branch ─────────────────────────────────────────

  -- Pre-adjustment: payment row exists but money hasn't physically moved.
  -- Skip — the trigger will write the daybook row at disbursement UPDATE time.
  IF NEW.refund_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- Normal payment INSERT (recordPayment, create_booking_with_rooms,
  -- cancellation Branch C, disburse_refund Path B). Map method to bucket.
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
    -- Inflow: guest payment landing in a bucket.
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
    -- Outflow: cancellation refund or Path B disbursement leaving a bucket.
    -- account_transactions.amount is positive-only; direction lives in type
    -- + from_account_id.
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

-- Replace any previous version if re-running.
DROP TRIGGER IF EXISTS trg_sync_account_transactions ON public.payments;
CREATE TRIGGER trg_sync_account_transactions
AFTER INSERT OR UPDATE OR DELETE ON public.payments
FOR EACH ROW
EXECUTE FUNCTION public.fn_sync_account_transactions();

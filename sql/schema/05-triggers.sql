-- =============================================================
-- 05-triggers.sql
-- Trigger functions and their trigger bindings.
--
-- Trigger function bodies authoritative as of 2026-05-07,
-- extracted from Supabase Dashboard → Database → Functions.
-- fn_sync_last_payment_method was already authoritative from
-- sql/add_payment_method_extras.sql.
--
-- Updated: 2026-05-08 — fn_sync_room_status RETIRED.
--   Dropped by migration 2026-05-08-multi-room-foundation.sql.
--   Replaced by app-layer RPCs (checkout_booking_room,
--   cancel_booking_room, create_booking_with_rooms, etc.) which
--   set rooms.status directly. See sql/migrations/2026-05-08-multi-room-rpc.sql.
--
-- Active functions (4 remain):
--   1. fn_stamp_booking_timestamps — BEFORE UPDATE OF status ON bookings
--   2. fn_sync_paid_amount         — AFTER INSERT OR DELETE ON payments
--   3. fn_sync_payment_status      — BEFORE UPDATE OF paid_amount, total_amount ON bookings
--   4. fn_sync_last_payment_method — AFTER INSERT ON payments
--
-- NOTE — binding corrections vs initial reconstruction (2026-05-07):
--   trg_stamp_booking_timestamps was INSERT OR UPDATE → UPDATE OF status only
--   trg_sync_paid_amount      was INSERT OR UPDATE OR DELETE → INSERT only (2026-05-08)
--                             Body changed: incremental (+=) not re-aggregate (SUM)
--                             Extended to INSERT OR DELETE (2026-05-14, Phase 11 #50):
--                             DELETE branch re-aggregates; INSERT branch unchanged.
--   trg_sync_payment_status   was UPDATE OF paid_amount → UPDATE OF paid_amount, total_amount
-- =============================================================


-- ─────────────────────────────────────────────────────────────
-- RETIRED — fn_sync_room_status
--
-- Previously: AFTER UPDATE OF status ON bookings
-- Mapped booking.status → rooms.status via CASE expression.
--
-- Retired: 2026-05-08 — migration 2026-05-08-multi-room-foundation.sql
-- Reason:  Multi-room support requires per-room room status control.
--          A single booking.status → single room mapping no longer
--          works when a booking covers N rooms in different states.
--          App-layer RPCs now own rooms.status directly.
-- Rollback: see 2026-05-08-multi-room-foundation-rollback.sql
-- ─────────────────────────────────────────────────────────────


-- ─────────────────────────────────────────────────────────────
-- 1. fn_stamp_booking_timestamps
-- Fires: BEFORE UPDATE OF status ON bookings
--
-- Sets the appropriate lifecycle timestamp (once) when a booking
-- transitions to a new status.  Guards each stamp with an IS NULL
-- check so it is idempotent on repeated updates to the same status.
--
-- Implication of UPDATE-only binding: confirmed_at is NOT stamped
-- automatically on INSERT (new booking creation).  The service
-- layer passes confirmed_at = NOW() explicitly in createBooking
-- and create_booking_with_rooms RPC.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_stamp_booking_timestamps()
RETURNS TRIGGER AS $$
BEGIN
  -- Only act on actual status transitions
  IF NEW.status IS DISTINCT FROM OLD.status THEN

    IF NEW.status = 'confirmed'   AND OLD.confirmed_at   IS NULL THEN
      NEW.confirmed_at   = NOW();
    END IF;

    IF NEW.status = 'checked_in'  AND OLD.checked_in_at  IS NULL THEN
      NEW.checked_in_at  = NOW();
    END IF;

    IF NEW.status = 'checked_out' AND OLD.checked_out_at IS NULL THEN
      NEW.checked_out_at = NOW();
    END IF;

    IF NEW.status = 'cancelled'   AND OLD.cancelled_at   IS NULL THEN
      NEW.cancelled_at   = NOW();
    END IF;

  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_stamp_booking_timestamps ON public.bookings;
CREATE TRIGGER trg_stamp_booking_timestamps
BEFORE UPDATE OF status ON public.bookings
FOR EACH ROW
EXECUTE FUNCTION public.fn_stamp_booking_timestamps();


-- ─────────────────────────────────────────────────────────────
-- 2. fn_sync_paid_amount
-- Fires: AFTER INSERT OR DELETE ON payments
--
-- INSERT branch: fail-fast incremental (Phase 8.5, 2026-05-09).
--   Raises if result < 0 — prevents disbursing more than received.
--   recordPayment() in bookingsService.ts INSERT-only design matches.
--
-- DELETE branch: re-aggregate from remaining rows (Phase 11 #50, 2026-05-14).
--   Defensive against pre-existing scalar drift. Does not raise.
--   Payment rows should never be deleted in normal flow — this branch
--   guards against manual SQL Editor deletions (e.g. test-data cleanup).
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_sync_paid_amount()
RETURNS TRIGGER AS $$
DECLARE
  v_current NUMERIC;
  v_new     NUMERIC;
BEGIN

  IF TG_OP = 'DELETE' THEN
    UPDATE public.bookings
    SET    paid_amount = (
             SELECT COALESCE(SUM(amount), 0)
             FROM   public.payments
             WHERE  booking_id = OLD.booking_id
           )
    WHERE  id = OLD.booking_id;
    RETURN OLD;
  END IF;

  SELECT paid_amount INTO v_current
  FROM   public.bookings
  WHERE  id = NEW.booking_id;

  v_new := v_current + NEW.amount;

  IF v_new < 0 THEN
    RAISE EXCEPTION
      'Disbursement of % would result in negative paid_amount '
      '(current: %, projected: %). '
      'Cannot disburse more than has been received.',
      NEW.amount, v_current, v_new;
  END IF;

  UPDATE public.bookings
  SET    paid_amount = v_new
  WHERE  id = NEW.booking_id;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_paid_amount ON public.payments;
CREATE TRIGGER trg_sync_paid_amount
AFTER INSERT OR DELETE ON public.payments
FOR EACH ROW
EXECUTE FUNCTION public.fn_sync_paid_amount();


-- ─────────────────────────────────────────────────────────────
-- 3. fn_sync_payment_status
-- Fires: BEFORE UPDATE OF paid_amount, total_amount ON bookings
--
-- Derives payment_status from paid_amount vs total_amount.
-- Only recalculates when either watched column actually changes.
--
-- ⚠  KNOWN BUG — does not account for extra-charge adjustments:
--    Compares paid_amount >= total_amount, which ignores
--    extra_charge_amount, early_deduction_amount, and
--    additional_discount_amount.  A booking with extra charges
--    can show "paid" when balance is still outstanding.
--    See CLAUDE.md → Known Issues for full details and fix plan.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_sync_payment_status()
RETURNS TRIGGER AS $$
BEGIN
  -- Only recalculate when the relevant columns actually change.
  IF NEW.paid_amount  IS DISTINCT FROM OLD.paid_amount
  OR NEW.total_amount IS DISTINCT FROM OLD.total_amount
  THEN
    NEW.payment_status =
      CASE
        WHEN NEW.paid_amount <= 0                   THEN 'unpaid'::payment_status
        WHEN NEW.paid_amount >= NEW.total_amount    THEN 'paid'::payment_status
        ELSE                                             'partial'::payment_status
      END;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_payment_status ON public.bookings;
CREATE TRIGGER trg_sync_payment_status
BEFORE UPDATE OF paid_amount, total_amount ON public.bookings
FOR EACH ROW
EXECUTE FUNCTION public.fn_sync_payment_status();


-- ─────────────────────────────────────────────────────────────
-- 4. fn_sync_last_payment_method   ← AUTHORITATIVE
-- Source: sql/add_payment_method_extras.sql (committed 2026-04-30)
--
-- Fires: AFTER INSERT ON payments
-- Keeps bookings.last_payment_method in sync with the most-
-- recently recorded payment method.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_sync_last_payment_method()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE public.bookings
     SET last_payment_method = NEW.method
   WHERE id = NEW.booking_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_last_payment_method ON public.payments;
CREATE TRIGGER trg_sync_last_payment_method
AFTER INSERT ON public.payments
FOR EACH ROW
EXECUTE FUNCTION public.fn_sync_last_payment_method();

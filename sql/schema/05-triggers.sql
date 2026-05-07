-- =============================================================
-- 05-triggers.sql
-- Trigger functions and their trigger bindings.
--
-- Trigger function bodies authoritative as of 2026-05-07,
-- extracted from Supabase Dashboard → Database → Functions.
-- fn_sync_last_payment_method was already authoritative from
-- sql/add_payment_method_extras.sql.
--
-- Functions defined here:
--   1. fn_sync_room_status         — AFTER UPDATE OF status ON bookings
--   2. fn_stamp_booking_timestamps — BEFORE UPDATE OF status ON bookings
--   3. fn_sync_paid_amount         — AFTER INSERT ON payments
--   4. fn_sync_payment_status      — BEFORE UPDATE OF paid_amount, total_amount ON bookings
--   5. fn_sync_last_payment_method — AFTER INSERT ON payments
--
-- NOTE — binding corrections vs initial reconstruction:
--   trg_sync_room_status      was INSERT OR UPDATE OR DELETE → UPDATE OF status only
--   trg_stamp_booking_timestamps was INSERT OR UPDATE → UPDATE OF status only
--   trg_sync_paid_amount      was INSERT OR UPDATE OR DELETE → INSERT only
--                             Body also changed: incremental (+=) not re-aggregate (SUM)
--   trg_sync_payment_status   was UPDATE OF paid_amount → UPDATE OF paid_amount, total_amount
-- =============================================================


-- ─────────────────────────────────────────────────────────────
-- 1. fn_sync_room_status
-- Fires: AFTER UPDATE OF status ON bookings
--
-- Maps booking status → room status via a CASE expression.
-- Only acts when status actually changes (IS DISTINCT FROM).
--
-- Implication of UPDATE-only binding: the service layer must
-- manually set room status on booking INSERT and DELETE
-- (createBooking Step 3, updateBooking Step 6).
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_sync_room_status()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    UPDATE rooms
    SET    status = CASE NEW.status
                     WHEN 'confirmed'   THEN 'reserved'::room_status
                     WHEN 'checked_in'  THEN 'occupied'::room_status
                     WHEN 'checked_out' THEN 'cleaning'::room_status
                     WHEN 'cancelled'   THEN 'available'::room_status
                   END
    WHERE  id = NEW.room_id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_room_status ON public.bookings;
CREATE TRIGGER trg_sync_room_status
AFTER UPDATE OF status ON public.bookings
FOR EACH ROW
EXECUTE FUNCTION public.fn_sync_room_status();


-- ─────────────────────────────────────────────────────────────
-- 2. fn_stamp_booking_timestamps
-- Fires: BEFORE UPDATE OF status ON bookings
--
-- Sets the appropriate lifecycle timestamp (once) when a booking
-- transitions to a new status.  Guards each stamp with an IS NULL
-- check so it is idempotent on repeated updates to the same status.
--
-- Implication of UPDATE-only binding: confirmed_at is NOT stamped
-- automatically on INSERT (new booking creation).  The service
-- layer passes confirmed_at = NOW() explicitly in createBooking.
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
-- 3. fn_sync_paid_amount
-- Fires: AFTER INSERT ON payments
--
-- Increments bookings.paid_amount by the new payment's amount.
-- Uses GREATEST(0, ...) to guard against a negative drift.
--
-- Implication of INSERT-only + incremental body:
--   • Payment UPDATEs and DELETEs do NOT trigger auto-recalc.
--   • If a payment row is ever corrected or removed outside the
--     normal app flow, paid_amount must be manually reconciled.
--   • recordPayment() in bookingsService.ts INSERT-only design
--     matches this trigger exactly.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_sync_paid_amount()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE bookings
  SET    paid_amount = GREATEST(0, paid_amount + NEW.amount)
  WHERE  id = NEW.booking_id;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_paid_amount ON public.payments;
CREATE TRIGGER trg_sync_paid_amount
AFTER INSERT ON public.payments
FOR EACH ROW
EXECUTE FUNCTION public.fn_sync_paid_amount();


-- ─────────────────────────────────────────────────────────────
-- 4. fn_sync_payment_status
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
-- 5. fn_sync_last_payment_method   ← AUTHORITATIVE
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

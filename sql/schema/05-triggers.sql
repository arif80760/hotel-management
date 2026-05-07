-- =============================================================
-- 05-triggers.sql
-- Trigger functions and their trigger bindings.
--
-- Exported: 2026-05-07
--
-- ┌─────────────────────────────────────────────────────────┐
-- │  ⚠  RECONSTRUCTION WARNING                              │
-- │                                                         │
-- │  Four of the five trigger functions below were applied  │
-- │  directly in the Supabase Dashboard SQL editor and      │
-- │  never committed to source control.  Their bodies here  │
-- │  are RECONSTRUCTED from:                                │
-- │    • Documented behaviour in bookingsService.ts         │
-- │    • Comments and constants in the service layer        │
-- │    • Column names / types verified from OpenAPI spec    │
-- │                                                         │
-- │  The fifth function (fn_sync_last_payment_method) is    │
-- │  authoritative — it was committed in                    │
-- │  sql/add_payment_method_extras.sql.                     │
-- │                                                         │
-- │  To obtain the exact live bodies: open Supabase         │
-- │  Dashboard → Database → Functions and copy each one.   │
-- └─────────────────────────────────────────────────────────┘
--
-- Functions defined here:
--   1. fn_sync_room_status         (RECONSTRUCTED)
--   2. fn_stamp_booking_timestamps (RECONSTRUCTED)
--   3. fn_sync_paid_amount         (RECONSTRUCTED)
--   4. fn_sync_payment_status      (RECONSTRUCTED)
--   5. fn_sync_last_payment_method (AUTHORITATIVE — from add_payment_method_extras.sql)
-- =============================================================


-- ─────────────────────────────────────────────────────────────
-- 1. fn_sync_room_status
-- Fires: AFTER INSERT OR UPDATE OF status OR DELETE ON bookings
--
-- Logic:
--   confirmed   → room.status = 'reserved'
--   checked_in  → room.status = 'occupied'
--   checked_out → room.status = 'cleaning'
--   cancelled   → room.status = 'available'
--                 (only if no other active booking holds the room)
--
-- On DELETE: if no remaining active bookings for that room,
--            set room.status = 'available'.
--
-- NOTE: The trigger fires on status column changes ONLY.
--       When room_id changes (room move), the service layer
--       (updateBooking Step 6) manually updates both the old
--       and new room status.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_sync_room_status()
RETURNS TRIGGER AS $$
DECLARE
  v_active_count INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Check if any other active booking still holds this room
    SELECT COUNT(*) INTO v_active_count
    FROM public.bookings
    WHERE room_id = OLD.room_id
      AND status IN ('confirmed', 'checked_in')
      AND id <> OLD.id;

    IF v_active_count = 0 THEN
      UPDATE public.rooms SET status = 'available' WHERE id = OLD.room_id;
    END IF;
    RETURN OLD;
  END IF;

  -- INSERT or UPDATE
  CASE NEW.status
    WHEN 'confirmed' THEN
      UPDATE public.rooms SET status = 'reserved'  WHERE id = NEW.room_id;
    WHEN 'checked_in' THEN
      UPDATE public.rooms SET status = 'occupied'  WHERE id = NEW.room_id;
    WHEN 'checked_out' THEN
      UPDATE public.rooms SET status = 'cleaning'  WHERE id = NEW.room_id;
    WHEN 'cancelled' THEN
      -- Only release the room if no other active booking holds it
      SELECT COUNT(*) INTO v_active_count
      FROM public.bookings
      WHERE room_id = NEW.room_id
        AND status IN ('confirmed', 'checked_in')
        AND id <> NEW.id;

      IF v_active_count = 0 THEN
        UPDATE public.rooms SET status = 'available' WHERE id = NEW.room_id;
      END IF;
    ELSE
      NULL; -- unknown status — do nothing
  END CASE;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_room_status ON public.bookings;
CREATE TRIGGER trg_sync_room_status
AFTER INSERT OR UPDATE OF status OR DELETE ON public.bookings
FOR EACH ROW
EXECUTE FUNCTION public.fn_sync_room_status();


-- ─────────────────────────────────────────────────────────────
-- 2. fn_stamp_booking_timestamps
-- Fires: AFTER INSERT OR UPDATE OF status ON bookings
--
-- Sets the appropriate lifecycle timestamp (once) when a booking
-- transitions to a new status.  Does not overwrite an already-set
-- timestamp (idempotent).
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_stamp_booking_timestamps()
RETURNS TRIGGER AS $$
BEGIN
  CASE NEW.status
    WHEN 'confirmed' THEN
      IF NEW.confirmed_at IS NULL THEN
        NEW.confirmed_at := NOW();
      END IF;
    WHEN 'checked_in' THEN
      IF NEW.checked_in_at IS NULL THEN
        NEW.checked_in_at := NOW();
      END IF;
    WHEN 'checked_out' THEN
      IF NEW.checked_out_at IS NULL THEN
        NEW.checked_out_at := NOW();
      END IF;
    WHEN 'cancelled' THEN
      IF NEW.cancelled_at IS NULL THEN
        NEW.cancelled_at := NOW();
      END IF;
    ELSE
      NULL;
  END CASE;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_stamp_booking_timestamps ON public.bookings;
CREATE TRIGGER trg_stamp_booking_timestamps
BEFORE INSERT OR UPDATE OF status ON public.bookings
FOR EACH ROW
EXECUTE FUNCTION public.fn_stamp_booking_timestamps();


-- ─────────────────────────────────────────────────────────────
-- 3. fn_sync_paid_amount
-- Fires: AFTER INSERT OR UPDATE OR DELETE ON payments
--
-- Recalculates bookings.paid_amount as the SUM of all payments
-- for the affected booking, then updates bookings.
--
-- This in turn fires trg_sync_payment_status (which watches
-- paid_amount on bookings).
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_sync_paid_amount()
RETURNS TRIGGER AS $$
DECLARE
  v_booking_id UUID;
  v_total_paid NUMERIC(10,2);
BEGIN
  -- Determine which booking to update
  IF TG_OP = 'DELETE' THEN
    v_booking_id := OLD.booking_id;
  ELSE
    v_booking_id := NEW.booking_id;
  END IF;

  -- Re-aggregate all payments for this booking
  SELECT COALESCE(SUM(amount), 0)
    INTO v_total_paid
    FROM public.payments
   WHERE booking_id = v_booking_id;

  -- Write back to bookings (triggers fn_sync_payment_status next)
  UPDATE public.bookings
     SET paid_amount = v_total_paid
   WHERE id = v_booking_id;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_paid_amount ON public.payments;
CREATE TRIGGER trg_sync_paid_amount
AFTER INSERT OR UPDATE OR DELETE ON public.payments
FOR EACH ROW
EXECUTE FUNCTION public.fn_sync_paid_amount();


-- ─────────────────────────────────────────────────────────────
-- 4. fn_sync_payment_status
-- Fires: AFTER UPDATE OF paid_amount ON bookings
--
-- Derives payment_status and due_amount from paid_amount vs
-- total_amount.  Mirrors the frontend derivePaymentStatus()
-- helper in bookingsService.ts.
--
-- NOTE: Does NOT account for extra_charge_amount /
--       early_deduction_amount / additional_discount_amount —
--       those adjustments are computed in the app layer
--       (calcTrueDue in lib/invoiceUtils.ts).
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_sync_payment_status()
RETURNS TRIGGER AS $$
DECLARE
  v_status public.payment_status;
BEGIN
  IF NEW.paid_amount <= 0 THEN
    v_status := 'unpaid';
  ELSIF NEW.paid_amount >= NEW.total_amount THEN
    v_status := 'paid';
  ELSE
    v_status := 'partial';
  END IF;

  NEW.payment_status := v_status;
  NEW.due_amount     := GREATEST(0, NEW.total_amount - NEW.paid_amount);

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_payment_status ON public.bookings;
CREATE TRIGGER trg_sync_payment_status
BEFORE UPDATE OF paid_amount ON public.bookings
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

-- =============================================================
-- Migration: Early checkout deduction + additional discount
-- =============================================================
--
-- Run this ONCE in Supabase Dashboard → SQL Editor → New query → Run.
-- Keep this file in sql/ as a permanent migration record.
--
-- New columns added to the bookings table:
--
--   actual_checkout_date       — the calendar date the guest actually left
--                                (may be earlier than check_out_date)
--
--   early_nights_deducted      — how many unused nights were deducted
--                                max(0, check_out_date - actual_checkout_date)
--
--   early_deduction_amount     — early_nights_deducted × booking_rate
--                                credited back to the guest; reduces finalPayable
--
--   additional_discount_amount — ad-hoc discount applied at checkout by
--                                staff or admin (e.g. guest negotiation)
--
--   additional_discount_reason — optional free-text reason for the discount
--
--   additional_discount_by     — auth.users UUID of who applied the discount
--
--   additional_discount_at     — timestamp when the discount was applied
--
-- Updated finalPayable formula (frontend):
--   finalPayable = (total_amount + extra_charge_amount)
--                - early_deduction_amount
--                - additional_discount_amount
--                - paid_amount
--
-- All new columns are nullable / defaulted so existing rows are unaffected.
-- =============================================================

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS actual_checkout_date       DATE           DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS early_nights_deducted      INTEGER        DEFAULT 0,
  ADD COLUMN IF NOT EXISTS early_deduction_amount     NUMERIC(10,2)  DEFAULT 0,
  ADD COLUMN IF NOT EXISTS additional_discount_amount NUMERIC(10,2)  DEFAULT 0,
  ADD COLUMN IF NOT EXISTS additional_discount_reason TEXT           DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS additional_discount_by     UUID           REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS additional_discount_at     TIMESTAMPTZ    DEFAULT NULL;

-- Optional: column-level documentation visible in Supabase Table Editor
COMMENT ON COLUMN bookings.actual_checkout_date
  IS 'Calendar date the guest actually vacated the room (may be before check_out_date for early checkouts)';

COMMENT ON COLUMN bookings.early_nights_deducted
  IS 'Number of unused nights: max(0, check_out_date - actual_checkout_date). 0 for on-time or late checkouts.';

COMMENT ON COLUMN bookings.early_deduction_amount
  IS 'early_nights_deducted × booking_rate — credited back to the guest; reduces the final payable amount';

COMMENT ON COLUMN bookings.additional_discount_amount
  IS 'Ad-hoc discount applied at checkout by staff or admin (e.g. guest negotiation). Reduces final payable.';

COMMENT ON COLUMN bookings.additional_discount_reason
  IS 'Optional plain-text reason for the additional discount, e.g. "Loyalty discount" or "Manager approval"';

COMMENT ON COLUMN bookings.additional_discount_by
  IS 'auth.users UUID of the staff member or admin who applied the additional discount';

COMMENT ON COLUMN bookings.additional_discount_at
  IS 'Timestamp when the additional discount was applied (set at checkout time)';

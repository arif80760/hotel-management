-- Migration: Add extra_charge_amount and extra_charge_reason columns to bookings table
--
-- extra_charge_amount = additional charge applied at checkout (damage, mini-bar, etc.)
-- extra_charge_reason = formatted description, e.g. "Mini-bar - 3 soft drinks"
--
-- These are recorded when checkout happens via checkoutNormal or checkoutWithOverride.
-- Both are optional (nullable) for backwards compatibility with existing rows.
-- final_payable = (total_amount + extra_charge_amount) - amount_paid
--
-- Run this once in Supabase SQL Editor (Dashboard → SQL Editor → New query):

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS extra_charge_amount NUMERIC(10, 2) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS extra_charge_reason TEXT           DEFAULT NULL;

-- Optional: add comments for documentation
COMMENT ON COLUMN bookings.extra_charge_amount IS 'Additional charge applied at checkout (damage, mini-bar, laundry, etc.)';
COMMENT ON COLUMN bookings.extra_charge_reason IS 'Formatted reason string, e.g. "Mini-bar - 3 soft drinks" or "Room damage - Broken lamp"';

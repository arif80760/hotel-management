-- Migration: Add fixed_rate and booking_rate columns to bookings table
--
-- fixed_rate   = standard published room rate per night at time of booking
-- booking_rate = actual negotiated rate per night (may be discounted)
--
-- When booking_rate < fixed_rate: a discount was applied.
-- totalAmount is always computed from booking_rate × nights.
-- Both are optional (nullable) for backwards compatibility with existing rows.
--
-- Run this once in Supabase SQL Editor (Dashboard → SQL Editor → New query):

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS fixed_rate   NUMERIC(10, 2) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS booking_rate NUMERIC(10, 2) DEFAULT NULL;

-- Optional: add a comment for documentation
COMMENT ON COLUMN bookings.fixed_rate   IS 'Published/standard room rate per night at time of booking';
COMMENT ON COLUMN bookings.booking_rate IS 'Actual negotiated rate per night (may be discounted from fixed_rate)';

-- add_payment_method_extras.sql
-- Extends the payment_method enum with bkash/nagad, adds last_payment_method
-- denormalized column to bookings, and creates a trigger to keep it in sync.
--
-- Run in TWO SEPARATE executions in Supabase SQL Editor:
--   Part 1 first (ALTER TYPE), then Part 2 (everything else).
--   PostgreSQL cannot use a newly-added enum value in the same transaction
--   that adds it.
--
-- Already applied: 2026-04-30

-- ─────────────────────────────────────────────────────────────────────────────
-- PART 1 — Extend payment_method enum
-- Run this block alone first, then run Part 2 separately.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TYPE payment_method ADD VALUE IF NOT EXISTS 'bkash';
ALTER TYPE payment_method ADD VALUE IF NOT EXISTS 'nagad';

-- ─────────────────────────────────────────────────────────────────────────────
-- PART 2 — Add last_payment_method column + back-fill + sync trigger
-- Run this block after Part 1 has committed.
-- ─────────────────────────────────────────────────────────────────────────────

-- Add denormalized column (nullable — null means no payment recorded yet)
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS last_payment_method payment_method;

-- Back-fill from most recent existing payment per booking
UPDATE bookings b
SET last_payment_method = (
  SELECT p.method
  FROM payments p
  WHERE p.booking_id = b.id
  ORDER BY p.created_at DESC
  LIMIT 1
)
WHERE EXISTS (
  SELECT 1 FROM payments p WHERE p.booking_id = b.id
);

-- Trigger function: keep last_payment_method in sync on every new payment
CREATE OR REPLACE FUNCTION fn_sync_last_payment_method()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE bookings
  SET last_payment_method = NEW.method
  WHERE id = NEW.booking_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Attach trigger to payments table
DROP TRIGGER IF EXISTS trg_sync_last_payment_method ON payments;
CREATE TRIGGER trg_sync_last_payment_method
AFTER INSERT ON payments
FOR EACH ROW
EXECUTE FUNCTION fn_sync_last_payment_method();

-- ===========================================================================
-- Migration: Multi-Room Booking Foundation
-- File:    sql/migrations/2026-05-08-multi-room-foundation.sql
-- Date:    2026-05-08
-- Author:  Phase 1 of docs/multi-room-design.md
--
-- WHAT THIS MIGRATION DOES:
--   1. Creates booking_rooms table     (per-room stay record)
--   2. Creates booking_extra_charges table  (itemized extra charges)
--   3. Creates refunds table           (two-step refund lifecycle)
--   4. Backfills all existing bookings → booking_rooms (1:1)
--   5. Backfills existing extra charges → booking_extra_charges
--   6. Verification DO block (raises on mismatch — rolls back)
--   7. Drops trg_sync_room_status + fn_sync_room_status
--
-- NOTE: 'checked_out_early' enum extension is in enum-prep.sql (prerequisite).
--
-- WHAT THIS MIGRATION DOES NOT DO (safety):
--   • Does NOT drop any columns from bookings — they stay for Phase 3
--     backward-compat. Column drops happen in a future migration.
--   • Does NOT modify any existing rows in bookings, rooms, or payments.
--   • Does NOT touch any other triggers.
--
-- PREREQUISITE: Run sql/migrations/2026-05-08-multi-room-enum-prep.sql
--   FIRST in a separate session. The 'checked_out_early' enum value must
--   be committed before this migration can use it. PostgreSQL raises
--   ERROR 55P04 ("unsafe use of new value") if both run in the same session.
--
-- TESTING — recommended workflow:
--   1. Run enum-prep.sql in one SQL Editor session (commits immediately).
--   2. Open a NEW SQL Editor session, paste this file, change COMMIT → ROLLBACK.
--   3. Inspect the NOTICE messages and verification SELECT output.
--   4. Open another NEW session, paste this file with COMMIT, run for real.
--
-- ROLLBACK:
--   See companion file: 2026-05-08-multi-room-foundation-rollback.sql
--
-- APPLY ORDER:
--   1. 2026-05-08-multi-room-enum-prep.sql  (separate session — adds enum value)
--   2. This file                            (separate session — uses enum value)
--   3. 2026-05-08-multi-room-rpc.sql        (separate session — creates functions)
-- ===========================================================================


-- ═══════════════════════════════════════════════════════════════════════════
-- MAIN MIGRATION — wrapped in a single transaction.
-- All table creates, backfill INSERTs, and trigger drops are atomic.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 1 — Create booking_rooms
--
-- Junction table: one row per room per booking.
-- Captures the per-room stay period, rate, status, and lifecycle timestamps.
-- bookings.room_id is kept as a backward-compat pointer to the first/only room.
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.booking_rooms (
  id                     UUID                 PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Core links
  booking_id             UUID                 NOT NULL
                           REFERENCES public.bookings(id) ON DELETE CASCADE,
  room_id                UUID                 NOT NULL
                           REFERENCES public.rooms(id)   ON DELETE RESTRICT,

  -- Per-room stay period
  check_in_date          DATE                 NOT NULL,
  check_out_date         DATE                 NOT NULL,
  nights                 SMALLINT             NOT NULL,   -- check_out_date − check_in_date; update when dates change

  -- Rate and category captured at booking time (denormalised snapshot)
  room_category          public.room_category NOT NULL,
  booking_rate           NUMERIC(10, 2)        NOT NULL,   -- negotiated rate per night for this room

  -- Per-room lifecycle status
  -- Uses booking_status enum extended with 'checked_out_early' (added above)
  status                 public.booking_status NOT NULL DEFAULT 'confirmed',

  -- Early-checkout fields (mirrors bookings equivalents; populated on early departure)
  actual_checkout_date   DATE,
  early_nights_deducted  INTEGER               NOT NULL DEFAULT 0,
  early_deduction_amount NUMERIC(10, 2)         NOT NULL DEFAULT 0,

  -- Per-room lifecycle timestamps (set by service layer, not triggers)
  confirmed_at           TIMESTAMPTZ,
  checked_in_at          TIMESTAMPTZ,
  checked_out_at         TIMESTAMPTZ,
  cancelled_at           TIMESTAMPTZ,

  created_at             TIMESTAMPTZ          NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ          NOT NULL DEFAULT NOW(),

  -- Constraints
  CONSTRAINT chk_br_dates       CHECK (check_out_date > check_in_date),
  CONSTRAINT chk_br_nights      CHECK (nights > 0),
  CONSTRAINT chk_br_deduction   CHECK (early_deduction_amount >= 0),
  CONSTRAINT uq_booking_room    UNIQUE (booking_id, room_id)   -- same room cannot appear twice in one booking
);

COMMENT ON TABLE  public.booking_rooms
  IS 'Per-room stay records for a booking. One row per room per booking. Financial unit (total_amount, paid_amount) remains on bookings.';
COMMENT ON COLUMN public.booking_rooms.nights
  IS 'Computed as check_out_date − check_in_date at write time. Must be updated whenever check_out_date changes.';
COMMENT ON COLUMN public.booking_rooms.booking_rate
  IS 'Negotiated rate per night for this specific room in this booking.';
COMMENT ON COLUMN public.booking_rooms.status
  IS 'confirmed | checked_in | checked_out | checked_out_early | cancelled';
COMMENT ON COLUMN public.booking_rooms.early_deduction_amount
  IS 'early_nights_deducted × booking_rate. Deducted from bookings.total_amount on early departure.';
COMMENT ON COLUMN public.booking_rooms.actual_checkout_date
  IS 'Calendar date guest actually vacated this room. May be before check_out_date on early departure.';

-- Indexes
CREATE INDEX IF NOT EXISTS idx_booking_rooms_booking_id
  ON public.booking_rooms (booking_id);

CREATE INDEX IF NOT EXISTS idx_booking_rooms_room_id
  ON public.booking_rooms (room_id);

CREATE INDEX IF NOT EXISTS idx_booking_rooms_status
  ON public.booking_rooms (status);

CREATE INDEX IF NOT EXISTS idx_booking_rooms_dates
  ON public.booking_rooms (check_in_date, check_out_date);

-- Conflict-detection query: (room_id, check_in_date, check_out_date, status)
CREATE INDEX IF NOT EXISTS idx_booking_rooms_conflict
  ON public.booking_rooms (room_id, check_in_date, check_out_date)
  WHERE status IN ('confirmed', 'checked_in');

-- RLS
ALTER TABLE public.booking_rooms ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can read booking_rooms"
  ON public.booking_rooms FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated can insert booking_rooms"
  ON public.booking_rooms FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "Authenticated can update booking_rooms"
  ON public.booking_rooms FOR UPDATE TO authenticated USING (true);

CREATE POLICY "Authenticated can delete booking_rooms"
  ON public.booking_rooms FOR DELETE TO authenticated USING (true);


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 2 — Create booking_extra_charges
--
-- Itemized extra charges per booking, optionally attributed to one room.
-- Replaces the scalar bookings.extra_charge_amount / extra_charge_reason
-- columns, which are kept on bookings during the transition period.
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.booking_extra_charges (
  id              UUID              PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Core links
  booking_id      UUID              NOT NULL
                    REFERENCES public.bookings(id)      ON DELETE CASCADE,
  booking_room_id UUID
                    REFERENCES public.booking_rooms(id) ON DELETE SET NULL,
  -- NULL booking_room_id = booking-level charge (whole bill)
  -- Non-null = attributed to a specific room (e.g. mini-bar for Room 201 only)

  -- Charge details
  amount          NUMERIC(10, 2)    NOT NULL CHECK (amount > 0),
  reason          TEXT              NOT NULL,   -- e.g. "Mini-bar — 3 soft drinks"
  charge_type     TEXT,                         -- 'mini_bar' | 'laundry' | 'damage' | 'other'

  -- Audit
  applied_by      UUID              REFERENCES auth.users(id) ON DELETE SET NULL,
  applied_at      TIMESTAMPTZ       NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ       NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  public.booking_extra_charges
  IS 'Itemized extra charges per booking, optionally attributed to a specific room';
COMMENT ON COLUMN public.booking_extra_charges.booking_room_id
  IS 'NULL = booking-level charge; non-null = attributed to a specific room';
COMMENT ON COLUMN public.booking_extra_charges.charge_type
  IS 'Enum-like tag: mini_bar | laundry | damage | other';
COMMENT ON COLUMN public.booking_extra_charges.amount
  IS 'Must be > 0. Negative adjustments (credits) are not supported here — use refunds table.';

-- Indexes
CREATE INDEX IF NOT EXISTS idx_bec_booking_id
  ON public.booking_extra_charges (booking_id);

CREATE INDEX IF NOT EXISTS idx_bec_booking_room_id
  ON public.booking_extra_charges (booking_room_id);

-- RLS
ALTER TABLE public.booking_extra_charges ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can read booking_extra_charges"
  ON public.booking_extra_charges FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated can insert booking_extra_charges"
  ON public.booking_extra_charges FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "Authenticated can update booking_extra_charges"
  ON public.booking_extra_charges FOR UPDATE TO authenticated USING (true);

CREATE POLICY "Authenticated can delete booking_extra_charges"
  ON public.booking_extra_charges FOR DELETE TO authenticated USING (true);


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 3 — Create refunds
--
-- Two-step lifecycle: pending (created at cancellation) →
--   disbursed (admin confirms money returned) or denied.
-- bookings.paid_amount is intentionally NOT decremented — effective balance
-- is computed in the app layer (calcEffectiveBalance in invoiceUtils.ts).
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.refunds (
  id                   UUID              PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Core links
  booking_id           UUID              NOT NULL
                         REFERENCES public.bookings(id)      ON DELETE CASCADE,
  booking_room_id      UUID
                         REFERENCES public.booking_rooms(id) ON DELETE SET NULL,
  -- NULL = whole-booking refund; non-null = per-room refund (early departure)

  -- Refund amount — locked at creation; create a new row to correct
  amount               NUMERIC(10, 2)    NOT NULL CHECK (amount > 0),
  reason               TEXT,

  -- Lifecycle
  status               TEXT              NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending', 'disbursed', 'denied')),

  -- Creation audit
  created_at           TIMESTAMPTZ       NOT NULL DEFAULT NOW(),
  created_by           UUID              REFERENCES auth.users(id) ON DELETE SET NULL,

  -- Disbursement fields (populated when status → disbursed)
  disbursed_at         TIMESTAMPTZ,
  disbursed_by         UUID              REFERENCES auth.users(id) ON DELETE SET NULL,
  disbursement_method  TEXT
                         CHECK (disbursement_method IS NULL OR
                                disbursement_method IN
                                  ('cash', 'bkash', 'nagad', 'bank_transfer', 'card')),

  -- Optional staff note (denial reason, disbursement details, etc.)
  notes                TEXT
);

COMMENT ON TABLE  public.refunds
  IS 'Refund records for cancelled bookings or early departures. Two-step: pending → disbursed (or denied).';
COMMENT ON COLUMN public.refunds.booking_room_id
  IS 'NULL = whole-booking refund; non-null = per-room refund (e.g. early departure Scenario 7).';
COMMENT ON COLUMN public.refunds.amount
  IS 'Amount agreed at cancellation time. Cannot be edited — deny and create a new row to correct.';
COMMENT ON COLUMN public.refunds.status
  IS 'pending: awaiting disbursement | disbursed: money returned to guest | denied: rejected';
COMMENT ON COLUMN public.refunds.created_by
  IS 'Staff member who processed the cancellation and agreed the refund amount';
COMMENT ON COLUMN public.refunds.disbursed_by
  IS 'Admin who confirmed the physical money was returned to the guest';
COMMENT ON COLUMN public.refunds.disbursement_method
  IS 'How money was returned: cash | bkash | nagad | bank_transfer | card';

-- Indexes
CREATE INDEX IF NOT EXISTS idx_refunds_booking_id
  ON public.refunds (booking_id);

-- Partial index: only index pending rows — the ones that need admin action
CREATE INDEX IF NOT EXISTS idx_refunds_status_pending
  ON public.refunds (created_at)
  WHERE status = 'pending';

-- RLS
ALTER TABLE public.refunds ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can read refunds"
  ON public.refunds FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated can insert refunds"
  ON public.refunds FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "Authenticated can update refunds"
  ON public.refunds FOR UPDATE TO authenticated USING (true);


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 4 — Backfill booking_rooms from existing bookings
--
-- Creates exactly one booking_rooms row per booking.
-- bookings.room_id (deprecated but retained) maps directly to room_id here.
-- bookings.nights is a GENERATED column — we recompute from dates explicitly
-- to be safe against type-coercion edge cases.
-- booking_rate fallback: total_amount / nights for old rows where it is NULL.
-- ───────────────────────────────────────────────────────────────────────────

INSERT INTO public.booking_rooms (
  booking_id,
  room_id,
  check_in_date,
  check_out_date,
  nights,
  room_category,
  booking_rate,
  status,
  actual_checkout_date,
  early_nights_deducted,
  early_deduction_amount,
  confirmed_at,
  checked_in_at,
  checked_out_at,
  cancelled_at,
  created_at,
  updated_at
)
SELECT
  b.id                                                     AS booking_id,
  b.room_id,
  b.check_in_date,
  b.check_out_date,

  -- Recompute from dates; avoids dependency on the GENERATED bookings.nights column
  (b.check_out_date - b.check_in_date)::SMALLINT           AS nights,

  b.room_category_at_booking                               AS room_category,

  -- Prefer booking_rate; fall back to total_amount÷nights for pre-rate-column rows
  COALESCE(
    b.booking_rate,
    CASE
      WHEN (b.check_out_date - b.check_in_date) > 0
        THEN b.total_amount / (b.check_out_date - b.check_in_date)
      ELSE b.total_amount   -- 0-night edge case: rate = full amount (prevents divide-by-zero)
    END
  )                                                        AS booking_rate,

  -- Direct copy — booking_status values are identical for existing rows
  b.status,

  -- actual_checkout_date:
  --   checked_out / checked_out_early: use recorded date, fall back to check_out_date
  --   (on-time checkouts never set this column; COALESCE ensures consistency with
  --    checkout_booking_room RPC which always writes a non-null value)
  --   confirmed / checked_in / cancelled: keep NULL (guest has not departed)
  CASE
    WHEN b.status IN ('checked_out', 'checked_out_early')
      THEN COALESCE(b.actual_checkout_date, b.check_out_date)
    ELSE b.actual_checkout_date
  END                                                        AS actual_checkout_date,
  COALESCE(b.early_nights_deducted, 0)                    AS early_nights_deducted,
  COALESCE(b.early_deduction_amount, 0)                   AS early_deduction_amount,

  -- Lifecycle timestamps
  b.confirmed_at,
  b.checked_in_at,
  b.checked_out_at,
  b.cancelled_at,

  b.created_at,
  b.updated_at

FROM public.bookings b;


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 5 — Backfill booking_extra_charges from bookings.extra_charge_amount
--
-- Only for bookings where extra_charge_amount > 0.
-- booking_room_id: links to the booking_rooms row just created above.
-- charge_type: 'other' — we have no finer-grained type info in the old column.
-- applied_at: checked_out_at is the best approximation (charge was applied at
--   checkout); falls back to updated_at for rows where checked_out_at is NULL.
-- ───────────────────────────────────────────────────────────────────────────

INSERT INTO public.booking_extra_charges (
  booking_id,
  booking_room_id,
  amount,
  reason,
  charge_type,
  applied_at,
  created_at
)
SELECT
  b.id                                                     AS booking_id,
  br.id                                                    AS booking_room_id,
  b.extra_charge_amount,
  COALESCE(NULLIF(TRIM(b.extra_charge_reason), ''), 'Extra charge at checkout')
                                                           AS reason,
  'other'                                                  AS charge_type,
  COALESCE(b.checked_out_at, b.updated_at)                AS applied_at,
  b.updated_at                                             AS created_at

FROM public.bookings b
-- The JOIN here relies on the 1:1 relationship just created in Step 5
JOIN public.booking_rooms br ON br.booking_id = b.id

WHERE b.extra_charge_amount IS NOT NULL
  AND b.extra_charge_amount > 0;


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 6 — Verification
--
-- Counts are checked before the transaction commits.
-- Any mismatch raises EXCEPTION → entire transaction ROLLBACK.
-- ───────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_bookings_count       INTEGER;
  v_booking_rooms_count  INTEGER;
  v_extra_src_count      INTEGER;  -- bookings with extra_charge_amount > 0
  v_extra_dst_count      INTEGER;  -- rows in booking_extra_charges
BEGIN

  -- Check A: every booking has exactly one booking_rooms row
  SELECT COUNT(*) INTO v_bookings_count
  FROM public.bookings;

  SELECT COUNT(*) INTO v_booking_rooms_count
  FROM public.booking_rooms;

  IF v_bookings_count <> v_booking_rooms_count THEN
    RAISE EXCEPTION
      'BACKFILL MISMATCH: bookings=% but booking_rooms=%. Rolling back.',
      v_bookings_count, v_booking_rooms_count;
  END IF;

  -- Check B: booking_rooms has no duplicate booking_id (each booking has exactly 1 row)
  PERFORM booking_id
  FROM public.booking_rooms
  GROUP BY booking_id
  HAVING COUNT(*) > 1
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'BACKFILL ERROR: found booking_id with multiple booking_rooms rows. Rolling back.';
  END IF;

  -- Check C: extra charge rows match source
  SELECT COUNT(*) INTO v_extra_src_count
  FROM public.bookings
  WHERE extra_charge_amount IS NOT NULL
    AND extra_charge_amount > 0;

  SELECT COUNT(*) INTO v_extra_dst_count
  FROM public.booking_extra_charges;

  IF v_extra_src_count <> v_extra_dst_count THEN
    RAISE EXCEPTION
      'EXTRA CHARGE MISMATCH: source=% but booking_extra_charges=%. Rolling back.',
      v_extra_src_count, v_extra_dst_count;
  END IF;

  -- All checks passed
  RAISE NOTICE
    '✓ Backfill verified. bookings=%, booking_rooms=%, extra_charges source=%, extra_charges inserted=%.',
    v_bookings_count, v_booking_rooms_count, v_extra_src_count, v_extra_dst_count;

END;
$$;


-- ───────────────────────────────────────────────────────────────────────────
-- STEP 7 — Retire fn_sync_room_status trigger
--
-- This trigger set rooms.status whenever bookings.status changed.
-- With multi-room support, a single booking.status change no longer maps
-- cleanly to a single room action. The app-layer RPCs (checkout_booking_room,
-- cancel_booking_room, etc.) now own rooms.status directly.
--
-- The remaining four triggers are UNCHANGED:
--   trg_stamp_booking_timestamps  — still stamps booking-level timestamps
--   trg_sync_paid_amount          — still increments paid_amount on payment INSERT
--   trg_sync_payment_status       — still derives payment_status from paid vs total
--   trg_sync_last_payment_method  — still copies latest payment method to bookings
--
-- Reference: docs/multi-room-design.md § 6.4
-- ───────────────────────────────────────────────────────────────────────────

DROP TRIGGER  IF EXISTS trg_sync_room_status  ON public.bookings;
DROP FUNCTION IF EXISTS public.fn_sync_room_status();


-- ───────────────────────────────────────────────────────────────────────────
-- SUMMARY SELECTS — visible in SQL Editor output; no side effects
-- ───────────────────────────────────────────────────────────────────────────

SELECT
  'bookings'             AS table_name, COUNT(*) AS row_count FROM public.bookings
UNION ALL
SELECT
  'booking_rooms',        COUNT(*) FROM public.booking_rooms
UNION ALL
SELECT
  'booking_extra_charges', COUNT(*) FROM public.booking_extra_charges
UNION ALL
SELECT
  'refunds',              COUNT(*) FROM public.refunds;


COMMIT;

-- ===========================================================================
-- END OF MIGRATION
-- Next step: apply sql/migrations/2026-05-08-multi-room-rpc.sql
-- ===========================================================================

-- ===========================================================================
-- Phase 11 #33: Fix chk_paid_not_exceed_total — extend ceiling to include
--               extra_charge_amount, subtract additional_discount_amount
-- File:    sql/migrations/2026-05-13-phase11-33-paid-not-exceed-fixed.sql
-- Date:    2026-05-13
--
-- Nature:
--   DDL only — DROP + ADD CHECK constraint on public.bookings.
--   No data changes. No function or trigger changes.
--
-- Background:
--   The constraint chk_paid_not_exceed_total exists in production but was
--   never tracked in any migration file (predates the extras feature).
--   Its original formula:
--
--     CHECK (paid_amount <= total_amount)
--
--   blocks legitimate payments whenever an operator records payment for an
--   extra charge (damage, mini-bar, laundry, etc.) applied at checkout,
--   because paid_amount tries to exceed total_amount — which is rooms-only
--   at the moment the constraint fires.
--
--   The Phase 11 #43 smoke test on BK-1037 hit PostgreSQL error 23514:
--     "new row for relation \"bookings\" violates check constraint
--      \"chk_paid_not_exceed_total\""
--
-- Why the corrected formula does NOT subtract early_deduction_amount:
--   checkout_booking_room RPC (Step 1 of checkoutNormal) reduces
--   booking_rooms.nights to reflect the actual stay before calling
--   update_booking_total(), which recomputes total_amount as
--   SUM(non-cancelled nights × rate).  The deduction is therefore already
--   baked into total_amount before the constraint fires on any subsequent
--   write.  Subtracting early_deduction_amount from the constraint formula
--   would double-count it, producing a ceiling far below what is owed for
--   early-checkout bookings.
--
-- Why the corrected formula DOES add extra_charge_amount:
--   bookingsService.checkoutNormal runs steps in this order:
--     Step 1 — RPC checkout_booking_room → calls update_booking_total
--              (booking_extra_charges table is empty at this point;
--               total_amount = rooms-only)
--     Step 2 — UPDATE bookings SET extra_charge_amount = X
--     Step 3 — INSERT booking_extra_charges (table row)
--   At the moment recordPayment fires, total_amount still equals rooms-only
--   because update_booking_total was called in Step 1 before any table row
--   existed.  The scalar extra_charge_amount IS set (Step 2) but is not
--   reflected in total_amount.  Adding it to the constraint ceiling makes
--   the true maximum reachable.
--
-- Why the corrected formula DOES subtract additional_discount_amount:
--   No RPC or trigger ever subtracts additional_discount_amount from
--   total_amount.  It exists only as a scalar field and is accounted for
--   solely at the application layer (calcTrueDue, recordPayment trueDue).
--   The constraint must subtract it explicitly to prevent paid_amount from
--   exceeding what the guest legitimately owes after an ad-hoc discount.
--
-- Impact on cancel_booking RPC pre-check (phase8.6):
--   The cancel_booking guard checks IF v_paid_amount > v_extras_total
--   where v_extras_total = SUM(booking_extra_charges) from the table.
--   Under the new constraint, the firing ceiling after cancellation is
--   v_extras_total + extra_charge_amount - additional_discount_amount.
--   The pre-check is slightly more conservative than the new constraint
--   (it blocks before the constraint would), which is safe — no RPC
--   changes needed.
--
-- Impact on other update_booking_total callers:
--   add_room_to_booking and extend_booking_room only increase total_amount;
--   a widened ceiling cannot be violated when the floor rises.
--   cancel_booking_room and checkout_booking_room may decrease
--   total_amount, but the new ceiling is strictly wider than the old
--   ceiling for any booking with non-zero extra_charge_amount, so no
--   new violations are introduced.
--
-- Apply mode:
--   SQL Editor (service role). DDL is not reachable via PostgREST.
--   Single-block execution — no enum ADD VALUE, no multi-run requirement.
--   APPLIED: 2026-05-13 — constraint live in production (verified via
--   pg_constraint query and 0-row violation check).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Section 1: Drop existing constraint
--
-- IF EXISTS is defensive — the constraint is untracked so we cannot be
-- certain of its exact state on a fresh DB clone. Safe no-op if absent.
-- ---------------------------------------------------------------------------

ALTER TABLE public.bookings
  DROP CONSTRAINT IF EXISTS chk_paid_not_exceed_total;

-- ---------------------------------------------------------------------------
-- Section 2: Add corrected constraint
--
-- Formula: paid_amount ≤ total_amount + extra_charge_amount - additional_discount
--
-- COALESCE handling:
--   extra_charge_amount        — NUMERIC(10,2), nullable, no default
--   additional_discount_amount — NUMERIC(10,2), nullable, DEFAULT 0
--   Both use COALESCE for safety on legacy rows where columns are NULL.
-- ---------------------------------------------------------------------------

ALTER TABLE public.bookings
  ADD CONSTRAINT chk_paid_not_exceed_total CHECK (
    paid_amount <= (
      total_amount
      + COALESCE(extra_charge_amount,        0)
      - COALESCE(additional_discount_amount, 0)
    )
  );

-- ---------------------------------------------------------------------------
-- Section 3: Verification queries (run in SQL Editor after applying)
-- ---------------------------------------------------------------------------

-- 3a. Confirm constraint definition
--
-- SELECT conname, pg_get_constraintdef(oid) AS definition
-- FROM   pg_constraint
-- WHERE  conname = 'chk_paid_not_exceed_total';
--
-- Expected output:
--   conname                   | definition
--   chk_paid_not_exceed_total | CHECK ((paid_amount <= (total_amount +
--                             |   COALESCE(extra_charge_amount, (0)::numeric) -
--                             |   COALESCE(additional_discount_amount, (0)::numeric))))

-- 3b. Confirm 0 rows violate the new formula
--
-- SELECT id,
--        total_amount,
--        paid_amount,
--        extra_charge_amount,
--        additional_discount_amount,
--        (total_amount
--          + COALESCE(extra_charge_amount,        0)
--          - COALESCE(additional_discount_amount, 0)) AS allowed_max
-- FROM   public.bookings
-- WHERE  paid_amount > (
--          total_amount
--          + COALESCE(extra_charge_amount,        0)
--          - COALESCE(additional_discount_amount, 0)
--        );
--
-- Expected: 0 rows

-- ===========================================================================
-- END OF MIGRATION
-- ===========================================================================

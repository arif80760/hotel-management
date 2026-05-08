-- ===========================================================================
-- Backfill: stale confirmed booking_rooms on checked_in bookings
-- File:    sql/migrations/2026-05-08-backfill-stale-checkin-rooms.sql
-- Date:    2026-05-08
-- Apply:   After 2026-05-08-checkin-cascade-rpc.sql
--
-- Root cause:
--   updateBookingStatus() updated bookings.status to 'checked_in' but
--   never cascaded to booking_rooms.status. The Phase 6 edit modal reads
--   per-row status to decide lock state, so affected rooms showed as
--   fully editable on checked-in bookings.
--
-- Audit at time of diagnosis (2026-05-08):
--   6 rows across 4 bookings in the inconsistent state:
--     BK-1048  1 row
--     BK-1061  3 rows  (smoke-test booking)
--     BK-1035  1 row
--     BK-1047  1 row
--
-- The UPDATE below is intentionally broad: it will fix any rows that
-- drifted between diagnosis and migration apply, not just those 6.
-- It is safe because the WHERE clause only updates rooms whose parent
-- booking is genuinely checked_in and the room row is still confirmed.
-- ===========================================================================

-- Wrap both steps in a single transaction so the UPDATE rolls back if
-- the verification check raises an exception.
BEGIN;

-- ── Step 1: Backfill ──────────────────────────────────────────────────────
UPDATE public.booking_rooms br
SET
  status        = 'checked_in',
  checked_in_at = COALESCE(br.checked_in_at, b.checked_in_at, NOW()),
  updated_at    = NOW()
FROM public.bookings b
WHERE br.booking_id = b.id
  AND b.status      = 'checked_in'
  AND br.status     = 'confirmed';

-- ── Step 2: Verify zero inconsistencies remain ────────────────────────────
-- RAISE EXCEPTION inside this block will abort the transaction and roll
-- back the UPDATE above, leaving the DB unchanged.
DO $$
DECLARE
  inconsistent_count INT;
BEGIN
  SELECT COUNT(*)
  INTO   inconsistent_count
  FROM   public.booking_rooms br
  JOIN   public.bookings       b  ON b.id = br.booking_id
  WHERE  b.status  = 'checked_in'
    AND  br.status = 'confirmed';

  IF inconsistent_count > 0 THEN
    RAISE EXCEPTION
      'Backfill incomplete: % booking_rooms row(s) still have status=confirmed '
      'on a checked_in booking. Investigate before proceeding.',
      inconsistent_count;
  END IF;

  RAISE NOTICE 'Backfill complete — zero inconsistent rows remain.';
END $$;

COMMIT;

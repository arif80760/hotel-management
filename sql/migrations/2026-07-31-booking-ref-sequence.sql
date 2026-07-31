-- =============================================================
-- 2026-07-31-booking-ref-sequence.sql
-- Server-side booking reference numbering.
--
-- RECORD OF LIVE STATE — this was applied in the Supabase SQL editor on
-- 2026-07-31 (apply-first). Committed for history; re-running is safe
-- (idempotent: CREATE only if absent, else setval with is_called=false).
--
-- WHY:
--   booking_ref ("BK-1041") was previously CLIENT-assigned (the UI seeded
--   nextBookingId from MAX(ref)+1 in local state), which races across
--   concurrent sessions. public.booking_ref_seq moves assignment into the
--   DB; create_booking_with_rooms now derives the ref via nextval() (see
--   2026-07-31-restore-overlap-guard.sql for the function body).
--
-- SEEDING:
--   Seeded to MAX(numeric suffix of bookings.booking_ref) + 1 at apply
--   time. LIVE VALUE AT APPLY: the sequence was seeded to 1150.
--   setval(..., v_next, false) means the NEXT nextval() returns v_next
--   itself (is_called = false), not v_next + 1.
-- =============================================================

DO $$
DECLARE
  v_next BIGINT;
BEGIN
  -- Next reference = highest existing numeric suffix + 1 (0 if no bookings).
  SELECT COALESCE(MAX((substring(booking_ref FROM '[0-9]+$'))::BIGINT), 0) + 1
  INTO   v_next
  FROM   public.bookings
  WHERE  booking_ref ~ '[0-9]+$';

  IF NOT EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'S'
      AND n.nspname = 'public'
      AND c.relname = 'booking_ref_seq'
  ) THEN
    EXECUTE format('CREATE SEQUENCE public.booking_ref_seq START WITH %s', v_next);
  ELSE
    PERFORM setval('public.booking_ref_seq', v_next, false);
  END IF;
END $$;

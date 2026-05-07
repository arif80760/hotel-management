-- ===========================================================================
-- Rollback: Multi-Room Booking Foundation
-- File:    sql/migrations/2026-05-08-multi-room-foundation-rollback.sql
-- Date:    2026-05-08
-- Companion to: 2026-05-08-multi-room-foundation.sql
--
-- WHAT THIS ROLLBACK DOES:
--   1. Drops refunds table
--   2. Drops booking_extra_charges table
--   3. Drops booking_rooms table
--   4. Restores fn_sync_room_status function and trigger
--
-- WHAT THIS ROLLBACK CANNOT DO:
--   • Remove 'checked_out_early' from the booking_status enum.
--     PostgreSQL does not support DROP VALUE from an enum type.
--     The value is additive and harmless — existing code never
--     produces it, so no existing queries are affected.
--     If critical, the enum type itself would need to be replaced
--     (full type swap: add new type, alter all columns, drop old).
--     This is a deliberate "good enough" trade-off for a safe migration.
--
-- SAFE PRECONDITIONS:
--   • bookings table is UNCHANGED by the forward migration.
--     Rolling back does not risk any booking data.
--   • The only data lost on rollback is the backfill rows in
--     booking_rooms and booking_extra_charges — which are derived
--     from bookings and can be re-created by re-running the migration.
--
-- RUN ONLY IF: the forward migration was applied and you need to undo it.
-- ===========================================================================


BEGIN;

-- ───────────────────────────────────────────────────────────────────────────
-- Step 1 — Drop new tables (CASCADE drops their policies and indexes)
-- Order matters: refunds and booking_extra_charges have FKs to booking_rooms
-- ───────────────────────────────────────────────────────────────────────────

DROP TABLE IF EXISTS public.refunds                CASCADE;
DROP TABLE IF EXISTS public.booking_extra_charges  CASCADE;
DROP TABLE IF EXISTS public.booking_rooms          CASCADE;


-- ───────────────────────────────────────────────────────────────────────────
-- Step 2 — Restore fn_sync_room_status + trigger
--
-- Authoritative body from sql/schema/05-triggers.sql (2026-05-07).
-- This is the exact function that was dropped in the forward migration.
-- ───────────────────────────────────────────────────────────────────────────

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


-- ───────────────────────────────────────────────────────────────────────────
-- Verification
-- ───────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  RAISE NOTICE 'Rollback complete. booking_rooms, booking_extra_charges, refunds dropped. fn_sync_room_status restored.';
  RAISE NOTICE 'Note: booking_status enum value ''checked_out_early'' was NOT removed (PostgreSQL limitation).';
END;
$$;


COMMIT;

-- ===========================================================================
-- END OF ROLLBACK
-- ===========================================================================

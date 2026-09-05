-- =============================================================
-- 2026-09-05-add-room-rejoin.sql
-- Released rooms can rejoin their booking: uq_booking_room replaced
-- by a status-scoped GiST exclusion; add_room_to_booking hardened
-- (span guard, server-derived nights, informative error).
--
-- RECORD OF LIVE STATE — both blocks applied in the Supabase SQL
-- editor on 2026-09-05 (the DDL transaction had applied on an
-- earlier run; pg_constraint verified: only
-- excl_booking_rooms_active_overlap present, contype 'x',
-- uq_booking_room gone). Probes:
--   • released room 202 re-added to BK-1644 for [Sep 5, Sep 6):
--     SUCCEEDS, nights derived = 1 with p_nights 0 IGNORED.
--   • add over the still-blocking row: raises naming BK-1644 and the
--     actual covered range.
--   • degenerate span: span-guard raises.
--
-- INCIDENT (BK-1644): 5-room booking, three rooms checked_out_early,
-- desk could not re-add a released room for the remaining night. Two
-- causes, both fixed:
--   1. uq_booking_room — UNIQUE (booking_id, room_id) from the
--      2026-05-08 multi-room foundation ("one row per room per
--      booking, ever") — predates per-room checkout/cancel/early
--      departure, which made rows TERMINAL mid-booking and
--      invalidated the assumption. Dependency sweep before dropping:
--      NOTHING relies on one-row-per-room (all mutations key by
--      booking_rooms.id; no composite (booking_id, room_id) lookups
--      anywhere; totals/status-CASE/analytics/views are per-row and
--      correct with a rejoined room = two stays).
--   2. The Add Room dialog defaulted to the booking's ORIGINAL span,
--      so the guard correctly blocked against the released room's own
--      consumed nights and the old error named no conflicting row.
--      Client half: defaults now today → latest BLOCKING-row
--      checkout; the guard's error is surfaced verbatim.
--
-- THE CONSTRAINT — one designed constraint serving both purposes:
--   EXCLUDE USING gist (room_id WITH =, daterange(check_in,
--   COALESCE(actual_checkout_date, check_out_date), '[)') WITH &&)
--   WHERE status IN ('confirmed','checked_in')
--   • keeps uq's accidental-duplicate protection in its CORRECT
--     form: two ACTIVE rows for one room can never overlap — same
--     booking or across bookings;
--   • permits released-row + new-active-row (the BK-1644 rebooking)
--     AND legitimate split stays (same room, disjoint dates);
--   • STRUCTURALLY closes the concurrent-insert window in
--     create_booking_with_rooms / add_room_to_booking — two
--     simultaneous inserts for overlapping spans now collide on the
--     constraint, not just the check-then-insert guards (which stay
--     as the friendly-error layer).
--   Viability was verified before proposing: ZERO overlapping ACTIVE
--   pairs among 96 live rows (the pre-launch test-data overlaps are
--   all terminal and outside the constraint's scope); btree_gist
--   already installed.
--
-- STANDING ITEMS RETIRED BY THIS MIGRATION:
--   • nights gap #5 — add_room_to_booking no longer trusts p_nights
--     (the last client-trusted nights value anywhere);
--   • "GiST EXCLUDE deferred to test-data cleanup" — applied; the
--     blocker assumption was stale;
--   • "concurrent-insert window the guards can't close" — closed
--     structurally by the constraint.
--
-- NOTE: p_room_status is trusted by the INSERT; verified single call
-- site app-wide (services/bookingsService.ts) hardcoding 'confirmed'.
-- A direct caller passing a terminal status would create an
-- unguarded historical row — theoretical, no app path.
-- =============================================================

-- ── 1. Constraint swap ──
BEGIN;

ALTER TABLE public.booking_rooms
  DROP CONSTRAINT uq_booking_room;

ALTER TABLE public.booking_rooms
  ADD CONSTRAINT excl_booking_rooms_active_overlap
  EXCLUDE USING gist (
    room_id WITH =,
    daterange(check_in_date, COALESCE(actual_checkout_date, check_out_date), '[)') WITH &&
  ) WHERE (status IN ('confirmed', 'checked_in'));

COMMENT ON TABLE public.booking_rooms
  IS 'Per-room stay records for a booking. Multiple rows per room per booking are allowed when earlier rows are terminal (cancelled/checked_out/checked_out_early) — a released room can rejoin its booking. Active rows are overlap-protected per room by excl_booking_rooms_active_overlap. Financial unit (total_amount, paid_amount) remains on bookings.';

COMMIT;

-- ── 2. add_room_to_booking (span guard + derived nights + informative error) ──

CREATE OR REPLACE FUNCTION public.add_room_to_booking(p_booking_id uuid, p_room_id uuid, p_check_in_date date, p_check_out_date date, p_nights smallint, p_category text, p_rate numeric, p_room_status booking_status)
 RETURNS uuid
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_room_row_id      UUID;
  v_physical_status  public.room_status;
  v_nights           SMALLINT;
  v_ref              TEXT;
  v_from             DATE;
  v_until            DATE;
  v_cstatus          TEXT;
BEGIN
  -- Span guard + server-derived nights (2026-09-05): p_nights is IGNORED —
  -- the last RPC that trusted a client nights value (standing gap #5, from
  -- BK-1400). Signature keeps the parameter so no DROP/re-GRANT is needed.
  IF p_check_out_date <= p_check_in_date THEN
    RAISE EXCEPTION 'add_room_to_booking: check_out_date must be after check_in_date (got % to %).',
      p_check_in_date, p_check_out_date;
  END IF;

  v_nights := (p_check_out_date - p_check_in_date)::smallint;

  -- Overlap guard (canonical semantics, unchanged): blocking rows are
  -- confirmed/checked_in only; COALESCE(actual, scheduled); half-open [).
  -- Own-booking rows deliberately INCLUDED — the booking's own still-active
  -- row for the same room must block a duplicate add; its released rows are
  -- excluded by status, which is what lets a released room REJOIN (BK-1644).
  -- Error now names the conflicting booking + actual covered range.
  SELECT b.booking_ref, x.check_in_date,
         COALESCE(x.actual_checkout_date, x.check_out_date), x.status::text
  INTO   v_ref, v_from, v_until, v_cstatus
  FROM   public.booking_rooms x
  JOIN   public.bookings b ON b.id = x.booking_id
  WHERE  x.room_id = p_room_id
    AND  x.status IN ('confirmed','checked_in')
    AND  daterange(x.check_in_date, COALESCE(x.actual_checkout_date, x.check_out_date), '[)')
      && daterange(p_check_in_date, p_check_out_date, '[)')
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'Room % is unavailable for % – %: booking % covers % – % (%).',
      (SELECT room_number FROM public.rooms WHERE id = p_room_id),
      p_check_in_date, p_check_out_date, v_ref, v_from, v_until, v_cstatus;
  END IF;

  INSERT INTO public.booking_rooms (
    booking_id, room_id, check_in_date, check_out_date, nights,
    room_category, booking_rate, status, confirmed_at, checked_in_at
  ) VALUES (
    p_booking_id, p_room_id, p_check_in_date, p_check_out_date, v_nights,
    p_category, p_rate, p_room_status, NOW(),
    CASE WHEN p_room_status = 'checked_in' THEN NOW() ELSE NULL END
  ) RETURNING id INTO v_room_row_id;

  PERFORM public.update_booking_total(p_booking_id);

  v_physical_status := CASE p_room_status
    WHEN 'confirmed'  THEN 'reserved'::public.room_status
    WHEN 'checked_in' THEN 'occupied'::public.room_status
    ELSE 'reserved'::public.room_status END;

  UPDATE public.rooms SET status = v_physical_status, updated_at = NOW()
  WHERE id = p_room_id;

  RETURN v_room_row_id;
END;
$function$;

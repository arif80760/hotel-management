-- =============================================================
-- 2026-08-19-sms-one-sent-per-booking.sql
-- ONE confirmation SMS per booking — partial unique index backstop.
--
-- RECORD OF LIVE STATE — applied in the Supabase SQL editor on
-- 2026-08-19. SQL below is VERBATIM what was applied.
--
-- The send route checks sms_log for an existing status='sent' row for
-- the booking and skips with reason 'already_sent' (logging the skip).
-- This index makes the rule unbypassable at the DB level: only ONE
-- 'sent' row can ever exist per booking. Partial on status='sent', so
-- failed/skipped attempts can repeat freely and the first successful
-- send still works after earlier failures (e.g. the Alpha 417
-- insufficient-balance episode on booking a08bd7ae…).
--
-- KNOWN NARROW RACE (accepted): two truly simultaneous requests could
-- both pass the route's check and both reach Alpha before either logs;
-- the index then fails the SECOND 'sent' insert (23505 → surfaced as
-- log_error in the response), guaranteeing one ROW, not one delivered
-- message, in that sub-second window. Closing it fully would need an
-- insert-first-send-after redesign — not justified for a single desk.
-- =============================================================

CREATE UNIQUE INDEX sms_log_one_sent_per_booking
  ON public.sms_log (booking_id)
  WHERE status = 'sent';

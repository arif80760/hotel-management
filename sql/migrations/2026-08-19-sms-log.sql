-- =============================================================
-- 2026-08-19-sms-log.sql
-- SMS delivery log for booking confirmation messages.
--
-- RECORD OF LIVE STATE — applied and verified in the Supabase SQL
-- editor on 2026-08-19 (alongside rate_periods). SQL below is
-- VERBATIM what was applied.
--
-- DESIGN (Feature 3, booking confirmation SMS):
--   • The desk reads this table to see what didn't send — every send
--     attempt is logged with status 'sent' | 'failed' | 'skipped' and
--     the provider's raw JSON response (Alpha SMS / sms.bd:
--     {"error":0,"msg":...,"data":{"request_id":N}}; error!==0 = fail;
--     request_id supports their delivery-report endpoint later).
--   • segments records the Unicode segment count (70 chars single /
--     67 per concatenated part) — the BTRC-mandated ≥70%-Bangla
--     template runs 2–3 segments, so cost stays visible per message.
--   • RLS: authenticated may READ; NO insert/update/delete policies —
--     only the server route (service role, bypasses RLS) writes.
--     SMS sending is fire-and-forget AFTER booking creation; a send
--     failure never fails or delays a booking.
-- =============================================================

CREATE TABLE public.sms_log (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id        uuid REFERENCES public.bookings(id) ON DELETE SET NULL,
  phone             text NOT NULL,
  message           text NOT NULL,
  segments          smallint NOT NULL DEFAULT 1,   -- Unicode segment count → cost visibility
  status            text NOT NULL,                 -- 'sent' | 'failed' | 'skipped'
  provider_response jsonb,
  created_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.sms_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated can read sms_log"
  ON public.sms_log FOR SELECT TO authenticated USING (true);

-- =============================================================
-- 2026-08-20-rls-hardening.sql
-- Financial/personnel RLS hardening — staff-token write surface.
--
-- RECORD OF LIVE STATE — applied in the Supabase SQL editor on
-- 2026-08-20. SQL below is what was applied.
--
-- AUDIT FINDING THAT REFRAMED THIS TASK: the long-standing belief
-- "staff tokens can SELECT account_transactions directly" was NEVER
-- true — the ledger has admin-only policies on ALL FOUR verbs, and
-- account_balances is a security_invoker VIEW that inherits them
-- (staff get zero rows). accounts (SELECT admin-only, writes deny)
-- and loans (admin-only, all verbs) were likewise already locked.
-- The REAL staff-token gaps, closed here:
--   • payments UPDATE was `true` (any staff could rewrite any
--     payment's amount/method; zero legitimate client-side UPDATEs
--     exist — recordPayment only INSERTs)
--   • refunds UPDATE was `true` (status flips are an admin decision;
--     disburse_refund is SECURITY DEFINER and unaffected — but see
--     the deny_refund NOTE below)
--   • day_closes INSERT was `true` (any staff could close a day and
--     thereby freeze the ledger via the immutability trigger)
--   • expense_categories INSERT/UPDATE were `true` (staff could
--     reclassify category KINDS — the exact P&L-poisoning class
--     fixed on 2026-08-18 for 'adjustment')
--   • guests DELETE was `true`
--   • anon held blanket table grants (RLS-denied, but zero need);
--     authenticated held TRUNCATE/TRIGGER/REFERENCES everywhere
--     (TRUNCATE is NOT subject to RLS — unreachable via PostgREST,
--     revoked on principle)
--
-- DELIBERATELY UNTOUCHED: payments/refunds INSERT (front-desk
-- recordPayment inserts payments; cancel_booking_room is SECURITY
-- INVOKER and inserts refunds in the caller's context — tightening
-- INSERT would break staff cancels), bookings/booking_rooms/rooms
-- (operational), sms_log SELECT (desk sees send status; guest phones
-- are already visible via guests).
--
-- ASSISTANT: unaffected structurally — the nine v_* views execute
-- with owner (postgres) rights, so table RLS never applies to them;
-- the boundary remains the assistant_ro/assistant_staff_ro grants.
-- Verified post-apply 2026-08-20: assistant_ro → v_revenue OK (534
-- rows), assistant_staff_ro → v_room_status OK (53 rows), v_revenue
-- correctly DENIED.
--
-- KNOWN REGRESSION (flagged at verification, decision pending):
-- deny_refund is SECURITY INVOKER, so its UPDATE refunds now matches
-- ZERO rows for staff (silent no-op) — while the neighbouring
-- Mark Disbursed button (disburse_refund, SECURITY DEFINER) still
-- works for staff. The Deny/Disburse buttons in the Timeline modal
-- are NOT admin-gated in the UI. Fix options: ALTER FUNCTION
-- deny_refund SECURITY DEFINER (restores parity) or gate both
-- buttons admin-only (tightens product behaviour).
--
-- FOLLOW-UP NOT YET APPLIED: the same INSERT/UPDATE→admin-only
-- pattern for expense_items and revenue_categories (was left as a
-- comment in the reviewed block; SQL sent separately).
-- =============================================================

DROP POLICY "Authenticated can update payments" ON public.payments;
CREATE POLICY "Payments update — admin only" ON public.payments
  FOR UPDATE TO authenticated USING (is_admin()) WITH CHECK (is_admin());

DROP POLICY "Authenticated can update refunds" ON public.refunds;
CREATE POLICY "Refunds update — admin only" ON public.refunds
  FOR UPDATE TO authenticated USING (is_admin()) WITH CHECK (is_admin());

DROP POLICY "day_closes_insert_authenticated" ON public.day_closes;
CREATE POLICY "Day close — admin only" ON public.day_closes
  FOR INSERT TO authenticated WITH CHECK (is_admin());

DROP POLICY "Authenticated can insert expense_categories" ON public.expense_categories;
DROP POLICY "Authenticated can update expense_categories" ON public.expense_categories;
CREATE POLICY "Expense categories write — admin only" ON public.expense_categories
  FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());
CREATE POLICY "Expense categories read — authenticated" ON public.expense_categories
  FOR SELECT TO authenticated USING (true);

DROP POLICY "Authenticated can delete guests" ON public.guests;
CREATE POLICY "Guests delete — admin only" ON public.guests
  FOR DELETE TO authenticated USING (is_admin());

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
REVOKE TRUNCATE, TRIGGER, REFERENCES ON ALL TABLES IN SCHEMA public FROM authenticated;

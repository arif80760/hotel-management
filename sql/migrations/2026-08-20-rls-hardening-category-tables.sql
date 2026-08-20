-- =============================================================
-- 2026-08-20-rls-hardening-category-tables.sql
-- Follow-up to 2026-08-20-rls-hardening.sql: the same write-lock
-- for expense_items and revenue_categories (left out of the first
-- block by omission — the pattern was a comment, not SQL).
--
-- RECORD OF LIVE STATE — applied in the Supabase SQL editor on
-- 2026-08-20 and verified via pg_policies the same day.
--
-- WHY: both tables had INSERT/UPDATE `true` for authenticated —
-- staff could rename/reshape revenue and expense-item taxonomies
-- that admin reports group by. Same class as the expense_categories
-- kind-reclassification risk closed in the first block.
--
-- DUPLICATE-POLICY NOTE: both tables carried a pre-existing
-- "Authenticated can read ..." SELECT policy, so the CREATEs below
-- initially produced duplicate permissive SELECT policies
-- (functionally harmless — permissive policies OR together). The old
-- "Authenticated can read expense_items / revenue_categories"
-- policies were dropped live; verified 2026-08-20: each table now
-- has exactly ONE SELECT policy (the new-convention name) plus the
-- admin-only ALL policy. The matching duplicate on
-- expense_categories from the first block
-- ("Authenticated can read expense_categories") is dropped by the
-- statement at the end of this file.
-- =============================================================

DROP POLICY "Authenticated can insert expense_items" ON public.expense_items;
DROP POLICY "Authenticated can update expense_items" ON public.expense_items;
CREATE POLICY "Expense items write — admin only" ON public.expense_items
  FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());
CREATE POLICY "Expense items read — authenticated" ON public.expense_items
  FOR SELECT TO authenticated USING (true);

DROP POLICY "Authenticated can insert revenue_categories" ON public.revenue_categories;
DROP POLICY "Authenticated can update revenue_categories" ON public.revenue_categories;
CREATE POLICY "Revenue categories write — admin only" ON public.revenue_categories
  FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());
CREATE POLICY "Revenue categories read — authenticated" ON public.revenue_categories
  FOR SELECT TO authenticated USING (true);

-- Cleanup of the first block's duplicate SELECT policy on
-- expense_categories (old-convention name dropped, new name kept):
DROP POLICY "Authenticated can read expense_categories" ON public.expense_categories;

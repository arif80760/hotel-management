-- =============================================================
-- 2026-07-31-expense-category-system-key.sql
-- Stable machine keys for system-relied expense categories.
--
-- RECORD OF LIVE STATE — applied in the Supabase SQL editor on 2026-07-31
-- (apply-first). Committed for history; idempotent (IF NOT EXISTS +
-- null-guarded UPDATEs). At apply time each UPDATE matched exactly one row.
--
-- WHY:
--   Category display names are becoming freely user-renameable, so no code
--   may resolve a category by name. system_key is the stable identifier for
--   the two categories the app depends on:
--     'salary'        — payroll payments (PayrollClient)
--     'remuneration'  — director remuneration (resolveRemunerationCategoryId)
--   Client-side, resolution goes through getExpenseCategoryBySystemKey(),
--   which matches REGARDLESS of is_active. The payroll "Salary" auto-create
--   fallback was removed the same day (name is UNIQUE — a blind insert on a
--   miss would throw or mint a duplicate category); a missing key now
--   surfaces a clear error instead.
-- =============================================================

ALTER TABLE public.expense_categories
  ADD COLUMN IF NOT EXISTS system_key text;

COMMENT ON COLUMN public.expense_categories.system_key IS
  'Stable machine identifier (''salary'', ''remuneration''); NULL for ordinary categories. Code must resolve system categories by this key, never by name.';

-- Unique only where set — ordinary categories all carry NULL.
CREATE UNIQUE INDEX IF NOT EXISTS expense_categories_system_key_key
  ON public.expense_categories (system_key)
  WHERE system_key IS NOT NULL;

-- Tag the two system categories (idempotent: only rows still untagged).
UPDATE public.expense_categories
SET    system_key = 'salary'
WHERE  name = 'Salary'
  AND  system_key IS NULL;

UPDATE public.expense_categories
SET    system_key = 'remuneration'
WHERE  kind = 'remuneration'
  AND  system_key IS NULL;

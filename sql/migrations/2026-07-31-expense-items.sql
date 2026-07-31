-- =============================================================
-- 2026-07-31-expense-items.sql
-- Expense items — per-category itemisation of expenses.
--
-- RECORD OF LIVE STATE — applied in the Supabase SQL editor on 2026-07-31
-- (apply-first). Committed for history; idempotent throughout
-- (IF NOT EXISTS / DROP POLICY IF EXISTS / guarded trigger DO block).
-- SQL below is VERBATIM as applied live.
--
-- WHAT:
--   public.expense_items — named items inside an expense category
--   (e.g. "Aerosol" under Cleaning), optionally linked to an
--   inventory_items row. account_transactions.expense_item_id (nullable,
--   ON DELETE RESTRICT) tags an expense with its item; all pre-existing
--   expenses carry NULL.
--
-- LIFECYCLE:
--   Per-category name uniqueness via expense_items_cat_name_uidx on
--   (category_id, lower(trim(name))). No DELETE policy — deactivate-only
--   (is_active = false), matching expense_categories; both FKs RESTRICT.
--   updated_at maintained by trg_expense_items_updated_at when the
--   fn_set_updated_at helper exists (that helper is already recorded in
--   CLAUDE.md's deferred schema-drift backfill list — consistent with
--   existing documentation, not a new finding).
--
-- CLIENT: services/expenseItemsService.ts. The inventory link is
-- display/metadata only for now — it does NOT drive the purchase seam
-- (auto-opening the stock panel is a later task gated on wrapping the
-- expense + movement writes in one RPC).
-- =============================================================

CREATE TABLE IF NOT EXISTS public.expense_items (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name              TEXT NOT NULL,
  category_id       UUID NOT NULL REFERENCES public.expense_categories(id) ON DELETE RESTRICT,
  inventory_item_id UUID     NULL REFERENCES public.inventory_items(id)    ON DELETE RESTRICT,
  is_active         BOOLEAN NOT NULL DEFAULT true,
  note              TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by        UUID,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_expense_items_name CHECK (length(trim(name)) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS expense_items_cat_name_uidx
  ON public.expense_items (category_id, lower(trim(name)));

CREATE INDEX IF NOT EXISTS expense_items_category_idx  ON public.expense_items (category_id);
CREATE INDEX IF NOT EXISTS expense_items_inventory_idx ON public.expense_items (inventory_item_id)
  WHERE inventory_item_id IS NOT NULL;

ALTER TABLE public.account_transactions
  ADD COLUMN IF NOT EXISTS expense_item_id UUID
  REFERENCES public.expense_items(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS account_transactions_expense_item_idx
  ON public.account_transactions (expense_item_id) WHERE expense_item_id IS NOT NULL;

ALTER TABLE public.expense_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated can read expense_items"   ON public.expense_items;
DROP POLICY IF EXISTS "Authenticated can insert expense_items" ON public.expense_items;
DROP POLICY IF EXISTS "Authenticated can update expense_items" ON public.expense_items;

CREATE POLICY "Authenticated can read expense_items"
  ON public.expense_items FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated can insert expense_items"
  ON public.expense_items FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated can update expense_items"
  ON public.expense_items FOR UPDATE TO authenticated USING (true);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname='public' AND p.proname='fn_set_updated_at') THEN
    DROP TRIGGER IF EXISTS trg_expense_items_updated_at ON public.expense_items;
    CREATE TRIGGER trg_expense_items_updated_at
      BEFORE UPDATE ON public.expense_items
      FOR EACH ROW EXECUTE FUNCTION public.fn_set_updated_at();
  END IF;
END $$;

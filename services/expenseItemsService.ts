// services/expenseItemsService.ts
//
// ─── EXPENSE ITEMS SERVICE ───────────────────────────────────────────────────
//
// Reads + writes for the expense_items reference table (recorded in
// sql/migrations/2026-07-31-expense-items.sql; applied live 2026-07-31).
//
//   create table public.expense_items (
//     id                uuid        primary key default gen_random_uuid(),
//     name              text        not null,
//     category_id       uuid        not null references expense_categories(id) on delete restrict,
//     inventory_item_id uuid        references inventory_items(id) on delete restrict,  -- nullable
//     is_active         boolean     not null default true,
//     note              text,
//     created_at        timestamptz not null default now(),
//     created_by        uuid,
//     updated_at        timestamptz not null default now()   -- trg_expense_items_updated_at (live)
//   );
//   -- unique index on (category_id, lower(trim(name))) — per-category name uniqueness
//
// Lifecycle (mirrors expense_categories):
//   - Rename / reassign category / set-clear inventory link allowed.
//   - Soft-deactivate via is_active = false; never DELETE (no delete RLS
//     policy exists, and account_transactions.expense_item_id is
//     ON DELETE RESTRICT).
//
// Duplicate names: the DB enforces uniqueness per category on
// lower(trim(name)). Every write that can collide catches 23505 and throws
// a clear user-facing message — a raw constraint violation must never
// reach the UI.
//
// ─────────────────────────────────────────────────────────────────────────────

import { supabase } from "@/lib/supabase";

// ─────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────

export type ExpenseItem = {
  id:              string;
  name:            string;
  categoryId:      string;
  /** Optional link to an inventory item; null for plain expense items. */
  inventoryItemId: string | null;
  isActive:        boolean;
  note:            string | null;
  createdAt:       string;
  createdBy:       string | null;
  updatedAt:       string;
};

type ExpenseItemRow = {
  id:                string;
  name:              string;
  category_id:       string;
  inventory_item_id: string | null;
  is_active:         boolean;
  note:              string | null;
  created_at:        string;
  created_by:        string | null;
  updated_at:        string;
};

/** Single source of truth for the selected columns — one place to extend,
 *  referenced by EVERY select so a future column cannot be missed. */
const ITEM_COLUMNS =
  "id, name, category_id, inventory_item_id, is_active, note, created_at, created_by, updated_at";

function mapItem(r: ExpenseItemRow): ExpenseItem {
  return {
    id:              r.id,
    name:            r.name,
    categoryId:      r.category_id,
    inventoryItemId: r.inventory_item_id ?? null,
    isActive:        r.is_active,
    note:            r.note ?? null,
    createdAt:       r.created_at,
    createdBy:       r.created_by,
    updatedAt:       r.updated_at,
  };
}

/** 23505 on (category_id, lower(trim(name))) → clear user-facing message. */
function duplicateNameError(name: string): Error {
  return new Error(
    `An item named "${name.trim()}" already exists in this category. ` +
    `Use the existing item or pick a different name.`,
  );
}

// ─────────────────────────────────────────────────────────────
// READ
// ─────────────────────────────────────────────────────────────

/**
 * List all expense items, active first then inactive, alphabetical within
 * each group. Callers group by categoryId for display.
 */
export async function getExpenseItems(): Promise<ExpenseItem[]> {
  const { data, error } = await supabase
    .from("expense_items")
    .select(ITEM_COLUMNS)
    .order("is_active", { ascending: false })
    .order("name",      { ascending: true });

  if (error) {
    console.error("──────────── [getExpenseItems] FAILED ────────────");
    console.error("  message:", error.message, "| code:", error.code);
    throw new Error(`[getExpenseItems] ${error.message}`);
  }

  return ((data ?? []) as ExpenseItemRow[]).map(mapItem);
}

// ─────────────────────────────────────────────────────────────
// WRITE
// ─────────────────────────────────────────────────────────────

/**
 * Create a new expense item inside a category, optionally linked to an
 * inventory item. Name is trimmed; per-category uniqueness is enforced by
 * the DB index and surfaced as a readable error.
 */
export async function createExpenseItem(
  name: string,
  categoryId: string,
  inventoryItemId?: string | null,
): Promise<ExpenseItem> {
  const trimmed = name.trim();
  if (!trimmed)    throw new Error("[createExpenseItem] Name is required.");
  if (!categoryId) throw new Error("[createExpenseItem] Category is required.");

  // Record who created it (best-effort).
  const { data: authData } = await supabase.auth.getUser();
  const createdBy = authData?.user?.id ?? null;

  const { data, error } = await supabase
    .from("expense_items")
    .insert({
      name:              trimmed,
      category_id:       categoryId,
      inventory_item_id: inventoryItemId ?? null,
      created_by:        createdBy,
    })
    .select(ITEM_COLUMNS)
    .single();

  if (error || !data) {
    if (error?.code === "23505") throw duplicateNameError(trimmed);
    console.error("──────────── [createExpenseItem] FAILED ────────────");
    console.error("  message:", error?.message, "| code:", error?.code);
    throw new Error(`[createExpenseItem] ${error?.message ?? "no row returned"}`);
  }

  return mapItem(data as ExpenseItemRow);
}

/**
 * Rename an item. Can collide with another item in the SAME category —
 * surfaced as a readable duplicate-name error.
 */
export async function updateExpenseItemName(id: string, newName: string): Promise<ExpenseItem> {
  const trimmed = newName.trim();
  if (!trimmed) throw new Error("[updateExpenseItemName] Name is required.");

  const { data, error } = await supabase
    .from("expense_items")
    .update({ name: trimmed })
    .eq("id", id)
    .select(ITEM_COLUMNS)
    .single();

  if (error || !data) {
    if (error?.code === "23505") throw duplicateNameError(trimmed);
    console.error("──────────── [updateExpenseItemName] FAILED ────────────");
    console.error("  message:", error?.message, "| code:", error?.code);
    throw new Error(`[updateExpenseItemName] ${error?.message ?? "no row returned"}`);
  }

  return mapItem(data as ExpenseItemRow);
}

/**
 * Move an item to a different category. Past expenses keep their
 * expense_item_id — only future grouping/labeling changes. Can collide with
 * a same-named item in the target category (readable error).
 */
export async function updateExpenseItemCategory(id: string, categoryId: string): Promise<ExpenseItem> {
  if (!categoryId) throw new Error("[updateExpenseItemCategory] Category is required.");

  const { data, error } = await supabase
    .from("expense_items")
    .update({ category_id: categoryId })
    .eq("id", id)
    .select(ITEM_COLUMNS)
    .single();

  if (error || !data) {
    if (error?.code === "23505") {
      throw new Error(
        "The target category already has an item with this name. " +
        "Rename one of them first, then move the item.",
      );
    }
    console.error("──────────── [updateExpenseItemCategory] FAILED ────────────");
    console.error("  message:", error?.message, "| code:", error?.code);
    throw new Error(`[updateExpenseItemCategory] ${error?.message ?? "no row returned"}`);
  }

  return mapItem(data as ExpenseItemRow);
}

/**
 * Set (uuid) or clear (null) the item's inventory link. Display/metadata
 * only for now — the inventory purchase seam is NOT driven by this link
 * (auto-opening the stock panel is a later task gated on a combined RPC).
 */
export async function updateExpenseItemInventoryLink(
  id: string,
  inventoryItemId: string | null,
): Promise<ExpenseItem> {
  const { data, error } = await supabase
    .from("expense_items")
    .update({ inventory_item_id: inventoryItemId })
    .eq("id", id)
    .select(ITEM_COLUMNS)
    .single();

  if (error || !data) {
    console.error("──────────── [updateExpenseItemInventoryLink] FAILED ────────────");
    console.error("  message:", error?.message, "| code:", error?.code);
    throw new Error(`[updateExpenseItemInventoryLink] ${error?.message ?? "no row returned"}`);
  }

  return mapItem(data as ExpenseItemRow);
}

/**
 * Toggle is_active. Soft-deactivation: past expenses keep their FK
 * reference; the item just stops appearing in the entry-form picker.
 * There is deliberately NO delete function — no delete RLS policy exists
 * and account_transactions.expense_item_id is ON DELETE RESTRICT.
 */
export async function setExpenseItemActive(id: string, isActive: boolean): Promise<ExpenseItem> {
  const { data, error } = await supabase
    .from("expense_items")
    .update({ is_active: isActive })
    .eq("id", id)
    .select(ITEM_COLUMNS)
    .single();

  if (error || !data) {
    console.error("──────────── [setExpenseItemActive] FAILED ────────────");
    console.error("  message:", error?.message, "| code:", error?.code);
    throw new Error(`[setExpenseItemActive] ${error?.message ?? "no row returned"}`);
  }

  return mapItem(data as ExpenseItemRow);
}

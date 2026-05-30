// services/expenseCategoriesService.ts
//
// ─── EXPENSE CATEGORIES SERVICE ──────────────────────────────────────────────
//
// Reads + writes for the expense_categories reference table.
// Spec: docs/architecture/accounts.md §7 (Dynamic Categories)
//
// ─── SCHEMA (migrated 2026-05-30) ────────────────────────────────────────────
//
//   create table public.expense_categories (
//     id         uuid        primary key default gen_random_uuid(),
//     name       text        not null unique,
//     is_active  boolean     not null default true,
//     created_at timestamptz not null default now(),
//     created_by uuid,
//     updated_at timestamptz not null default now()
//   );
//
// Lifecycle:
//   - Rename allowed (typo fixes).
//   - Soft-deactivate via is_active = false; never DELETE (FK ON DELETE RESTRICT
//     from account_transactions.category_id prevents physical delete).
//
// Inline creation (per §7): when typing a category name in the expense form
// that doesn't exist yet, the form calls createExpenseCategory() and uses the
// returned row immediately. The "manage categories" modal uses the same API.
//
// ─────────────────────────────────────────────────────────────────────────────

import { supabase } from "@/lib/supabase";

// ─────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────

export type ExpenseCategory = {
  id:         string;
  name:       string;
  isActive:   boolean;
  createdAt:  string;
  createdBy:  string | null;
  updatedAt:  string;
};

type ExpenseCategoryRow = {
  id:         string;
  name:       string;
  is_active:  boolean;
  created_at: string;
  created_by: string | null;
  updated_at: string;
};

function mapCategory(r: ExpenseCategoryRow): ExpenseCategory {
  return {
    id:        r.id,
    name:      r.name,
    isActive:  r.is_active,
    createdAt: r.created_at,
    createdBy: r.created_by,
    updatedAt: r.updated_at,
  };
}

// ─────────────────────────────────────────────────────────────
// READ
// ─────────────────────────────────────────────────────────────

/**
 * List all expense categories, active first then inactive, alphabetical
 * within each group.
 */
export async function getExpenseCategories(): Promise<ExpenseCategory[]> {
  const { data, error } = await supabase
    .from("expense_categories")
    .select("id, name, is_active, created_at, created_by, updated_at")
    .order("is_active", { ascending: false })
    .order("name",       { ascending: true });

  if (error) {
    console.error("──────────── [getExpenseCategories] FAILED ────────────");
    console.error("  message:", error.message, "| code:", error.code);
    throw new Error(`[getExpenseCategories] ${error.message}`);
  }

  return ((data ?? []) as ExpenseCategoryRow[]).map(mapCategory);
}

// ─────────────────────────────────────────────────────────────
// WRITE
// ─────────────────────────────────────────────────────────────

/**
 * Create a new expense category. Returns the inserted row. The name is
 * trimmed; the DB's UNIQUE constraint enforces no duplicates (case-sensitive
 * — relying on user discipline / autocomplete to avoid case-variant
 * duplicates).
 *
 * Throws if the name is empty or a duplicate.
 */
export async function createExpenseCategory(name: string): Promise<ExpenseCategory> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("[createExpenseCategory] Name is required.");

  // Record who created it (best-effort).
  const { data: authData } = await supabase.auth.getUser();
  const createdBy = authData?.user?.id ?? null;

  const { data, error } = await supabase
    .from("expense_categories")
    .insert({ name: trimmed, created_by: createdBy })
    .select("id, name, is_active, created_at, created_by, updated_at")
    .single();

  if (error || !data) {
    console.error("──────────── [createExpenseCategory] FAILED ────────────");
    console.error("  message:", error?.message, "| code:", error?.code);
    throw new Error(`[createExpenseCategory] ${error?.message ?? "no row returned"}`);
  }

  return mapCategory(data as ExpenseCategoryRow);
}

/**
 * Rename a category. Triggers the touch_updated_at trigger to update
 * updated_at.
 */
export async function updateExpenseCategoryName(id: string, newName: string): Promise<ExpenseCategory> {
  const trimmed = newName.trim();
  if (!trimmed) throw new Error("[updateExpenseCategoryName] Name is required.");

  const { data, error } = await supabase
    .from("expense_categories")
    .update({ name: trimmed })
    .eq("id", id)
    .select("id, name, is_active, created_at, created_by, updated_at")
    .single();

  if (error || !data) {
    console.error("──────────── [updateExpenseCategoryName] FAILED ────────────");
    console.error("  message:", error?.message, "| code:", error?.code);
    throw new Error(`[updateExpenseCategoryName] ${error?.message ?? "no row returned"}`);
  }

  return mapCategory(data as ExpenseCategoryRow);
}

/**
 * Toggle is_active. Soft-deactivation when set to false: past expenses
 * keep their FK reference intact; the category just stops appearing in
 * the entry form's autocomplete.
 */
export async function setExpenseCategoryActive(id: string, isActive: boolean): Promise<ExpenseCategory> {
  const { data, error } = await supabase
    .from("expense_categories")
    .update({ is_active: isActive })
    .eq("id", id)
    .select("id, name, is_active, created_at, created_by, updated_at")
    .single();

  if (error || !data) {
    console.error("──────────── [setExpenseCategoryActive] FAILED ────────────");
    console.error("  message:", error?.message, "| code:", error?.code);
    throw new Error(`[setExpenseCategoryActive] ${error?.message ?? "no row returned"}`);
  }

  return mapCategory(data as ExpenseCategoryRow);
}

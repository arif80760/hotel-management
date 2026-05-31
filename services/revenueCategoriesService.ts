// services/revenueCategoriesService.ts
//
// ─── REVENUE CATEGORIES SERVICE ──────────────────────────────────────────────
//
// Reads + writes for the revenue_categories reference table.
// Spec: docs/architecture/accounts.md §7 (Dynamic Categories).
// Mirror of expenseCategoriesService.ts — same shape, different table.
//
// ─── SCHEMA (migrated 2026-05-31) ────────────────────────────────────────────
//
//   create table public.revenue_categories (
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
//     from account_transactions.revenue_category_id prevents physical delete).
//
// Inline creation (per §7): when typing a category name in the revenue form
// that doesn't exist yet, the form calls createRevenueCategory() and uses the
// returned row immediately. The "manage categories" modal uses the same API.
//
// ─────────────────────────────────────────────────────────────────────────────

import { supabase } from "@/lib/supabase";

// ─────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────

export type RevenueCategory = {
  id:         string;
  name:       string;
  isActive:   boolean;
  createdAt:  string;
  createdBy:  string | null;
  updatedAt:  string;
};

type RevenueCategoryRow = {
  id:         string;
  name:       string;
  is_active:  boolean;
  created_at: string;
  created_by: string | null;
  updated_at: string;
};

function mapCategory(r: RevenueCategoryRow): RevenueCategory {
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
 * List all revenue categories, active first then inactive, alphabetical
 * within each group.
 */
export async function getRevenueCategories(): Promise<RevenueCategory[]> {
  const { data, error } = await supabase
    .from("revenue_categories")
    .select("id, name, is_active, created_at, created_by, updated_at")
    .order("is_active", { ascending: false })
    .order("name",       { ascending: true });

  if (error) {
    console.error("──────────── [getRevenueCategories] FAILED ────────────");
    console.error("  message:", error.message, "| code:", error.code);
    throw new Error(`[getRevenueCategories] ${error.message}`);
  }

  return ((data ?? []) as RevenueCategoryRow[]).map(mapCategory);
}

// ─────────────────────────────────────────────────────────────
// WRITE
// ─────────────────────────────────────────────────────────────

/**
 * Create a new revenue category. The name is trimmed; the DB's UNIQUE
 * constraint enforces no duplicates (case-sensitive — relying on user
 * discipline / autocomplete to avoid case-variant duplicates).
 *
 * Throws if the name is empty or a duplicate.
 */
export async function createRevenueCategory(name: string): Promise<RevenueCategory> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("[createRevenueCategory] Name is required.");

  const { data: authData } = await supabase.auth.getUser();
  const createdBy = authData?.user?.id ?? null;

  const { data, error } = await supabase
    .from("revenue_categories")
    .insert({ name: trimmed, created_by: createdBy })
    .select("id, name, is_active, created_at, created_by, updated_at")
    .single();

  if (error || !data) {
    console.error("──────────── [createRevenueCategory] FAILED ────────────");
    console.error("  message:", error?.message, "| code:", error?.code);
    throw new Error(`[createRevenueCategory] ${error?.message ?? "no row returned"}`);
  }

  return mapCategory(data as RevenueCategoryRow);
}

/**
 * Rename a category. Triggers the touch_updated_at trigger to update updated_at.
 */
export async function updateRevenueCategoryName(id: string, newName: string): Promise<RevenueCategory> {
  const trimmed = newName.trim();
  if (!trimmed) throw new Error("[updateRevenueCategoryName] Name is required.");

  const { data, error } = await supabase
    .from("revenue_categories")
    .update({ name: trimmed })
    .eq("id", id)
    .select("id, name, is_active, created_at, created_by, updated_at")
    .single();

  if (error || !data) {
    console.error("──────────── [updateRevenueCategoryName] FAILED ────────────");
    console.error("  message:", error?.message, "| code:", error?.code);
    throw new Error(`[updateRevenueCategoryName] ${error?.message ?? "no row returned"}`);
  }

  return mapCategory(data as RevenueCategoryRow);
}

/**
 * Toggle is_active. Soft-deactivation when set to false: past revenue rows
 * keep their FK reference intact; the category just stops appearing in
 * the entry form's autocomplete.
 */
export async function setRevenueCategoryActive(id: string, isActive: boolean): Promise<RevenueCategory> {
  const { data, error } = await supabase
    .from("revenue_categories")
    .update({ is_active: isActive })
    .eq("id", id)
    .select("id, name, is_active, created_at, created_by, updated_at")
    .single();

  if (error || !data) {
    console.error("──────────── [setRevenueCategoryActive] FAILED ────────────");
    console.error("  message:", error?.message, "| code:", error?.code);
    throw new Error(`[setRevenueCategoryActive] ${error?.message ?? "no row returned"}`);
  }

  return mapCategory(data as RevenueCategoryRow);
}

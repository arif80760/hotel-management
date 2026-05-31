// services/inventoryCategoriesService.ts
//
// ─── INVENTORY CATEGORIES SERVICE ────────────────────────────────────────────
//
// Reads + writes for the inventory_categories reference table.
// Spec: docs/architecture/inventory.md §3.1.
// Mirror of expenseCategoriesService / revenueCategoriesService.
//
// ─── SCHEMA (migrated 2026-05-31, Phase I-B) ─────────────────────────────────
//
//   create table public.inventory_categories (
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
//     from inventory_items.category_id prevents physical delete).
//
// ─────────────────────────────────────────────────────────────────────────────

import { supabase } from "@/lib/supabase";

// ─────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────

export type InventoryCategory = {
  id:         string;
  name:       string;
  isActive:   boolean;
  createdAt:  string;
  createdBy:  string | null;
  updatedAt:  string;
};

type InventoryCategoryRow = {
  id:         string;
  name:       string;
  is_active:  boolean;
  created_at: string;
  created_by: string | null;
  updated_at: string;
};

function mapCategory(r: InventoryCategoryRow): InventoryCategory {
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

export async function getInventoryCategories(): Promise<InventoryCategory[]> {
  const { data, error } = await supabase
    .from("inventory_categories")
    .select("id, name, is_active, created_at, created_by, updated_at")
    .order("is_active", { ascending: false })
    .order("name",       { ascending: true });

  if (error) {
    console.error("──────────── [getInventoryCategories] FAILED ────────────");
    console.error("  message:", error.message, "| code:", error.code);
    throw new Error(`[getInventoryCategories] ${error.message}`);
  }

  return ((data ?? []) as InventoryCategoryRow[]).map(mapCategory);
}

// ─────────────────────────────────────────────────────────────
// WRITE
// ─────────────────────────────────────────────────────────────

export async function createInventoryCategory(name: string): Promise<InventoryCategory> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("[createInventoryCategory] Name is required.");

  const { data: authData } = await supabase.auth.getUser();
  const createdBy = authData?.user?.id ?? null;

  const { data, error } = await supabase
    .from("inventory_categories")
    .insert({ name: trimmed, created_by: createdBy })
    .select("id, name, is_active, created_at, created_by, updated_at")
    .single();

  if (error || !data) {
    console.error("──────────── [createInventoryCategory] FAILED ────────────");
    console.error("  message:", error?.message, "| code:", error?.code);
    throw new Error(`[createInventoryCategory] ${error?.message ?? "no row returned"}`);
  }

  return mapCategory(data as InventoryCategoryRow);
}

export async function updateInventoryCategoryName(id: string, newName: string): Promise<InventoryCategory> {
  const trimmed = newName.trim();
  if (!trimmed) throw new Error("[updateInventoryCategoryName] Name is required.");

  const { data, error } = await supabase
    .from("inventory_categories")
    .update({ name: trimmed })
    .eq("id", id)
    .select("id, name, is_active, created_at, created_by, updated_at")
    .single();

  if (error || !data) {
    console.error("──────────── [updateInventoryCategoryName] FAILED ────────────");
    console.error("  message:", error?.message, "| code:", error?.code);
    throw new Error(`[updateInventoryCategoryName] ${error?.message ?? "no row returned"}`);
  }

  return mapCategory(data as InventoryCategoryRow);
}

export async function setInventoryCategoryActive(id: string, isActive: boolean): Promise<InventoryCategory> {
  const { data, error } = await supabase
    .from("inventory_categories")
    .update({ is_active: isActive })
    .eq("id", id)
    .select("id, name, is_active, created_at, created_by, updated_at")
    .single();

  if (error || !data) {
    console.error("──────────── [setInventoryCategoryActive] FAILED ────────────");
    console.error("  message:", error?.message, "| code:", error?.code);
    throw new Error(`[setInventoryCategoryActive] ${error?.message ?? "no row returned"}`);
  }

  return mapCategory(data as InventoryCategoryRow);
}

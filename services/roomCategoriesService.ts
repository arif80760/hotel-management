// services/roomCategoriesService.ts
//
// ─── ROOM CATEGORIES SERVICE ──────────────────────────────────────────────────
//
// Reads + writes for the room_categories reference table.
// Spec: migrations/2026-06-07-room-categories-table.sql (Stage A)
//       migrations/2026-06-07-room-category-enum-to-text.sql (Stage B)
//
// SLUG vs NAME
//   slug  — stable, lowercase, hyphenated key stored in rooms.category (FK).
//            Never changes after creation; history and FK integrity depend on it.
//            Generated from name at creation: "Junior Suite" → "junior-suite".
//   name  — editable display label shown in the UI.
//            Rename does NOT change the slug.
//
// Lifecycle:
//   - Soft-deactivate via is_active = false; never hard-delete (FK ON DELETE
//     RESTRICT from rooms.category prevents physical delete while rooms exist).
//   - sort_order is set at creation from the current max + 1; reorder is out
//     of scope for the MVP.
//
// ─────────────────────────────────────────────────────────────────────────────

import { supabase } from "@/lib/supabase";
import type { SupabaseClient } from "@supabase/supabase-js";

// ─────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────

export type RoomCategory = {
  id:         string;
  slug:       string;   // stable FK key: "single", "junior-suite", …
  name:       string;   // display label: "Single", "Junior Suite", …
  price:      number;   // base price per night (BDT)
  /**
   * Optional floor price per night (BDT). null = no floor.
   * Staff cannot book below it; admins can override with a confirm.
   */
  minRate:    number | null;
  sortOrder:  number;
  isActive:   boolean;
  createdAt:  string;
  updatedAt:  string;
};

type RoomCategoryRow = {
  id:         string;
  slug:       string;
  name:       string;
  price:      number;
  min_rate:   number | null;
  sort_order: number;
  is_active:  boolean;
  created_at: string;
  updated_at: string;
};

/** Single source of truth for the selected columns — kept in one place so a
 *  new column can't be added to some queries and missed by others. */
const CATEGORY_COLUMNS =
  "id, slug, name, price, min_rate, sort_order, is_active, created_at, updated_at";

function mapCategory(r: RoomCategoryRow): RoomCategory {
  return {
    id:        r.id,
    slug:      r.slug,
    name:      r.name,
    price:     r.price,
    minRate:   r.min_rate ?? null,
    sortOrder: r.sort_order,
    isActive:  r.is_active,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ─────────────────────────────────────────────────────────────
// SLUG HELPER
// ─────────────────────────────────────────────────────────────

/**
 * Derive a slug from a display name.
 * "Junior Suite" → "junior-suite"
 * "Deluxe+"     → "deluxe"
 */
export function slugifyCategory(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ─────────────────────────────────────────────────────────────
// READ
// ─────────────────────────────────────────────────────────────

/**
 * List all room categories ordered by sort_order (active first within order).
 */
export async function getRoomCategories(
  client: SupabaseClient = supabase,
): Promise<RoomCategory[]> {
  const { data, error } = await client
    .from("room_categories")
    .select(CATEGORY_COLUMNS)
    .order("sort_order", { ascending: true })
    .order("name",       { ascending: true });

  if (error) {
    console.error("──────────── [getRoomCategories] FAILED ────────────");
    console.error("  message:", error.message, "| code:", error.code);
    throw new Error(`[getRoomCategories] ${error.message}`);
  }

  return ((data ?? []) as RoomCategoryRow[]).map(mapCategory);
}

// ─────────────────────────────────────────────────────────────
// WRITE
// ─────────────────────────────────────────────────────────────

/**
 * Create a new room category with price.
 * slug is derived from name; throws on duplicate slug or empty name.
 * sort_order is set to max(existing) + 1 so new categories appear last.
 */
export async function createRoomCategory(
  name: string,
  price: number = 0,
  minRate: number | null = null,
): Promise<RoomCategory> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("[createRoomCategory] Name is required.");

  const slug = slugifyCategory(trimmed);
  if (!slug) throw new Error("[createRoomCategory] Could not derive a valid slug from the name.");

  if (price < 0) throw new Error("[createRoomCategory] Price cannot be negative.");
  if (minRate !== null && minRate < 0)
    throw new Error("[createRoomCategory] Minimum rate cannot be negative.");

  // Get current max sort_order
  const { data: maxRow } = await supabase
    .from("room_categories")
    .select("sort_order")
    .order("sort_order", { ascending: false })
    .limit(1)
    .single();

  const nextOrder = ((maxRow as RoomCategoryRow | null)?.sort_order ?? 0) + 1;

  const { data, error } = await supabase
    .from("room_categories")
    .insert({ slug, name: trimmed, price, min_rate: minRate, sort_order: nextOrder })
    .select(CATEGORY_COLUMNS)
    .single();

  if (error || !data) {
    console.error("──────────── [createRoomCategory] FAILED ────────────");
    console.error("  message:", error?.message, "| code:", error?.code);
    throw new Error(`[createRoomCategory] ${error?.message ?? "no row returned"}`);
  }

  return mapCategory(data as RoomCategoryRow);
}

/**
 * Rename a category's display label.
 * The slug is intentionally NOT changed — it is the stable FK key.
 */
export async function updateRoomCategoryName(id: string, newName: string): Promise<RoomCategory> {
  const trimmed = newName.trim();
  if (!trimmed) throw new Error("[updateRoomCategoryName] Name is required.");

  const { data, error } = await supabase
    .from("room_categories")
    .update({ name: trimmed })
    .eq("id", id)
    .select(CATEGORY_COLUMNS)
    .single();

  if (error || !data) {
    console.error("──────────── [updateRoomCategoryName] FAILED ────────────");
    console.error("  message:", error?.message, "| code:", error?.code);
    throw new Error(`[updateRoomCategoryName] ${error?.message ?? "no row returned"}`);
  }

  return mapCategory(data as RoomCategoryRow);
}

/**
 * Update a category's price.
 * New bookings will use this price; existing bookings are unaffected.
 */
export async function updateRoomCategoryPrice(id: string, newPrice: number): Promise<RoomCategory> {
  if (newPrice < 0) throw new Error("[updateRoomCategoryPrice] Price cannot be negative.");

  const { data, error } = await supabase
    .from("room_categories")
    .update({ price: newPrice })
    .eq("id", id)
    .select(CATEGORY_COLUMNS)
    .single();

  if (error || !data) {
    console.error("──────────── [updateRoomCategoryPrice] FAILED ────────────");
    console.error("  message:", error?.message, "| code:", error?.code);
    throw new Error(`[updateRoomCategoryPrice] ${error?.message ?? "no row returned"}`);
  }

  return mapCategory(data as RoomCategoryRow);
}

/**
 * Update a category's minimum booking rate (floor price).
 * Pass null to clear the floor (no minimum). Only affects new bookings —
 * existing bookings are never re-validated.
 */
export async function updateRoomCategoryMinRate(
  id: string,
  newMinRate: number | null,
): Promise<RoomCategory> {
  if (newMinRate !== null && newMinRate < 0)
    throw new Error("[updateRoomCategoryMinRate] Minimum rate cannot be negative.");

  const { data, error } = await supabase
    .from("room_categories")
    .update({ min_rate: newMinRate })
    .eq("id", id)
    .select(CATEGORY_COLUMNS)
    .single();

  if (error || !data) {
    console.error("──────────── [updateRoomCategoryMinRate] FAILED ────────────");
    console.error("  message:", error?.message, "| code:", error?.code);
    throw new Error(`[updateRoomCategoryMinRate] ${error?.message ?? "no row returned"}`);
  }

  return mapCategory(data as RoomCategoryRow);
}

/**
 * Toggle is_active.
 * Deactivating hides the category from the room-add/edit dropdown.
 * Existing rooms keep their FK reference intact.
 */
export async function setRoomCategoryActive(id: string, isActive: boolean): Promise<RoomCategory> {
  const { data, error } = await supabase
    .from("room_categories")
    .update({ is_active: isActive })
    .eq("id", id)
    .select(CATEGORY_COLUMNS)
    .single();

  if (error || !data) {
    console.error("──────────── [setRoomCategoryActive] FAILED ────────────");
    console.error("  message:", error?.message, "| code:", error?.code);
    throw new Error(`[setRoomCategoryActive] ${error?.message ?? "no row returned"}`);
  }

  return mapCategory(data as RoomCategoryRow);
}

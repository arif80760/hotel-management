// services/inventoryService.ts
//
// ─── INVENTORY SERVICE ──────────────────────────────────────────────────────
//
// Reads + writes for inventory items, movements, and assignments.
// Spec: docs/architecture/inventory.md (Phase I-A, commit 92f6ac5)
// Schema: sql/migrations/2026-05-31-inventory-schema.sql (Phase I-B)
//
// What's in this file:
//   - Items CRUD (list, get-by-id, create, update, set-active)
//   - Movements: all 5 types supported in code (purchase, issue, damage,
//     adjustment, transfer). Today only purchase + manual-purchase have
//     UI surfaces; issue/damage/transfer/adjustment get UI in a future
//     phase.
//   - Stock computation: SUM of all movements per item, signed by type.
//   - Assignment sync: when durable movements happen, this service
//     keeps inventory_assignments in sync (service-layer logic per
//     Day 22 design Option A).
//
// Returns flat data — names are resolved at the UI layer via lookup
// maps from getInventoryCategories + getRooms + getAllEmployees. Same
// pattern established in Day 21 lessons.
//
// ─────────────────────────────────────────────────────────────────────────────

import { supabase } from "@/lib/supabase";

// ─────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────

export type InventoryItemType = "consumable" | "durable";
export type InventoryItemUnit =
  | "piece" | "kg" | "gram" | "litre" | "millilitre"
  | "metre" | "set" | "box" | "other";
export type InventoryMovementType =
  | "purchase" | "issue" | "damage" | "adjustment" | "transfer";
export type InventoryAssignmentStatus = "in_service" | "damaged";

export type InventoryItem = {
  id:                 string;
  name:               string;
  categoryId:         string | null;
  type:               InventoryItemType;
  unit:               InventoryItemUnit;
  notes:              string | null;
  isActive:           boolean;
  lowStockThreshold:  number | null;
  createdAt:          string;
  createdBy:          string | null;
  updatedAt:          string;
};

export type InventoryMovement = {
  id:                            string;
  itemId:                        string;
  type:                          InventoryMovementType;
  quantity:                      number;       // always positive except for adjustment (signed)
  unitPrice:                     number | null;
  happenedAt:                    string;
  recordedBy:                    string | null;
  sourceAccountTransactionId:    string | null;
  issuedToEmployeeId:            string | null;
  fromRoomId:                    string | null;
  toRoomId:                      string | null;
  reasonNote:                    string | null;
  createdAt:                     string;
};

export type InventoryAssignment = {
  id:         string;
  itemId:     string;
  roomId:     string;
  quantity:   number;
  status:     InventoryAssignmentStatus;
  createdAt:  string;
  updatedAt:  string;
};

export type NewInventoryItem = {
  name:         string;
  categoryId?:  string;
  type:         InventoryItemType;
  unit:         InventoryItemUnit;
  notes?:       string;
};

// Purchase from expense (linked) or manual (unlinked)
export type NewPurchaseMovement = {
  itemId:                       string;
  quantity:                     number;          // > 0
  unitPrice:                    number;          // required
  happenedAt?:                  string;          // defaults to now
  sourceAccountTransactionId?:  string;          // set for expense-linked
  toRoomId?:                    string;          // optional, only valid for durables
  reasonNote?:                  string;          // recommended for manual purchases (opening stock, corrections)
};

// ─────────────────────────────────────────────────────────────
// ROW SHAPES (DB)
// ─────────────────────────────────────────────────────────────

type ItemRow = {
  id: string;
  name: string;
  category_id: string | null;
  type: InventoryItemType;
  unit: InventoryItemUnit;
  notes: string | null;
  is_active: boolean;
  low_stock_threshold: string | number | null;
  created_at: string;
  created_by: string | null;
  updated_at: string;
};

type MovementRow = {
  id: string;
  item_id: string;
  type: InventoryMovementType;
  quantity: string | number;
  unit_price: string | number | null;
  happened_at: string;
  recorded_by: string | null;
  source_account_transaction_id: string | null;
  issued_to_employee_id: string | null;
  from_room_id: string | null;
  to_room_id: string | null;
  reason_note: string | null;
  created_at: string;
};

type AssignmentRow = {
  id: string;
  item_id: string;
  room_id: string;
  quantity: string | number;
  status: InventoryAssignmentStatus;
  created_at: string;
  updated_at: string;
};

function num(v: string | number | null): number {
  if (v === null) return 0;
  return typeof v === "string" ? parseFloat(v) : v;
}

function mapItem(r: ItemRow): InventoryItem {
  return {
    id:                 r.id,
    name:               r.name,
    categoryId:         r.category_id,
    type:               r.type,
    unit:               r.unit,
    notes:              r.notes,
    isActive:           r.is_active,
    lowStockThreshold:  r.low_stock_threshold === null ? null : num(r.low_stock_threshold),
    createdAt:          r.created_at,
    createdBy:          r.created_by,
    updatedAt:          r.updated_at,
  };
}

function mapMovement(r: MovementRow): InventoryMovement {
  return {
    id:                          r.id,
    itemId:                      r.item_id,
    type:                        r.type,
    quantity:                    num(r.quantity),
    unitPrice:                   r.unit_price === null ? null : num(r.unit_price),
    happenedAt:                  r.happened_at,
    recordedBy:                  r.recorded_by,
    sourceAccountTransactionId:  r.source_account_transaction_id,
    issuedToEmployeeId:          r.issued_to_employee_id,
    fromRoomId:                  r.from_room_id,
    toRoomId:                    r.to_room_id,
    reasonNote:                  r.reason_note,
    createdAt:                   r.created_at,
  };
}

function mapAssignment(r: AssignmentRow): InventoryAssignment {
  return {
    id:         r.id,
    itemId:     r.item_id,
    roomId:     r.room_id,
    quantity:   num(r.quantity),
    status:     r.status,
    createdAt:  r.created_at,
    updatedAt:  r.updated_at,
  };
}

// ─────────────────────────────────────────────────────────────
// ITEMS
// ─────────────────────────────────────────────────────────────

/** List all items, optionally filtered by active-only. */
export async function getInventoryItems(opts: { activeOnly?: boolean } = {}): Promise<InventoryItem[]> {
  let query = supabase
    .from("inventory_items")
    .select("id, name, category_id, type, unit, notes, is_active, low_stock_threshold, created_at, created_by, updated_at")
    .order("is_active", { ascending: false })
    .order("name", { ascending: true });

  if (opts.activeOnly) query = query.eq("is_active", true);

  const { data, error } = await query;
  if (error) {
    console.error("──────────── [getInventoryItems] FAILED ────────────");
    console.error("  message:", error.message, "| code:", error.code);
    throw new Error(`[getInventoryItems] ${error.message}`);
  }
  return ((data ?? []) as ItemRow[]).map(mapItem);
}

export async function getInventoryItemById(id: string): Promise<InventoryItem | null> {
  const { data, error } = await supabase
    .from("inventory_items")
    .select("id, name, category_id, type, unit, notes, is_active, low_stock_threshold, created_at, created_by, updated_at")
    .eq("id", id)
    .maybeSingle();
  if (error) {
    console.error("──────────── [getInventoryItemById] FAILED ────────────");
    console.error("  message:", error.message, "| code:", error.code);
    throw new Error(`[getInventoryItemById] ${error.message}`);
  }
  return data ? mapItem(data as ItemRow) : null;
}

export async function createInventoryItem(input: NewInventoryItem): Promise<InventoryItem> {
  if (!input.name?.trim()) throw new Error("[createInventoryItem] Name is required.");
  if (!input.type) throw new Error("[createInventoryItem] Type is required.");
  if (!input.unit) throw new Error("[createInventoryItem] Unit is required.");

  const { data: authData } = await supabase.auth.getUser();
  const createdBy = authData?.user?.id ?? null;

  const { data, error } = await supabase
    .from("inventory_items")
    .insert({
      name:        input.name.trim(),
      category_id: input.categoryId ?? null,
      type:        input.type,
      unit:        input.unit,
      notes:       input.notes?.trim() || null,
      created_by:  createdBy,
    })
    .select("id, name, category_id, type, unit, notes, is_active, low_stock_threshold, created_at, created_by, updated_at")
    .single();

  if (error || !data) {
    console.error("──────────── [createInventoryItem] FAILED ────────────");
    console.error("  message:", error?.message, "| code:", error?.code, "| details:", error?.details);
    throw new Error(`[createInventoryItem] ${error?.message ?? "no row returned"}`);
  }
  return mapItem(data as ItemRow);
}

export async function setInventoryItemActive(id: string, isActive: boolean): Promise<InventoryItem> {
  const { data, error } = await supabase
    .from("inventory_items")
    .update({ is_active: isActive })
    .eq("id", id)
    .select("id, name, category_id, type, unit, notes, is_active, low_stock_threshold, created_at, created_by, updated_at")
    .single();
  if (error || !data) {
    console.error("──────────── [setInventoryItemActive] FAILED ────────────");
    console.error("  message:", error?.message, "| code:", error?.code);
    throw new Error(`[setInventoryItemActive] ${error?.message ?? "no row returned"}`);
  }
  return mapItem(data as ItemRow);
}

export type UpdateInventoryItem = {
  name?:        string;
  categoryId?:  string | null;   // null clears category
  type?:        InventoryItemType;
  unit?:        InventoryItemUnit;
  notes?:       string | null;   // null clears notes
  isActive?:    boolean;
};

/**
 * Update an item's editable fields. Caller is responsible for enforcing
 * the type/unit lock when movements exist (use getMovementCountForItem
 * to detect). The DB will accept the change either way; the UX rule lives
 * in the UI layer because the data risk is application-domain, not
 * schema-level.
 */
export async function updateInventoryItem(id: string, patch: UpdateInventoryItem): Promise<InventoryItem> {
  if (!id) throw new Error("[updateInventoryItem] id is required.");

  const update: Record<string, unknown> = {};
  if (patch.name !== undefined) {
    const trimmed = patch.name.trim();
    if (!trimmed) throw new Error("[updateInventoryItem] name cannot be empty.");
    update.name = trimmed;
  }
  if (patch.categoryId !== undefined) update.category_id = patch.categoryId;
  if (patch.type       !== undefined) update.type        = patch.type;
  if (patch.unit       !== undefined) update.unit        = patch.unit;
  if (patch.notes      !== undefined) update.notes       = patch.notes?.trim() || null;
  if (patch.isActive   !== undefined) update.is_active   = patch.isActive;

  if (Object.keys(update).length === 0) {
    throw new Error("[updateInventoryItem] no fields to update.");
  }

  const { data, error } = await supabase
    .from("inventory_items")
    .update(update)
    .eq("id", id)
    .select("id, name, category_id, type, unit, notes, is_active, low_stock_threshold, created_at, created_by, updated_at")
    .single();

  if (error || !data) {
    console.error("──────────── [updateInventoryItem] FAILED ────────────");
    console.error("  message:", error?.message, "| code:", error?.code, "| details:", error?.details);
    throw new Error(`[updateInventoryItem] ${error?.message ?? "no row returned"}`);
  }
  return mapItem(data as ItemRow);
}

// ─────────────────────────────────────────────────────────────
// MOVEMENTS
// ─────────────────────────────────────────────────────────────

export async function getMovementsByItem(itemId: string): Promise<InventoryMovement[]> {
  const { data, error } = await supabase
    .from("inventory_movements")
    .select("id, item_id, type, quantity, unit_price, happened_at, recorded_by, source_account_transaction_id, issued_to_employee_id, from_room_id, to_room_id, reason_note, created_at")
    .eq("item_id", itemId)
    .order("happened_at", { ascending: false });
  if (error) {
    console.error("──────────── [getMovementsByItem] FAILED ────────────");
    console.error("  message:", error.message, "| code:", error.code);
    throw new Error(`[getMovementsByItem] ${error.message}`);
  }
  return ((data ?? []) as MovementRow[]).map(mapMovement);
}

/**
 * Count movements for an item. Used by the Edit Item UI to decide whether
 * type/unit fields are safe to edit (zero movements = safe to change;
 * any movements = lock type and unit to preserve audit integrity).
 */
export async function getMovementCountForItem(itemId: string): Promise<number> {
  const { count, error } = await supabase
    .from("inventory_movements")
    .select("id", { count: "exact", head: true })
    .eq("item_id", itemId);
  if (error) {
    console.error("──────────── [getMovementCountForItem] FAILED ────────────");
    console.error("  message:", error.message, "| code:", error.code);
    throw new Error(`[getMovementCountForItem] ${error.message}`);
  }
  return count ?? 0;
}

/**
 * Create a purchase movement. Used by:
 *   - The expense-inventory seam (Phase I-D) — sourceAccountTransactionId set.
 *   - The manual "Add Stock" UI action — sourceAccountTransactionId null.
 *
 * For durables purchased directly to a room, pass toRoomId. The
 * assignment row gets bumped accordingly (service-layer sync).
 */
export async function createPurchaseMovement(input: NewPurchaseMovement): Promise<InventoryMovement> {
  if (!input.itemId) throw new Error("[createPurchaseMovement] itemId is required.");
  if (!(input.quantity > 0)) throw new Error("[createPurchaseMovement] quantity must be positive.");
  if (!(input.unitPrice >= 0)) throw new Error("[createPurchaseMovement] unitPrice must be non-negative.");

  // Look up the item to check type. Durable + toRoomId → assignment update.
  const item = await getInventoryItemById(input.itemId);
  if (!item) throw new Error(`[createPurchaseMovement] item ${input.itemId} not found.`);

  if (input.toRoomId && item.type !== "durable") {
    throw new Error("[createPurchaseMovement] toRoomId only valid for durable items.");
  }

  const { data: authData } = await supabase.auth.getUser();
  const recordedBy = authData?.user?.id ?? null;

  const { data, error } = await supabase
    .from("inventory_movements")
    .insert({
      item_id:                       input.itemId,
      type:                          "purchase",
      quantity:                      input.quantity,
      unit_price:                    input.unitPrice,
      happened_at:                   input.happenedAt ?? new Date().toISOString(),
      recorded_by:                   recordedBy,
      source_account_transaction_id: input.sourceAccountTransactionId ?? null,
      issued_to_employee_id:         null,
      from_room_id:                  null,
      to_room_id:                    input.toRoomId ?? null,
      reason_note:                   input.reasonNote?.trim() || null,
    })
    .select("id, item_id, type, quantity, unit_price, happened_at, recorded_by, source_account_transaction_id, issued_to_employee_id, from_room_id, to_room_id, reason_note, created_at")
    .single();

  if (error || !data) {
    console.error("──────────── [createPurchaseMovement] FAILED ────────────");
    console.error("  message:", error?.message, "| code:", error?.code, "| details:", error?.details);
    throw new Error(`[createPurchaseMovement] ${error?.message ?? "no row returned"}`);
  }

  // Assignment sync for durables purchased directly to a room.
  if (item.type === "durable" && input.toRoomId) {
    await upsertAssignment(input.itemId, input.toRoomId, "in_service", input.quantity);
  }

  return mapMovement(data as MovementRow);
}

// ─────────────────────────────────────────────────────────────
// ASSIGNMENTS (durables only)
// ─────────────────────────────────────────────────────────────

export async function getAssignmentsByItem(itemId: string): Promise<InventoryAssignment[]> {
  const { data, error } = await supabase
    .from("inventory_assignments")
    .select("id, item_id, room_id, quantity, status, created_at, updated_at")
    .eq("item_id", itemId)
    .order("status", { ascending: true });
  if (error) {
    console.error("──────────── [getAssignmentsByItem] FAILED ────────────");
    console.error("  message:", error.message, "| code:", error.code);
    throw new Error(`[getAssignmentsByItem] ${error.message}`);
  }
  return ((data ?? []) as AssignmentRow[]).map(mapAssignment);
}

/**
 * Upsert (item, room, status) assignment quantity by `delta`. Internal —
 * called from movement creation paths to keep assignments in sync.
 *
 * If the row exists: increment its quantity by delta (can be negative).
 * If not: insert a new row with quantity = delta (must be positive in
 * that case).
 *
 * Concurrency note: not safe under highly concurrent writes. For
 * single-admin usage this is fine. If multi-admin becomes a real
 * concern, promote to a server-side trigger or a row-level lock.
 */
async function upsertAssignment(
  itemId: string,
  roomId: string,
  status: InventoryAssignmentStatus,
  delta: number,
): Promise<void> {
  const { data: existing, error: selErr } = await supabase
    .from("inventory_assignments")
    .select("id, quantity")
    .eq("item_id", itemId)
    .eq("room_id", roomId)
    .eq("status", status)
    .maybeSingle();

  if (selErr) {
    console.error("──────────── [upsertAssignment] SELECT FAILED ────────────");
    console.error("  message:", selErr.message, "| code:", selErr.code);
    throw new Error(`[upsertAssignment] ${selErr.message}`);
  }

  if (existing) {
    const newQty = num(existing.quantity) + delta;
    if (newQty < 0) {
      throw new Error(`[upsertAssignment] cannot reduce assignment below zero (have ${existing.quantity}, delta ${delta}).`);
    }
    const { error: updErr } = await supabase
      .from("inventory_assignments")
      .update({ quantity: newQty })
      .eq("id", existing.id);
    if (updErr) {
      console.error("──────────── [upsertAssignment] UPDATE FAILED ────────────");
      console.error("  message:", updErr.message);
      throw new Error(`[upsertAssignment] ${updErr.message}`);
    }
  } else {
    if (delta <= 0) {
      throw new Error(`[upsertAssignment] cannot create new assignment with non-positive quantity (${delta}).`);
    }
    const { error: insErr } = await supabase
      .from("inventory_assignments")
      .insert({
        item_id:  itemId,
        room_id:  roomId,
        quantity: delta,
        status,
      });
    if (insErr) {
      console.error("──────────── [upsertAssignment] INSERT FAILED ────────────");
      console.error("  message:", insErr.message);
      throw new Error(`[upsertAssignment] ${insErr.message}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────
// STOCK COMPUTATION
// ─────────────────────────────────────────────────────────────

/**
 * Compute current stock for an item as SUM of movement deltas.
 *   purchase: + quantity
 *   issue:    − quantity
 *   damage:   − quantity
 *   transfer: 0 (zero stock impact)
 *   adjustment: + quantity (signed; can be negative)
 */
export async function getStockForItem(itemId: string): Promise<number> {
  const { data, error } = await supabase
    .from("inventory_movements")
    .select("type, quantity")
    .eq("item_id", itemId);
  if (error) {
    console.error("──────────── [getStockForItem] FAILED ────────────");
    console.error("  message:", error.message, "| code:", error.code);
    throw new Error(`[getStockForItem] ${error.message}`);
  }

  let stock = 0;
  for (const row of (data ?? []) as Array<{ type: InventoryMovementType; quantity: string | number }>) {
    const q = num(row.quantity);
    switch (row.type) {
      case "purchase":   stock += q; break;
      case "issue":      stock -= q; break;
      case "damage":     stock -= q; break;
      case "adjustment": stock += q; break;  // signed quantity, can be negative
      case "transfer":   /* zero impact */   break;
    }
  }
  return stock;
}

/**
 * Compute stock for all items in one query (avoids N+1).
 * Returns a Map<itemId, stock>.
 */
export async function getStockForAllItems(): Promise<Map<string, number>> {
  const { data, error } = await supabase
    .from("inventory_movements")
    .select("item_id, type, quantity");
  if (error) {
    console.error("──────────── [getStockForAllItems] FAILED ────────────");
    console.error("  message:", error.message, "| code:", error.code);
    throw new Error(`[getStockForAllItems] ${error.message}`);
  }

  const map = new Map<string, number>();
  for (const row of (data ?? []) as Array<{ item_id: string; type: InventoryMovementType; quantity: string | number }>) {
    const q = num(row.quantity);
    let delta = 0;
    switch (row.type) {
      case "purchase":   delta = +q; break;
      case "issue":      delta = -q; break;
      case "damage":     delta = -q; break;
      case "adjustment": delta = +q; break;
      case "transfer":   delta = 0;  break;
    }
    map.set(row.item_id, (map.get(row.item_id) ?? 0) + delta);
  }
  return map;
}

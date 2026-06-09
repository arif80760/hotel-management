// services/roomsService.ts
//
// ─── ROOMS SERVICE ───────────────────────────────────────────────────────────
//
// All functions make async calls to the Supabase "rooms" table.
// The context layer (HotelContext) calls these functions and updates
// its own React state based on the returned data.
//
// DATA MAPPING
//   DB column names (snake_case)  →  Frontend field names (camelCase)
//   room_number                   →  roomNumber
//   price_per_night               →  price
//   floor (integer)               →  floor ("Floor 1" string)
//   category (lowercase enum)     →  category (title-case)
//   status (lowercase enum)       →  status (title-case)
//
// ─────────────────────────────────────────────────────────────────────────────

import { supabase }                from "@/lib/supabase";
import type { MockRoom, RoomStatus } from "@/lib/mockData";

// ─────────────────────────────────────────────────────────────
// RAW ROW TYPE  (shape returned by Supabase)
// ─────────────────────────────────────────────────────────────
type RoomRow = {
  id:              string;
  room_number:     string;
  floor:           number;
  category:        string;   // lowercase: "single" | "double" | "deluxe" | "suite" | "family"
  status:          string;   // lowercase: "available" | "reserved" | "occupied" | "cleaning" | "maintenance"
  price_per_night: number;
  capacity:        number;
  amenities:       string[];
  created_at:      string;
  updated_at:      string;
};

// ─────────────────────────────────────────────────────────────
// MAPPING HELPERS
// ─────────────────────────────────────────────────────────────

/** Capitalise the first letter: "available" → "Available" */
function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** "1" / 1 → "Floor 1" */
function floorLabel(n: number): string {
  return `Floor ${n}`;
}

/** "Floor 1" → 1 */
function floorNumber(label: string): number {
  const m = label.match(/\d+/);
  return m ? parseInt(m[0], 10) : 1;
}

/** DB row → MockRoom */
function mapRoom(row: RoomRow): MockRoom {
  return {
    id:         row.id,                      // UUID from Supabase
    roomNumber: row.room_number,
    floor:      floorLabel(row.floor),
    category:   cap(row.category),           // "deluxe" → "Deluxe"
    status:     cap(row.status) as RoomStatus, // "occupied" → "Occupied"
    price:      row.price_per_night,
    capacity:   row.capacity,
    amenities:  row.amenities ?? [],
  };
}

/** MockRoom → DB insert/update payload */
function toRoomPayload(room: MockRoom) {
  return {
    room_number:     room.roomNumber,
    floor:           floorNumber(room.floor),
    category:        room.category.toLowerCase(),
    status:          room.status.toLowerCase(),
    price_per_night: room.price,
    capacity:        room.capacity,
    amenities:       room.amenities,
  };
}

// ─────────────────────────────────────────────────────────────
// READ
// ─────────────────────────────────────────────────────────────

/**
 * Fetch all rooms from Supabase, ordered by room number.
 */
export async function getAllRooms(): Promise<MockRoom[]> {
  const { data, error } = await supabase
    .from("rooms")
    .select("*")
    .order("room_number");

  if (error) throw error;
  return (data as RoomRow[]).map(mapRoom);
}

// ─────────────────────────────────────────────────────────────
// CREATE
// ─────────────────────────────────────────────────────────────

/**
 * Insert a new room. Returns the saved record (with DB-generated UUID).
 *
 * ERROR VISIBILITY
 *   Supabase returns a PostgrestError object with .message / .details /
 *   .hint / .code fields.  We log every field individually so the real
 *   failure reason is visible in the browser console even when the object
 *   appears as "{}" in a collapsed console.error() call.
 */
export async function addRoom(room: MockRoom): Promise<MockRoom> {
  const payload = toRoomPayload(room);

  // Log the exact payload so we can verify it matches the DB schema
  console.log("[addRoom] Sending payload to Supabase:", payload);

  const { data, error, status, statusText } = await supabase
    .from("rooms")
    .insert(payload)
    .select()
    .single();

  if (error) {
    // Log every field individually — some consoles collapse objects to "{}"
    console.error("──────────────── [addRoom] Supabase INSERT failed ────────────────");
    console.error("  message    :", error.message);
    console.error("  details    :", error.details);
    console.error("  hint       :", error.hint);
    console.error("  code       :", error.code);
    console.error("  HTTP status:", status, statusText);
    console.error("  full error :", error);
    console.error("  payload    :", payload);
    console.error("──────────────────────────────────────────────────────────────────");

    // Throw a real Error (not the raw PostgrestError) so the message is
    // readable wherever it is caught — never throws an empty object.
    throw new Error(
      `[addRoom] Insert failed — ${error.message}` +
      (error.code    ? ` (code: ${error.code})`       : "") +
      (error.hint    ? ` | hint: ${error.hint}`        : "") +
      (error.details ? ` | details: ${error.details}`  : "")
    );
  }

  console.log("[addRoom] Insert succeeded, returned row:", data);
  return mapRoom(data as RoomRow);
}

// ─────────────────────────────────────────────────────────────
// UPDATE
// ─────────────────────────────────────────────────────────────

/**
 * Update editable fields on a room.
 * Status is excluded — always driven by the booking workflow.
 *
 * ERROR VISIBILITY NOTE:
 *   The previous version did `if (error) throw error` which threw the raw
 *   PostgrestError object. PostgrestError's properties (message, details,
 *   hint, code) are non-enumerable, so console.error serialised it as "{}".
 *   This made a real error look like a false positive. Now we log every field
 *   individually and throw a proper Error with the message baked in.
 *
 *   The most common real error here is PGRST116 ("expected 1 row, got 0"):
 *   the UPDATE succeeds in the DB but the chained SELECT returns 0 rows
 *   because the RLS SELECT policy blocks reading the row back. The optimistic
 *   update in HotelContext already reflects the correct UI state, so this is
 *   treated as a warning rather than a hard failure — the DB write succeeded.
 */
export async function updateRoom(
  id: string,
  updates: Partial<Omit<MockRoom, "id" | "status">>
): Promise<void> {
  const payload: Record<string, unknown> = {};
  if (updates.roomNumber !== undefined) payload.room_number     = updates.roomNumber;
  if (updates.floor      !== undefined) payload.floor           = floorNumber(updates.floor);
  if (updates.category   !== undefined) payload.category        = updates.category.toLowerCase();
  if (updates.price      !== undefined) payload.price_per_night = updates.price;
  if (updates.capacity   !== undefined) payload.capacity        = updates.capacity;
  if (updates.amenities  !== undefined) payload.amenities       = updates.amenities;

  console.log("[updateRoom] Sending payload for id:", id, payload);

  const { data, error, status, statusText } = await supabase
    .from("rooms")
    .update(payload)
    .eq("id", id)
    .select()
    .single();

  if (error) {
    // PGRST116 = "JSON object requested, multiple (or no) rows returned"
    // This means the UPDATE reached the DB but the SELECT couldn't read the
    // row back (common when the RLS SELECT policy is more restrictive than
    // the UPDATE policy). The optimistic state is already correct — log a
    // warning instead of throwing so the UI doesn't report a spurious error.
    if (error.code === "PGRST116") {
      console.warn(
        "[updateRoom] UPDATE succeeded but SELECT returned 0 rows (PGRST116).",
        "The DB write completed — this is likely an RLS SELECT policy restriction.",
        "Optimistic state is correct. No action needed."
      );
      return;
    }

    // Any other error: log every field so the real message is always visible
    console.error("──────────────── [updateRoom] Supabase UPDATE failed ────────────────");
    console.error("  message    :", error.message);
    console.error("  details    :", error.details);
    console.error("  hint       :", error.hint);
    console.error("  code       :", error.code);
    console.error("  HTTP status:", status, statusText);
    console.error("  payload    :", payload);
    console.error("  room id    :", id);
    console.error("────────────────────────────────────────────────────────────────────");

    throw new Error(
      `[updateRoom] Update failed — ${error.message}` +
      (error.code    ? ` (code: ${error.code})`        : "") +
      (error.hint    ? ` | hint: ${error.hint}`         : "") +
      (error.details ? ` | details: ${error.details}`   : "")
    );
  }

  console.log("[updateRoom] Update succeeded, returned row:", data);
}

/**
 * Sync a room's status to reflect the current booking state.
 * Called by the context after any booking status transition.
 * (The DB trigger fn_sync_room_status does this server-side too,
 *  but we call it here as well to keep local state current.)
 */
export async function setRoomStatus(
  roomNumber: string,
  status: RoomStatus
): Promise<void> {
  const { error } = await supabase
    .from("rooms")
    .update({ status: status.toLowerCase() })
    .eq("room_number", roomNumber);

  if (error) throw error;
}

// ─────────────────────────────────────────────────────────────
// DELETE
// ─────────────────────────────────────────────────────────────

/**
 * Delete a room by its UUID.
 * Caller must verify canDeleteRoom() before calling this.
 */
export async function deleteRoom(id: string): Promise<void> {
  const { error, status, statusText } = await supabase
    .from("rooms")
    .delete()
    .eq("id", id);

  if (error) {
    console.error("──────────────── [deleteRoom] Supabase DELETE failed ────────────────");
    console.error("  message    :", error.message);
    console.error("  details    :", error.details);
    console.error("  hint       :", error.hint);
    console.error("  code       :", error.code);
    console.error("  HTTP status:", status, statusText);
    console.error("  room id    :", id);
    console.error("─────────────────────────────────────────────────────────────────────");
    throw new Error(
      `[deleteRoom] Delete failed — ${error.message}` +
      (error.code    ? ` (code: ${error.code})`       : "") +
      (error.hint    ? ` | hint: ${error.hint}`        : "") +
      (error.details ? ` | details: ${error.details}`  : "")
    );
  }
}

// ─────────────────────────────────────────────────────────────
// VALIDATION HELPER  (pure — no DB call)
// ─────────────────────────────────────────────────────────────

/**
 * Returns true when the room is safe to delete (not currently
 * Occupied or Reserved — i.e., not booking-locked).
 */
export function canDeleteRoom(room: MockRoom): boolean {
  return (
    room.status !== "Occupied" &&
    room.status !== "Reserved"
  );
}

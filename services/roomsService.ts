// services/roomsService.ts
//
// ─── ROOMS SERVICE ───────────────────────────────────────────────────────────
//
// All functions make async calls to the Supabase "rooms" table.
//
// DATA MAPPING
//   room_number               →  roomNumber
//   floor (integer)           →  floor ("Floor 1" string)
//   category (lowercase slug) →  category (title-case)
//   status (lowercase enum)   →  status (title-case)
//
// NOTE: price_per_night column was dropped (2026-06-11).
//       Pricing lives on room_categories.price — single source of truth.
//       MockRoom.price is kept as a placeholder (0) for type compatibility.
//
// ─────────────────────────────────────────────────────────────────────────────

import { supabase }                from "@/lib/supabase";
import type { MockRoom, RoomStatus } from "@/lib/mockData";

// ─────────────────────────────────────────────────────────────
// RAW ROW TYPE  (shape returned by Supabase)
// ─────────────────────────────────────────────────────────────
type RoomRow = {
  id:          string;
  room_number: string;
  floor:       number;
  category:    string;
  status:      string;
  capacity:    number;
  amenities:   string[];
  is_active:   boolean;
  created_at:  string;
  updated_at:  string;
};

// ─────────────────────────────────────────────────────────────
// MAPPING HELPERS
// ─────────────────────────────────────────────────────────────

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function floorLabel(n: number): string {
  return `Floor ${n}`;
}

function floorNumber(label: string): number {
  const m = label.match(/\d+/);
  return m ? parseInt(m[0], 10) : 1;
}

/** DB row → MockRoom */
function mapRoom(row: RoomRow): MockRoom {
  return {
    id:         row.id,
    roomNumber: row.room_number,
    floor:      floorLabel(row.floor),
    category:   cap(row.category),
    status:     cap(row.status) as RoomStatus,
    price:      0,  // placeholder — actual price from room_categories
    capacity:   row.capacity,
    amenities:  row.amenities ?? [],
    isActive:   row.is_active,
  };
}

/** MockRoom → DB insert/update payload (no price — column dropped) */
function toRoomPayload(room: MockRoom) {
  return {
    room_number: room.roomNumber,
    floor:       floorNumber(room.floor),
    category:    room.category.toLowerCase(),
    status:      room.status.toLowerCase(),
    capacity:    room.capacity,
    amenities:   room.amenities,
  };
}

// ─────────────────────────────────────────────────────────────
// READ
// ─────────────────────────────────────────────────────────────

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

export async function addRoom(room: MockRoom): Promise<MockRoom> {
  const payload = toRoomPayload(room);

  console.log("[addRoom] Sending payload to Supabase:", payload);

  const { data, error, status, statusText } = await supabase
    .from("rooms")
    .insert(payload)
    .select()
    .single();

  if (error) {
    console.error("──────────────── [addRoom] Supabase INSERT failed ────────────────");
    console.error("  message    :", error.message);
    console.error("  details    :", error.details);
    console.error("  hint       :", error.hint);
    console.error("  code       :", error.code);
    console.error("  HTTP status:", status, statusText);
    console.error("  payload    :", payload);
    console.error("──────────────────────────────────────────────────────────────────");

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

export async function updateRoom(
  id: string,
  updates: Partial<Omit<MockRoom, "id" | "status">>
): Promise<void> {
  const payload: Record<string, unknown> = {};
  if (updates.roomNumber !== undefined) payload.room_number = updates.roomNumber;
  if (updates.floor      !== undefined) payload.floor       = floorNumber(updates.floor);
  if (updates.category   !== undefined) payload.category    = updates.category.toLowerCase();
  if (updates.capacity   !== undefined) payload.capacity    = updates.capacity;
  if (updates.amenities  !== undefined) payload.amenities   = updates.amenities;
  // price intentionally ignored — pricing lives on room_categories

  console.log("[updateRoom] Sending payload for id:", id, payload);

  const { data, error, status, statusText } = await supabase
    .from("rooms")
    .update(payload)
    .eq("id", id)
    .select()
    .single();

  if (error) {
    if (error.code === "PGRST116") {
      console.warn(
        "[updateRoom] UPDATE succeeded but SELECT returned 0 rows (PGRST116).",
        "Optimistic state is correct. No action needed."
      );
      return;
    }

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
// DEACTIVATE / REACTIVATE
// Rooms are never deleted — five FK RESTRICT constraints reference
// them (bookings.room_id, booking_rooms.room_id, inventory_movements
// .from_room_id/.to_room_id, inventory_assignments.room_id).
// Lifecycle is is_active, mirroring room categories / expense items.
// ─────────────────────────────────────────────────────────────

export async function setRoomActive(id: string, isActive: boolean): Promise<void> {
  // Deactivation guard: refuse while any booking_rooms row on this room
  // is still confirmed/checked_in — name the blocking booking so the UI
  // can show a clear message instead of a raw error. Reactivation is
  // always allowed (no guard).
  if (!isActive) {
    const { data: blockers, error: guardErr } = await supabase
      .from("booking_rooms")
      .select("status, check_out_date, bookings!booking_id(booking_ref)")
      .eq("room_id", id)
      .in("status", ["confirmed", "checked_in"])
      .limit(1);

    if (guardErr) {
      console.error("──────────── [setRoomActive] guard query failed ────────────");
      console.error("  message:", guardErr.message, "| code:", guardErr.code);
      throw new Error(`[setRoomActive] Could not verify active bookings — ${guardErr.message}`);
    }
    if (blockers && blockers.length > 0) {
      const b = blockers[0];
      // Embedded relation may be array OR object — handle both.
      const bk  = Array.isArray(b.bookings) ? b.bookings[0] : b.bookings;
      const ref = (bk as { booking_ref: string | null } | null)?.booking_ref ?? "an active booking";
      const state = b.status === "checked_in" ? "checked in" : "confirmed";
      const until = b.check_out_date ? ` until ${b.check_out_date}` : "";
      throw new Error(
        `Cannot deactivate — booking ${ref} is ${state}${until} on this room. Check it out or cancel it first.`
      );
    }
  }

  const { error, status, statusText } = await supabase
    .from("rooms")
    .update({ is_active: isActive })
    .eq("id", id);

  if (error) {
    console.error("──────────────── [setRoomActive] Supabase UPDATE failed ────────────────");
    console.error("  message    :", error.message);
    console.error("  details    :", error.details);
    console.error("  hint       :", error.hint);
    console.error("  code       :", error.code);
    console.error("  HTTP status:", status, statusText);
    console.error("  room id    :", id, "| is_active →", isActive);
    console.error("────────────────────────────────────────────────────────────────────────");
    throw new Error(
      `[setRoomActive] Update failed — ${error.message}` +
      (error.code    ? ` (code: ${error.code})`       : "") +
      (error.hint    ? ` | hint: ${error.hint}`        : "") +
      (error.details ? ` | details: ${error.details}`  : "")
    );
  }
}

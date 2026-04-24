// services/guestsService.ts
//
// ─── GUESTS SERVICE ──────────────────────────────────────────────────────────
//
// All async functions make calls to the Supabase "guests" table.
// searchGuests() is kept synchronous — it filters an already-fetched
// array in memory so the UI stays responsive while the user types.
//
// DATA MAPPING
//   The "guests" table schema closely matches MockGuest.
//   The main difference: DB uses a UUID primary key, whereas the
//   mock data used "G-001" style IDs. With Supabase, MockGuest.id
//   is the UUID returned by the database.
//
// ─────────────────────────────────────────────────────────────────────────────

import { supabase }           from "@/lib/supabase";
import type { MockGuest }     from "@/lib/mockData";

// ─────────────────────────────────────────────────────────────
// RAW ROW TYPE  (shape returned by Supabase)
// ─────────────────────────────────────────────────────────────
type GuestRow = {
  id:          string;
  name:        string;
  email:       string;
  phone:       string;
  nationality: string | null;
  notes:       string | null;
  vip:         boolean;
  created_at:  string;
  updated_at:  string;
};

// ─────────────────────────────────────────────────────────────
// ROW MAPPER
// ─────────────────────────────────────────────────────────────

function mapGuest(row: GuestRow): MockGuest {
  return {
    id:          row.id,
    name:        row.name,
    email:       row.email,
    phone:       row.phone,
    nationality: row.nationality ?? "",
    notes:       row.notes ?? "",
    vip:         row.vip,
  };
}

// ─────────────────────────────────────────────────────────────
// READ
// ─────────────────────────────────────────────────────────────

/**
 * Fetch all guest profiles from Supabase, ordered alphabetically.
 */
export async function getAllGuests(): Promise<MockGuest[]> {
  const { data, error } = await supabase
    .from("guests")
    .select("*")
    .order("name");

  if (error) throw error;
  return (data as GuestRow[]).map(mapGuest);
}

// ─────────────────────────────────────────────────────────────
// SEARCH  (pure — no DB call)
// ─────────────────────────────────────────────────────────────

/**
 * Filter an already-fetched guest list by a search query.
 * Matches against name, email, and nationality (case-insensitive).
 * Returns the full list when query is empty.
 *
 * Kept synchronous so the search input stays instant while typing.
 */
export function searchGuests(guests: MockGuest[], query: string): MockGuest[] {
  const q = query.trim().toLowerCase();
  if (!q) return guests;
  return guests.filter(
    g =>
      g.name.toLowerCase().includes(q) ||
      g.email.toLowerCase().includes(q) ||
      g.nationality.toLowerCase().includes(q)
  );
}

// ─────────────────────────────────────────────────────────────
// CREATE
// ─────────────────────────────────────────────────────────────

/**
 * Insert a new guest profile. Returns the saved record with DB-generated UUID.
 */
export async function addGuest(
  guest: Omit<MockGuest, "id">
): Promise<MockGuest> {
  const { data, error } = await supabase
    .from("guests")
    .insert({
      name:        guest.name,
      email:       guest.email,
      phone:       guest.phone,
      nationality: guest.nationality || null,
      notes:       guest.notes       || null,
      vip:         guest.vip,
    })
    .select()
    .single();

  if (error) throw error;
  return mapGuest(data as GuestRow);
}

// ─────────────────────────────────────────────────────────────
// UPDATE
// ─────────────────────────────────────────────────────────────

/**
 * Update editable fields on a guest profile.
 * The id field is excluded from updates; it is the stable identifier.
 */
export async function updateGuest(
  id: string,
  updates: Partial<Omit<MockGuest, "id">>
): Promise<MockGuest> {
  const payload: Record<string, unknown> = {};
  if (updates.name        !== undefined) payload.name        = updates.name;
  if (updates.email       !== undefined) payload.email       = updates.email;
  if (updates.phone       !== undefined) payload.phone       = updates.phone;
  if (updates.nationality !== undefined) payload.nationality = updates.nationality || null;
  if (updates.notes       !== undefined) payload.notes       = updates.notes       || null;
  if (updates.vip         !== undefined) payload.vip         = updates.vip;

  const { data, error } = await supabase
    .from("guests")
    .update(payload)
    .eq("id", id)
    .select()
    .single();

  if (error) throw error;
  return mapGuest(data as GuestRow);
}

// ─────────────────────────────────────────────────────────────
// DELETE
// ─────────────────────────────────────────────────────────────

/**
 * Delete a guest profile by UUID.
 * Note: bookings that reference this guest via primary_guest_id are
 * protected by ON DELETE RESTRICT — deletion will fail if active
 * bookings exist. Handle the error in the calling component.
 */
export async function deleteGuest(id: string): Promise<void> {
  const { error } = await supabase
    .from("guests")
    .delete()
    .eq("id", id);

  if (error) throw error;
}

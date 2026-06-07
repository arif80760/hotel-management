// services/roomAnalyticsService.ts
//
// ─── ROOM ANALYTICS SERVICE ───────────────────────────────────────────────────
//
// Thin wrappers around two read-only DB functions:
//
//   room_analytics_by_room(p_from date, p_to date)
//     → one row per room: occupancy, revenue, ADR, RevPAR, bookings count, …
//
//   room_occupancy_trend(p_from date, p_to date)
//     → one row per calendar day: occupied_rooms, available_rooms, occupancy_pct
//
// Both RPCs perform all the math server-side.  This service only maps the
// snake_case DB columns to camelCase TypeScript fields — no derived metrics.
//
// ─────────────────────────────────────────────────────────────────────────────

import { supabase } from "@/lib/supabase";

// ─────────────────────────────────────────────────────────────
// TYPES — frontend (camelCase)
// ─────────────────────────────────────────────────────────────

export type RoomAnalyticsRow = {
  roomId:         string;
  roomNumber:     string;
  floor:          number;
  category:       string;   // slug, e.g. "deluxe"
  roomStatus:     string;   // current occupancy status, e.g. "occupied"
  pricePerNight:  number;
  bookings:       number;   // total bookings in range
  occupiedNights: number;   // total nights occupied in range
  availableNights:number;   // total nights room was available (i.e. not in maintenance)
  revenue:        number;   // total room revenue in range
  adr:            number | null;  // Average Daily Rate; null when occupiedNights = 0
  revpar:         number;   // Revenue Per Available Room
  occupancyPct:   number;   // 0–100+; not capped (>100 surfaces double-books)
};

export type OccupancyTrendRow = {
  day:           string;   // ISO date "2026-06-07"
  occupiedRooms: number;
  availableRooms:number;
  occupancyPct:  number;
};

// ─────────────────────────────────────────────────────────────
// RAW RPC ROW TYPES — snake_case as returned by PostgREST
// ─────────────────────────────────────────────────────────────

type RawRoomAnalyticsRow = {
  room_id:          string;
  room_number:      string;
  floor:            number;
  category:         string;
  room_status:      string;
  price_per_night:  number;
  bookings:         number;
  occupied_nights:  number;
  available_nights: number;
  revenue:          number;
  adr:              number | null;
  revpar:           number;
  occupancy_pct:    number;
};

type RawOccupancyTrendRow = {
  day:            string;
  occupied_rooms: number;
  available_rooms:number;
  occupancy_pct:  number;
};

// ─────────────────────────────────────────────────────────────
// MAPPERS
// ─────────────────────────────────────────────────────────────

function mapRoomAnalyticsRow(r: RawRoomAnalyticsRow): RoomAnalyticsRow {
  return {
    roomId:          r.room_id,
    roomNumber:      r.room_number,
    floor:           r.floor,
    category:        r.category,
    roomStatus:      r.room_status,
    pricePerNight:   r.price_per_night,
    bookings:        r.bookings,
    occupiedNights:  r.occupied_nights,
    availableNights: r.available_nights,
    revenue:         r.revenue,
    adr:             r.adr,
    revpar:          r.revpar,
    occupancyPct:    r.occupancy_pct,
  };
}

function mapOccupancyTrendRow(r: RawOccupancyTrendRow): OccupancyTrendRow {
  return {
    day:            r.day,
    occupiedRooms:  r.occupied_rooms,
    availableRooms: r.available_rooms,
    occupancyPct:   r.occupancy_pct,
  };
}

// ─────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────

/**
 * Per-room performance metrics for a date range.
 * Calls the `room_analytics_by_room` Postgres function.
 */
export async function getRoomAnalyticsByRoom(
  from: string,
  to: string,
): Promise<RoomAnalyticsRow[]> {
  const { data, error } = await supabase.rpc("room_analytics_by_room", {
    p_from: from,
    p_to:   to,
  });

  if (error) {
    console.error("──── [getRoomAnalyticsByRoom] FAILED ────");
    console.error("  message:", error.message, "| code:", error.code);
    throw new Error(`[getRoomAnalyticsByRoom] ${error.message}`);
  }

  return ((data ?? []) as RawRoomAnalyticsRow[]).map(mapRoomAnalyticsRow);
}

/**
 * Daily occupancy breakdown for a date range.
 * Calls the `room_occupancy_trend` Postgres function.
 */
export async function getRoomOccupancyTrend(
  from: string,
  to: string,
): Promise<OccupancyTrendRow[]> {
  const { data, error } = await supabase.rpc("room_occupancy_trend", {
    p_from: from,
    p_to:   to,
  });

  if (error) {
    console.error("──── [getRoomOccupancyTrend] FAILED ────");
    console.error("  message:", error.message, "| code:", error.code);
    throw new Error(`[getRoomOccupancyTrend] ${error.message}`);
  }

  return ((data ?? []) as RawOccupancyTrendRow[]).map(mapOccupancyTrendRow);
}

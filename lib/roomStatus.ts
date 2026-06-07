// lib/roomStatus.ts
//
// Date helpers and room-status derivation shared between RoomBoard and the
// Dashboard. Extracted here so both components read occupancy identically —
// Dashboard KPIs and Occupancy-by-Floor always match the Room Board grid.

import type { RoomStatus, Room, Booking } from "@/contexts/HotelContext";

/**
 * Format a Date as "YYYY-MM-DD" using local date components.
 * Avoids UTC-midnight rollback in timezones east of UTC (e.g. UTC+6 Bangladesh).
 */
export function localDateToISO(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** ISO date string for today in the local timezone. */
export const TODAY_ISO = localDateToISO(new Date());

/**
 * Derive a room's display status for a given date, using bookings as the
 * source of truth rather than the physical rooms.status column.
 *
 * Identical logic to what RoomBoard uses — shared so Dashboard occupancy
 * counts always match the Room Board grid.
 *
 * @param room      The room to evaluate.
 * @param dateISO   The date to evaluate ("YYYY-MM-DD").
 * @param todayISO  Today's ISO date — used to distinguish past/future logic.
 * @param bookings  Full bookings array from HotelContext.
 */
export function deriveRoomStatusForDate(
  room: Room, dateISO: string, todayISO: string, bookings: Booking[],
): RoomStatus {
  // 1. SPECIAL CASE: today is checkout date and guest is still Checked In —
  //    physically present until staff confirms. Half-open would say "released"
  //    but guest hasn't left yet.
  if (dateISO === todayISO) {
    const stillCheckedIn = bookings.some(b =>
      b.rooms.some(
        r =>
          r.roomNumber === room.roomNumber &&
          r.status === "Checked In" &&
          r.checkOutISO === todayISO,
      )
    );
    if (stillCheckedIn) return "Occupied";
  }
  // 3. Standard active booking check (half-open — checkout day is released).
  //    Iterates b.rooms[] so multi-room bookings match each room correctly.
  for (const b of bookings) {
    if (b.status === "Cancelled") continue;
    const matched = b.rooms.find(
      r =>
        r.roomNumber === room.roomNumber &&
        r.status !== "Cancelled" &&
        r.checkInISO <= dateISO && dateISO < r.checkOutISO,
    );
    if (matched) {
      const s = matched.status;
      if (s === "Checked In")                                                        return "Occupied";
      if ((s === "Checked Out" || s === "Checked Out Early") && dateISO < todayISO) return "Occupied";
      if (s === "Confirmed" && dateISO >= todayISO)                                 return "Reserved";
      break; // stale Confirmed on past dates → fall through to Available
    }
  }
  // 4. Default
  return "Available";
}

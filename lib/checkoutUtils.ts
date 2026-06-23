// lib/checkoutUtils.ts
//
// Shared checkout calculation helpers.
// Used by BookingsClient and FrontDeskClient for the booking-level
// "Check Out" modal display. All functions here are display-only —
// the authoritative computation happens server-side in the
// checkout_booking RPC.

import type { BookingRoom } from "@/lib/mockData";

/** Floored early nights for a single room — mirrors the server RPC exactly.
 *  min( max(0, whole-day diff scheduled→actual), max(0, nights − 1) ).
 *  Always keeps at least the check-in night billable. */
export function earlyNights(scheduledISO: string, actualISO: string, nights: number): number {
  if (!scheduledISO || !actualISO) return 0;
  const MS = 86_400_000;
  const sched = new Date(`${scheduledISO}T00:00:00`).getTime();
  const actual = new Date(`${actualISO}T00:00:00`).getTime();
  if (Number.isNaN(sched) || Number.isNaN(actual)) return 0;
  const rawDays = Math.max(0, Math.round((sched - actual) / MS));
  return Math.min(rawDays, Math.max(0, nights - 1));
}

/** Per-room contribution to the early-checkout deduction total. */
export interface RoomDeduction {
  roomNumber: string;
  earlyDays:  number;
  earlyAmt:   number;
}

/** Aggregate result returned by calcBookingLevelDeductions. */
export interface BookingLevelDeductions {
  totalDays: number;          // sum of earlyDays across active rooms
  totalAmt:  number;          // sum of earlyAmt  across active rooms
  perRoom:   RoomDeduction[]; // per-room breakdown (for optional UI display)
}

/**
 * Computes early-checkout deductions for a booking-level "Check Out".
 *
 * Iterates rooms with status "Checked In" or "Confirmed" and for each:
 *   rawDays   = max(0, midnight(room.checkOutISO) − midnight(actualAt))
 *   earlyDays = min(rawDays, max(0, room.nights − 1))   ← min-one-night floor
 *   earlyAmt  = earlyDays × room.bookingRate
 *
 * The floor guarantees a room always keeps at least one night charged once it
 * carries a stay — a same-day checkout charges the check-in day rather than
 * refunding everything. This mirrors the authoritative DB floor in
 * checkout_booking / cancel_booking_room (deduction capped at nights − 1), so
 * the operator preview matches what the RPC will actually write.
 *
 * Uses room.checkOutISO ("YYYY-MM-DD") directly — no display-string
 * parsing, no single booking-level proxy. Each room contributes its own
 * scheduled check_out_date and per-room rate, which is correct for
 * multi-room bookings with mixed checkout schedules.
 *
 * NOTE: Display-only preview for the operator. The authoritative
 * per-room deduction is computed server-side by checkout_booking RPC
 * from check_out_date and booking_rate columns. Frontend and backend
 * should agree except for sub-second timezone edge cases at midnight.
 */
export function calcBookingLevelDeductions(
  rooms:    BookingRoom[],
  actualAt: Date,
): BookingLevelDeductions {
  // Local YYYY-MM-DD for the actual checkout moment, computed once.
  const actualMidnight = new Date(actualAt);
  actualMidnight.setHours(0, 0, 0, 0);
  const actualISO =
    `${actualMidnight.getFullYear()}-${String(actualMidnight.getMonth() + 1).padStart(2, "0")}-${String(actualMidnight.getDate()).padStart(2, "0")}`;

  let totalDays = 0;
  let totalAmt  = 0;
  const perRoom: RoomDeduction[] = [];

  for (const room of rooms) {
    if (room.status !== "Checked In" && room.status !== "Confirmed") continue;

    // Single floored implementation — see earlyNights().
    const earlyDays = earlyNights(room.checkOutISO ?? "", actualISO, room.nights);
    const earlyAmt  = earlyDays * room.bookingRate;

    totalDays += earlyDays;
    totalAmt  += earlyAmt;
    perRoom.push({ roomNumber: room.roomNumber, earlyDays, earlyAmt });
  }

  return { totalDays, totalAmt, perRoom };
}

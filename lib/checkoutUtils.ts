// lib/checkoutUtils.ts
//
// Shared checkout calculation helpers.
// Used by BookingsClient and FrontDeskClient for the booking-level
// "Check Out" modal display. All functions here are display-only —
// the authoritative computation happens server-side in the
// checkout_booking RPC.

import type { BookingRoom } from "@/lib/mockData";

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
 *   earlyDays = max(0, midnight(room.checkOutISO) − midnight(actualAt))
 *   earlyAmt  = earlyDays × room.bookingRate
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
  const actualMidnight = new Date(actualAt);
  actualMidnight.setHours(0, 0, 0, 0);

  let totalDays = 0;
  let totalAmt  = 0;
  const perRoom: RoomDeduction[] = [];

  for (const room of rooms) {
    if (room.status !== "Checked In" && room.status !== "Confirmed") continue;

    // Use ISO date string directly — avoids display-string parsing ambiguity.
    const plannedMidnight = new Date(`${room.checkOutISO}T00:00:00`);
    plannedMidnight.setHours(0, 0, 0, 0);

    const earlyDays = Math.max(0, Math.round(
      (plannedMidnight.getTime() - actualMidnight.getTime()) / 86_400_000
    ));
    const earlyAmt = earlyDays * room.bookingRate;

    totalDays += earlyDays;
    totalAmt  += earlyAmt;
    perRoom.push({ roomNumber: room.roomNumber, earlyDays, earlyAmt });
  }

  return { totalDays, totalAmt, perRoom };
}

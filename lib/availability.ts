// lib/availability.ts
//
// ─── THE availability formula (client-side mirror of the DB guard) ──────────
//
// One formula, everywhere (2026-08-31): every client-side availability check
// and room click-routing decision MUST go through these exports — the
// Bookings ?room= handler ran its own containment check (no dates, no row
// status) for months and silently ate rebookings of released rooms.
//
// Semantics = create_booking_with_rooms' overlap guard exactly:
//   • blocking rows are status IN ('confirmed','checked_in') ONLY — a
//     WHITELIST, so any future status defaults to non-blocking. Cancelled,
//     Checked Out and Checked Out Early rows release their dates even while
//     the parent booking stays active.
//   • half-open [checkIn, checkOut) ranges — same-day turnover allowed.
//   • COALESCE(actual_checkout_date, check_out_date) is vestigial here, as
//     in the guard itself: rows carrying an actual are completed, and the
//     whitelist already excludes them. (Historical DISPLAY of completed rows
//     does need the actual — see lib/roomStatus.)

import type { MockBooking, BookingStatus, BookingRoomStatus } from "@/lib/mockData";

/** Booking-level statuses that can hold rooms at all. */
export const BLOCKING_STATUSES = new Set<BookingStatus>(["Confirmed", "Checked In"]);

/** Row-level whitelist — mirrors x.status IN ('confirmed','checked_in'). */
export const ROOM_BLOCKING_STATUSES = new Set<BookingRoomStatus>(["Confirmed", "Checked In"]);

/**
 * Normalise any date string to "YYYY-MM-DD" for safe lexicographic comparison.
 * Accepts ISO dates ("2026-04-22") and display dates ("Apr 22, 2026").
 * Returns "" on parse failure so callers can skip the overlap test safely.
 */
export function toISODate(s: string): string {
  if (!s) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;         // already ISO
  const d = new Date(`${s} 12:00:00`);
  if (isNaN(d.getTime())) return "";
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
  ].join("-");
}

/**
 * True when two date ranges for the SAME room overlap — half-open [in, out),
 * so a checkout on the same day as a new check-in is explicitly ALLOWED.
 * Accepts any mix of ISO or display-format date strings.
 */
export function bookingDatesOverlap(
  existingIn:  string, existingOut: string,
  newIn:       string, newOut:      string,
): boolean {
  const eIn  = toISODate(existingIn);
  const eOut = toISODate(existingOut);
  const nIn  = toISODate(newIn);
  const nOut = toISODate(newOut);
  if (!eIn || !eOut || !nIn || !nOut) return false;
  return eIn < nOut && eOut > nIn;
}

/**
 * Scan the live local bookings array for a conflict.
 * Returns the first conflicting booking or undefined.
 *
 * Per-row iteration: a partially released booking (some rows checked out
 * early / cancelled, some still active) blocks ONLY through its still-
 * blocking rows — the multi-row edge routes correctly by construction:
 * blocking row overlapping → conflict; released rows only → no conflict.
 *
 * @param excludeId  Optional booking_ref to skip (used when editing a booking).
 */
export function findRoomConflict(
  bookings:   MockBooking[],
  roomNumber: string,
  checkIn:    string,   // ISO "YYYY-MM-DD"
  checkOut:   string,   // ISO "YYYY-MM-DD"
  excludeId?: string,
): MockBooking | undefined {
  if (!roomNumber || !checkIn || !checkOut) return undefined;
  return bookings.find(b => {
    if (excludeId && b.id === excludeId) return false;
    if (!BLOCKING_STATUSES.has(b.status)) return false;
    return b.rooms.some(br =>
      ROOM_BLOCKING_STATUSES.has(br.status) &&
      br.roomNumber.trim() === roomNumber.trim() &&
      bookingDatesOverlap(br.checkInISO ?? "", br.checkOutISO ?? "", checkIn, checkOut)
    );
  });
}

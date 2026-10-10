// lib/bookingRooms.ts
//
// THE single definition of which of a booking's room rows represent the
// booking for display (BK-2077: the FrontDesk card named a cancelled room
// because booking.roomNumber shimmed from rows[0] with no status filter).
// Same precedent as calcTrueDue / findRoomConflict / deriveBookingSpan:
// one exported helper, imported everywhere a surface summarizes a
// booking's rooms. Never read rows[0] for a label.

interface LabelRoom {
  roomNumber: string;
  status:     string;
}

/**
 * The rows that currently represent the booking:
 *  • active rows (Confirmed / Checked In) when any exist;
 *  • otherwise the non-cancelled historical rows (a departed booking is
 *    represented by the rooms that were actually occupied);
 *  • empty when every row is cancelled — callers show a cancelled state,
 *    never a phantom room.
 */
export function activeRooms<R extends { status: string }>(rooms: R[]): R[] {
  const active = rooms.filter(r => r.status === "Confirmed" || r.status === "Checked In");
  if (active.length > 0) return active;
  return rooms.filter(r => r.status !== "Cancelled");
}

/**
 * Display label for a booking's rooms:
 *  "Room 111" (one representing room) · "3 rooms" (several, matching the
 *  Bookings list) · "Cancelled" (rows exist but all cancelled) · "—" (none).
 */
export function primaryRoomLabel(rooms: LabelRoom[]): string {
  const act = activeRooms(rooms);
  if (act.length === 0) return rooms.length > 0 ? "Cancelled" : "—";
  if (act.length === 1) return `Room ${act[0].roomNumber}`;
  return `${act.length} rooms`;
}

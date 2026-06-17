// lib/bookingSpan.ts
//
// THE single definition of a booking's stay span across its rooms. Imported by
// the row mapper (services/bookingsService.ts) AND the optimistic-update writers
// (contexts/HotelContext.tsx) so the booking-level checkIn / checkOut / nights
// can never disagree between the optimistic object and the re-fetched one.
//
// History: these three sites each computed booking-level `nights` differently
// (first-room / sum-of-room-nights / calendar-span), so a multi-room booking's
// displayed nights flickered as it moved through its lifecycle. Centralising the
// definition here removes the drift and prevents it recurring.

interface SpanRoom {
  checkInISO?:  string | null;
  checkOutISO?: string | null;
  status?:      string;
  nights?:      number;
}

export interface BookingSpan {
  /** Earliest check-in across active rooms (undefined if no dated rooms). */
  checkInISO?:  string;
  /** Latest check-out across active rooms (undefined if no dated rooms). */
  checkOutISO?: string;
  /**
   * Multi-room → calendar span between checkInISO…checkOutISO (matches the dates).
   * Single active room → that room's own (billed) nights, so an early checkout
   *   still shows the billed figure rather than the scheduled span.
   * No rooms → undefined (caller falls back to its stored value).
   */
  nights?: number;
}

/**
 * Derive a booking's stay span from its rooms.
 * Cancelled rooms don't define the stay; if every room is cancelled we fall back
 * to all rooms so the booking still shows something. ISO date strings
 * ("YYYY-MM-DD") compare lexicographically == chronologically, so min/max on the
 * raw strings is correct without parsing. The noon anchor on the nights diff
 * matches the project's date convention (no UTC-midnight rollback in UTC+6).
 */
export function deriveBookingSpan(rooms: SpanRoom[]): BookingSpan {
  const active = rooms.filter(r => r.status !== "Cancelled");
  const span   = active.length > 0 ? active : rooms;

  const ins  = span.map(r => r.checkInISO).filter(Boolean) as string[];
  const outs = span.map(r => r.checkOutISO).filter(Boolean) as string[];
  const checkInISO  = ins.length  ? ins.reduce((a, b)  => (b < a ? b : a))  : undefined;
  const checkOutISO = outs.length ? outs.reduce((a, b) => (b > a ? b : a)) : undefined;

  let nights: number | undefined;
  if (span.length > 1 && checkInISO && checkOutISO) {
    nights = Math.round(
      (new Date(`${checkOutISO}T12:00:00`).getTime() -
       new Date(`${checkInISO}T12:00:00`).getTime()) / 86_400_000,
    );
  } else if (span.length === 1) {
    nights = span[0]?.nights ?? undefined;
  }

  return { checkInISO, checkOutISO, nights };
}

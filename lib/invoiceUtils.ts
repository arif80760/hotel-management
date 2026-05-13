import type { Booking } from "@/contexts/HotelContext";
import type { BookingStatus, PaymentStatus } from "@/lib/mockData";

/**
 * Returns the invoice number for a booking. Today: just
 * returns booking.id (e.g., "BK-1037"). Could expand later
 * to support custom formatting if needed.
 */
export function formatInvoiceNumber(booking: Booking): string {
  return booking.id;
}

/**
 * Formats a date for invoice display.
 * Input: Date object, YYYY-MM-DD date string, or full ISO timestamp.
 * Output: "May 6, 2026"
 *
 * Two-path string handling:
 *   Date-only  ("2026-05-06")             → append T12:00:00 to anchor at local noon,
 *                                            preventing UTC-midnight rollback in UTC+6
 *   Full timestamp ("2026-05-06T10:32:00+06:00") → parse as-is; timezone offset is explicit
 *
 * Falls back to "—" if the value produces an invalid Date (defensive).
 */
export function formatInvoiceDate(date: Date | string): string {
  let d: Date;
  if (typeof date === "string") {
    d = date.length <= 10 && !date.includes("T")
      ? new Date(`${date}T12:00:00`)   // date-only: anchor to local noon
      : new Date(date);                // full timestamp: parse as-is
  } else {
    d = date;
  }

  if (isNaN(d.getTime())) return "—"; // graceful fallback

  return d.toLocaleDateString("en-US", {
    year:  "numeric",
    month: "long",
    day:   "numeric",
  });
}

/**
 * Formats a number as Bangladeshi Taka with thousand separators.
 * Example: 8000 → "৳8,000"
 */
export function formatTaka(amount: number): string {
  return `৳${amount.toLocaleString("en-IN")}`;
}

/**
 * Canonical outstanding-balance formula.
 * Always use this instead of the naive (totalAmount − amountPaid).
 * Accounts for extra charges, early-checkout deductions, and additional discounts.
 * For bookings not yet checked out, deductions are 0 so it reduces to totalAmount − amountPaid.
 */
export function calcTrueDue(b: {
  totalAmount:               number;
  amountPaid:                number;
  extraChargeAmount?:        number;
  additionalDiscountAmount?: number;
}): number {
  return b.totalAmount
    + (b.extraChargeAmount          ?? 0)
    - (b.additionalDiscountAmount   ?? 0)
    - b.amountPaid;
}

/**
 * Derives PaymentStatus from booking status and raw totals (pure, no DB).
 * Mirrors the Postgres trigger fn_sync_payment_status.
 * Cancelled bookings always return "Cancelled" regardless of amounts.
 *
 * Canonical version — moved here from bookingsService.ts (Phase 11 #28).
 * bookingsService re-exports this to preserve its existing call surface.
 */
export function derivePaymentStatus(
  totalAmount: number,
  amountPaid:  number,
  status:      BookingStatus,
): PaymentStatus {
  if (status === "Cancelled")    return "Cancelled";
  if (amountPaid <= 0)           return "Unpaid";
  if (amountPaid >= totalAmount) return "Paid";
  return "Partial";
}

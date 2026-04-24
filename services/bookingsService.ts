// services/bookingsService.ts
//
// ─── BOOKINGS SERVICE ────────────────────────────────────────────────────────
//
// All async functions make calls to the Supabase "bookings" table.
// Pure helpers (bookingToRoomStatus, derivePaymentStatus) remain synchronous.
//
// DATA MAPPING
//   DB stores:  booking_ref ("BK-1041"), room_id (UUID), primary_guest_id (UUID)
//   UI expects: id ("BK-1041"), roomNumber ("204"), guestName ("James Whitfield")
//
//   Reads:  SELECT bookings JOIN rooms JOIN guests JOIN booking_guests → MockBooking
//   Writes: translate MockBooking fields to DB column names / UUIDs
//
// GUEST HANDLING ON BOOKING CREATION
//   The UI captures guest name + phone (not a guest UUID).
//   createBooking() does a find-or-create lookup on the guests table by phone
//   so every booking is always linked to a proper guest profile.
//
// ─────────────────────────────────────────────────────────────────────────────

import { supabase } from "@/lib/supabase";
import type {
  MockBooking,
  BookingStatus,
  PaymentStatus,
  RoomStatus,
  CheckoutOverride,
} from "@/lib/mockData";

// ─────────────────────────────────────────────────────────────
// RAW ROW TYPE  (shape returned by Supabase with joins)
// ─────────────────────────────────────────────────────────────
type BookingRow = {
  id:                       string;   // UUID
  booking_ref:              string;   // "BK-1041"
  status:                   string;   // lowercase enum
  check_in_date:            string;   // "2026-04-22"
  check_out_date:           string;
  nights:                   number;
  room_category_at_booking: string;   // lowercase enum
  total_guests:             number;
  total_amount:             number;
  paid_amount:              number;
  payment_status:           string;   // lowercase enum
  override_checkout:        boolean;
  override_reason:          string | null;
  override_by:              string | null;
  override_at:              string | null;
  confirmed_at:             string | null;
  checked_in_at:            string | null;
  checked_out_at:           string | null;
  cancelled_at:             string | null;
  created_at:               string;
  updated_at:               string;
  // Joined relations
  rooms: { room_number: string; category: string } | null;
  guests: { name: string; phone: string } | null;
  booking_guests: Array<{
    name:        string;
    nationality: string | null;
    sort_order:  number;
  }>;
};

// ─────────────────────────────────────────────────────────────
// ENUM MAPS  (DB ↔ Frontend)
// ─────────────────────────────────────────────────────────────

const DB_TO_BOOKING_STATUS: Record<string, BookingStatus> = {
  confirmed:    "Confirmed",
  checked_in:   "Checked In",
  checked_out:  "Checked Out",
  cancelled:    "Cancelled",
};

const BOOKING_STATUS_TO_DB: Record<BookingStatus, string> = {
  "Confirmed":   "confirmed",
  "Checked In":  "checked_in",
  "Checked Out": "checked_out",
  "Cancelled":   "cancelled",
};

const DB_TO_PAYMENT_STATUS: Record<string, PaymentStatus> = {
  unpaid:  "Unpaid",
  partial: "Partial",
  paid:    "Paid",
};

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ─────────────────────────────────────────────────────────────
// DATE HELPERS
// ─────────────────────────────────────────────────────────────

/**
 * DB DATE string → UI display string
 * "2026-04-22" → "Apr 22, 2026"
 */
function formatDateForDisplay(isoDate: string): string {
  // Append T12:00:00 so the Date isn't interpreted as midnight UTC,
  // which can roll back one calendar day in negative-offset timezones.
  return new Date(`${isoDate}T12:00:00`).toLocaleDateString("en-US", {
    month: "short",
    day:   "numeric",
    year:  "numeric",
  });
}

/**
 * UI display string → DB DATE string
 * "Apr 22, 2026" → "2026-04-22"
 */
function parseDisplayDate(display: string): string {
  const d = new Date(display);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ─────────────────────────────────────────────────────────────
// ROW MAPPER
// ─────────────────────────────────────────────────────────────

function mapBooking(row: BookingRow): MockBooking {
  const override: CheckoutOverride | undefined = row.override_checkout
    ? {
        used:           true,
        reason:         row.override_reason ?? "",
        by:             "Admin",   // TODO: look up real user name when auth is added
        overrideUsedAt: row.override_at ?? undefined,
      }
    : undefined;

  return {
    id:           row.booking_ref,
    guestName:    row.guests?.name    ?? "",
    phone:        row.guests?.phone   ?? "",
    roomNumber:   row.rooms?.room_number ?? "",
    roomCategory: cap(row.room_category_at_booking),
    checkIn:      formatDateForDisplay(row.check_in_date),
    checkOut:     formatDateForDisplay(row.check_out_date),
    nights:       row.nights,
    status:       DB_TO_BOOKING_STATUS[row.status] ?? "Confirmed",
    payment:      DB_TO_PAYMENT_STATUS[row.payment_status] ?? "Unpaid",
    totalAmount:  row.total_amount,
    amountPaid:   row.paid_amount,
    totalGuests:  row.total_guests,
    additionalGuests: (row.booking_guests ?? [])
      .slice()
      .sort((a, b) => a.sort_order - b.sort_order)
      .map(g => ({ name: g.name, nationality: g.nationality ?? "" })),
    checkoutOverride: override,
    createdAt:    row.created_at,
    checkedInAt:  row.checked_in_at  ?? undefined,
    checkedOutAt: row.checked_out_at ?? undefined,
  };
}

// ─────────────────────────────────────────────────────────────
// SELECT FRAGMENT  (reused across queries)
// ─────────────────────────────────────────────────────────────
const BOOKING_SELECT = `
  *,
  rooms!room_id ( room_number, category ),
  guests!primary_guest_id ( name, phone ),
  booking_guests ( name, nationality, sort_order )
`;

// ─────────────────────────────────────────────────────────────
// PURE HELPERS  (no DB call — used by context for local state)
// ─────────────────────────────────────────────────────────────

/**
 * Booking → Room status mapping (for local state sync).
 *   Confirmed   → Reserved
 *   Checked In  → Occupied
 *   Checked Out → Cleaning
 *   Cancelled   → Available
 */
const BOOKING_TO_ROOM_STATUS: Partial<Record<BookingStatus, RoomStatus>> = {
  "Confirmed":   "Reserved",
  "Checked In":  "Occupied",
  "Checked Out": "Cleaning",
  "Cancelled":   "Available",
};

export function bookingToRoomStatus(
  bookingStatus: BookingStatus
): RoomStatus | undefined {
  return BOOKING_TO_ROOM_STATUS[bookingStatus];
}

/**
 * Derive PaymentStatus from raw totals (pure, no DB).
 * Mirrors the Postgres trigger fn_sync_payment_status.
 */
export function derivePaymentStatus(
  totalAmount: number,
  amountPaid: number
): PaymentStatus {
  if (amountPaid <= 0)           return "Unpaid";
  if (amountPaid >= totalAmount) return "Paid";
  return "Partial";
}

// ─────────────────────────────────────────────────────────────
// READ
// ─────────────────────────────────────────────────────────────

/**
 * Fetch all bookings with room, guest, and additional-guest data.
 * Returns the most recent bookings first.
 */
export async function getAllBookings(): Promise<MockBooking[]> {
  const { data, error } = await supabase
    .from("bookings")
    .select(BOOKING_SELECT)
    .order("created_at", { ascending: false });

  if (error) throw error;
  return (data as BookingRow[]).map(mapBooking);
}

// ─────────────────────────────────────────────────────────────
// GUEST LOOKUP  (used internally by createBooking)
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// DIAGNOSTIC HELPER  (internal — never exported)
// ─────────────────────────────────────────────────────────────

/**
 * Log every Supabase error field individually so the real failure reason
 * is always visible, even when the browser console collapses objects to "{}".
 */
function logSupabaseError(
  label: string,
  error: { message?: string; details?: string; hint?: string; code?: string } | null,
  status?: number,
  statusText?: string,
  payload?: unknown,
): never {
  console.error(`──────────── [createBooking] ${label} FAILED ────────────`);
  console.error("  message    :", error?.message    ?? "(none)");
  console.error("  details    :", error?.details    ?? "(none)");
  console.error("  hint       :", error?.hint       ?? "(none)");
  console.error("  code       :", error?.code       ?? "(none)");
  if (status     !== undefined) console.error("  HTTP status:", status, statusText ?? "");
  if (payload    !== undefined) console.error("  payload    :", payload);
  console.error("  full error :", error);
  console.error("────────────────────────────────────────────────────────");

  throw new Error(
    `[createBooking] ${label} failed — ${error?.message ?? "unknown error"}` +
    (error?.code    ? ` (code: ${error.code})`         : "") +
    (error?.hint    ? ` | hint: ${error.hint}`          : "") +
    (error?.details ? ` | details: ${error.details}`    : ""),
  );
}

// ─────────────────────────────────────────────────────────────
// GUEST LOOKUP  (used internally by createBooking)
// ─────────────────────────────────────────────────────────────

/**
 * Return the UUID of an existing guest matching the phone number,
 * or create a minimal guest profile and return its UUID.
 *
 * This links every booking to a guest record without requiring the
 * UI to pre-select a profile. When the user later adds a full guest
 * profile (email, nationality, notes), they can merge records.
 */
async function findOrCreateGuest(
  name: string,
  phone: string
): Promise<string> {
  // 1. Try to find an existing guest by phone
  const { data: existing } = await supabase
    .from("guests")
    .select("id")
    .eq("phone", phone.trim())
    .maybeSingle();

  if (existing) {
    console.log("[createBooking] Step 1 — found existing guest:", existing.id);
    return existing.id;
  }

  // 2. Not found — create a minimal profile.
  //    Email is a placeholder; it can be updated when the guest
  //    completes their profile. Using phone ensures uniqueness.
  const placeholderEmail = `${phone.replace(/\W/g, "")}.noemail@hotel.local`;
  const guestPayload = { name: name.trim(), phone: phone.trim(), email: placeholderEmail };

  console.log("[createBooking] Step 1 — creating new guest, payload:", guestPayload);

  const { data: created, error, status, statusText } = await supabase
    .from("guests")
    .insert(guestPayload)
    .select("id")
    .single();

  if (error) logSupabaseError("Step 1 — INSERT guests", error, status, statusText, guestPayload);

  console.log("[createBooking] Step 1 — guest created:", created!.id);
  return created!.id;
}

// ─────────────────────────────────────────────────────────────
// CREATE
// ─────────────────────────────────────────────────────────────

/**
 * Create a booking in Supabase.
 *
 * Steps:
 *   1. Find or create the primary guest profile.
 *   2. Look up the room UUID from room_number.
 *   3. Insert the booking record.
 *   4. Insert any additional guests into booking_guests.
 *   5. Return the full booking (re-fetched with joins).
 */
export async function createBooking(booking: MockBooking): Promise<MockBooking> {
  console.log("[createBooking] Starting — booking ref will be assigned by DB, guest:", booking.guestName, "room:", booking.roomNumber);

  // ── Step 1 — Resolve primary guest UUID ───────────────────
  const guestId = await findOrCreateGuest(booking.guestName, booking.phone);

  // ── Step 2 — Resolve room UUID ─────────────────────────────
  console.log("[createBooking] Step 2 — looking up room_number:", booking.roomNumber);

  const { data: roomRow, error: roomErr, status: roomStatus, statusText: roomStatusText } = await supabase
    .from("rooms")
    .select("id")
    .eq("room_number", booking.roomNumber)
    .single();

  if (roomErr || !roomRow) {
    logSupabaseError(
      `Step 2 — SELECT rooms (room_number=${booking.roomNumber})`,
      roomErr,
      roomStatus,
      roomStatusText,
    );
  }

  console.log("[createBooking] Step 2 — room UUID:", roomRow!.id);

  // ── Step 3 — Insert booking row ────────────────────────────
  const bookingPayload = {
    room_id:                  roomRow!.id,
    primary_guest_id:         guestId,
    check_in_date:            parseDisplayDate(booking.checkIn),
    check_out_date:           parseDisplayDate(booking.checkOut),
    room_category_at_booking: booking.roomCategory.toLowerCase(),
    total_guests:             booking.totalGuests,
    status:                   "confirmed",
    total_amount:             booking.totalAmount,
    paid_amount:              booking.amountPaid,
  };

  console.log("[createBooking] Step 3 — INSERT bookings, payload:", bookingPayload);

  const {
    data: inserted,
    error: bookingErr,
    status: bookingStatus,
    statusText: bookingStatusText,
  } = await supabase
    .from("bookings")
    .insert(bookingPayload)
    .select("id, booking_ref")
    .single();

  if (bookingErr || !inserted) {
    logSupabaseError("Step 3 — INSERT bookings", bookingErr, bookingStatus, bookingStatusText, bookingPayload);
  }

  console.log("[createBooking] Step 3 — booking inserted:", inserted!.booking_ref, "(uuid:", inserted!.id + ")");

  // ── Step 4 — Insert additional guests ─────────────────────
  if (booking.additionalGuests.length > 0) {
    const guestRows = booking.additionalGuests.map((g, i) => ({
      booking_id:  inserted!.id,
      name:        g.name,
      nationality: g.nationality || null,
      sort_order:  i,
    }));

    console.log("[createBooking] Step 4 — INSERT booking_guests, rows:", guestRows);

    const {
      error: agErr,
      status: agStatus,
      statusText: agStatusText,
    } = await supabase
      .from("booking_guests")
      .insert(guestRows);

    if (agErr) {
      logSupabaseError("Step 4 — INSERT booking_guests", agErr, agStatus, agStatusText, guestRows);
    }

    console.log("[createBooking] Step 4 — additional guests inserted:", guestRows.length);
  } else {
    console.log("[createBooking] Step 4 — no additional guests, skipping booking_guests insert");
  }

  // ── Step 5 — Re-fetch with all joins ───────────────────────
  console.log("[createBooking] Step 5 — re-fetching booking with joins, uuid:", inserted!.id);

  const {
    data: full,
    error: fetchErr,
    status: fetchStatus,
    statusText: fetchStatusText,
  } = await supabase
    .from("bookings")
    .select(BOOKING_SELECT)
    .eq("id", inserted!.id)
    .single();

  if (fetchErr || !full) {
    logSupabaseError("Step 5 — SELECT bookings (re-fetch with joins)", fetchErr, fetchStatus, fetchStatusText);
  }

  console.log("[createBooking] Step 5 — complete. Booking ref:", (full as BookingRow).booking_ref);
  return mapBooking(full as BookingRow);
}

// ─────────────────────────────────────────────────────────────
// UPDATE — STATUS
// ─────────────────────────────────────────────────────────────

/**
 * Change a booking's status in Supabase.
 * The DB triggers fn_stamp_booking_timestamps and fn_sync_room_status
 * handle the side-effects server-side automatically.
 *
 * The id parameter is the booking_ref ("BK-1041"), not the UUID.
 */
export async function updateBookingStatus(
  id: string,
  newStatus: BookingStatus
): Promise<void> {
  const { error } = await supabase
    .from("bookings")
    .update({ status: BOOKING_STATUS_TO_DB[newStatus] })
    .eq("booking_ref", id);

  if (error) throw error;
}

// ─────────────────────────────────────────────────────────────
// UPDATE — PAYMENT
// ─────────────────────────────────────────────────────────────

/**
 * Record a payment against a booking.
 *
 * Inserts a row into the payments table.
 * The DB trigger fn_sync_paid_amount adds the amount to bookings.paid_amount,
 * and fn_sync_payment_status re-derives payment_status automatically.
 *
 * The id parameter is the booking_ref ("BK-1041"), not the UUID.
 */
export async function recordPayment(
  id: string,
  amount: number
): Promise<void> {
  // ── Step 1: Resolve booking UUID from booking_ref ─────────────
  console.log("[recordPayment] Step 1 — looking up booking_ref:", id);

  const {
    data: booking,
    error: lookupErr,
    status: lookupStatus,
    statusText: lookupStatusText,
  } = await supabase
    .from("bookings")
    .select("id, paid_amount, total_amount")
    .eq("booking_ref", id)
    .single();

  if (lookupErr) {
    console.error("──────────── [recordPayment] Step 1 — SELECT bookings FAILED ────────────");
    console.error("  message    :", lookupErr.message);
    console.error("  details    :", lookupErr.details);
    console.error("  hint       :", lookupErr.hint);
    console.error("  code       :", lookupErr.code);
    console.error("  HTTP status:", lookupStatus, lookupStatusText);
    console.error("  booking_ref:", id);
    console.error("────────────────────────────────────────────────────────────────────────");
    throw new Error(
      `[recordPayment] Booking lookup failed — ${lookupErr.message}` +
      (lookupErr.code    ? ` (code: ${lookupErr.code})`        : "") +
      (lookupErr.hint    ? ` | hint: ${lookupErr.hint}`         : "") +
      (lookupErr.details ? ` | details: ${lookupErr.details}`   : "")
    );
  }

  if (!booking) {
    // No error object but also no row — booking_ref not found
    throw new Error(`[recordPayment] Booking not found for booking_ref: ${id}`);
  }

  console.log("[recordPayment] Step 1 — booking found, uuid:", booking.id,
    "| paid:", booking.paid_amount, "/ total:", booking.total_amount);

  // ── Step 2: Clamp amount and insert into payments ─────────────
  const safeAmount = Math.min(amount, booking.total_amount - booking.paid_amount);
  if (safeAmount <= 0) {
    console.log("[recordPayment] safeAmount is 0 or negative — nothing to insert, returning.");
    return;
  }

  const paymentPayload = { booking_id: booking.id, amount: safeAmount };
  console.log("[recordPayment] Step 2 — INSERT into payments, payload:", paymentPayload);

  const {
    error: payErr,
    status: payStatus,
    statusText: payStatusText,
  } = await supabase
    .from("payments")
    .insert(paymentPayload);

  if (payErr) {
    console.error("──────────── [recordPayment] Step 2 — INSERT payments FAILED ────────────");
    console.error("  message    :", payErr.message);
    console.error("  details    :", payErr.details);
    console.error("  hint       :", payErr.hint);
    console.error("  code       :", payErr.code);
    console.error("  HTTP status:", payStatus, payStatusText);
    console.error("  payload    :", paymentPayload);
    console.error("────────────────────────────────────────────────────────────────────────");
    // Common causes:
    //   42501 — RLS blocks INSERT on payments for this role →
    //            add policy: INSERT ON payments FOR authenticated USING (true)
    //   23503 — FK violation: booking_id not found in bookings table
    //   23514 — CHECK constraint violation on amount value
    if (payErr.code === "42501") {
      console.error("[recordPayment] RLS BLOCK: authenticated role lacks INSERT on payments.",
        "Fix: add INSERT policy on payments table for the authenticated role.");
    }
    throw new Error(
      `[recordPayment] Payment insert failed — ${payErr.message}` +
      (payErr.code    ? ` (code: ${payErr.code})`       : "") +
      (payErr.hint    ? ` | hint: ${payErr.hint}`        : "") +
      (payErr.details ? ` | details: ${payErr.details}`  : "")
    );
  }

  console.log("[recordPayment] Step 2 — payment inserted successfully, amount:", safeAmount);
  // DB triggers fn_sync_paid_amount + fn_sync_payment_status update
  // bookings.paid_amount and bookings.payment_status automatically.
}

// ─────────────────────────────────────────────────────────────
// UPDATE — ADMIN OVERRIDE CHECKOUT
// ─────────────────────────────────────────────────────────────

/**
 * Admin-only: check out a booking that has an outstanding balance.
 * Sets status to "checked_out", stamps the override audit fields, and
 * records checked_out_at. The DB trigger syncs the room to "cleaning".
 *
 * @param id            booking_ref ("BK-1041"), not the UUID
 * @param overrideReason free-text reason entered by the admin
 * @param overrideBy    auth.users UUID of the admin performing the override
 */
export async function checkoutWithOverride(
  id: string,
  overrideReason: string,
  overrideBy: string,
): Promise<void> {
  const updatePayload = {
    status:            "checked_out",
    override_checkout: true,
    override_reason:   overrideReason.trim() || "No reason provided",
    override_by:       overrideBy,
    override_at:       new Date().toISOString(),
  };

  console.log("[checkoutWithOverride] UPDATE bookings, booking_ref:", id, "| payload:", updatePayload);

  const { error, status, statusText } = await supabase
    .from("bookings")
    .update(updatePayload)
    .eq("booking_ref", id);

  if (error) {
    console.error("──────────── [checkoutWithOverride] UPDATE bookings FAILED ────────────");
    console.error("  message    :", error.message);
    console.error("  details    :", error.details);
    console.error("  hint       :", error.hint);
    console.error("  code       :", error.code);
    console.error("  HTTP status:", status, statusText);
    console.error("  booking_ref:", id);
    console.error("  payload    :", updatePayload);
    console.error("─────────────────────────────────────────────────────────────────────");
    // Common causes:
    //   42501 — RLS blocks UPDATE on bookings for this role
    //   42703 — column does not exist (e.g. override_checkout / override_at
    //            name differs from actual DB schema — check column names in
    //            Supabase Table Editor → bookings table)
    //   22P02 — invalid enum value for status field
    if (error.code === "42501") {
      console.error("[checkoutWithOverride] RLS BLOCK: authenticated role lacks",
        "UPDATE permission on the bookings table.");
    }
    if (error.code === "42703") {
      console.error("[checkoutWithOverride] SCHEMA MISMATCH: one of the columns",
        "override_checkout / override_reason / override_at does not exist.",
        "Check the exact column names in Supabase → bookings table.");
    }
    throw new Error(
      `[checkoutWithOverride] Update failed — ${error.message}` +
      (error.code    ? ` (code: ${error.code})`       : "") +
      (error.hint    ? ` | hint: ${error.hint}`        : "") +
      (error.details ? ` | details: ${error.details}`  : "")
    );
  }

  console.log("[checkoutWithOverride] succeeded for booking_ref:", id);
  // DB trigger fn_sync_room_status sets the room to "cleaning" automatically.
}

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
import {
  type MockBooking,
  type BookingStatus,
  type BookingRoomStatus,
  type BookingRoom,
  type BookingExtraCharge,
  type PaymentStatus,
  type PaymentMethod,
  type RoomStatus,
  type CheckoutOverride,
  type AdditionalGuest,
  type CreateBookingInput,
  isPlaceholderEmail,
} from "@/lib/mockData";

// ─────────────────────────────────────────────────────────────
// RAW ROW TYPES  (shapes returned by Supabase with joins)
// ─────────────────────────────────────────────────────────────

/** One booking_rooms row as returned by the nested JOIN in BOOKING_SELECT. */
type BookingRoomRow = {
  id:                     string;
  booking_id:             string;
  room_id:                string;
  check_in_date:          string;
  check_out_date:         string;
  nights:                 number;
  room_category:          string;   // lowercase enum, e.g. "deluxe"
  booking_rate:           number;
  status:                 string;   // lowercase enum, e.g. "confirmed"
  actual_checkout_date:   string | null;
  early_nights_deducted:  number;   // NOT NULL DEFAULT 0 in DB
  early_deduction_amount: number;   // NOT NULL DEFAULT 0 in DB
  confirmed_at:           string | null;
  checked_in_at:          string | null;
  checked_out_at:         string | null;
  cancelled_at:           string | null;
  // Nested JOIN from rooms table
  rooms: { room_number: string; category: string } | null;
};

/** One booking_extra_charges row as returned by the nested JOIN in BOOKING_SELECT. */
type BookingExtraChargeRow = {
  id:              string;
  booking_room_id: string | null;
  amount:          number;
  reason:          string;
  charge_type:     string | null;
  applied_at:      string;
};

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
  fixed_rate:               number | null;
  booking_rate:             number | null;
  extra_charge_amount:      number | null;
  extra_charge_reason:      string | null;
  override_checkout:        boolean;
  override_reason:          string | null;
  override_by:              string | null;
  override_at:              string | null;
  confirmed_at:             string | null;
  checked_in_at:            string | null;
  checked_out_at:           string | null;
  cancelled_at:             string | null;
  // ── Legacy early checkout + additional discount (bookings table) ──
  actual_checkout_date:       string | null;
  early_nights_deducted:      number | null;
  early_deduction_amount:     number | null;
  additional_discount_amount: number | null;
  additional_discount_reason: string | null;
  additional_discount_by:     string | null;
  additional_discount_at:     string | null;
  last_payment_method:        string | null;
  created_at:               string;
  updated_at:               string;
  // ── Joined relations ──────────────────────────────────────
  booking_rooms:          BookingRoomRow[];
  booking_extra_charges:  BookingExtraChargeRow[];
  guests: { id: string; name: string; phone: string; email: string } | null;
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

const DB_TO_BOOKING_ROOM_STATUS: Record<string, BookingRoomStatus> = {
  confirmed:          "Confirmed",
  checked_in:         "Checked In",
  checked_out:        "Checked Out",
  checked_out_early:  "Checked Out Early",
  cancelled:          "Cancelled",
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
// ROW MAPPERS
// ─────────────────────────────────────────────────────────────

/** Maps one BookingRoomRow (from nested JOIN) to the BookingRoom frontend type. */
function mapBookingRoom(row: BookingRoomRow): BookingRoom {
  return {
    id:           row.id,
    bookingId:    row.booking_id,
    roomId:       row.room_id,
    roomNumber:   row.rooms?.room_number ?? "",
    roomCategory: cap(row.room_category),
    checkIn:      formatDateForDisplay(row.check_in_date),
    checkOut:     formatDateForDisplay(row.check_out_date),
    checkInISO:   row.check_in_date,
    checkOutISO:  row.check_out_date,
    nights:       row.nights,
    bookingRate:  row.booking_rate,
    status:       DB_TO_BOOKING_ROOM_STATUS[row.status] ?? "Confirmed",
    actualCheckoutDate:   row.actual_checkout_date  ?? undefined,
    earlyNightsDeducted:  row.early_nights_deducted,
    earlyDeductionAmount: row.early_deduction_amount,
    confirmedAt:  row.confirmed_at  ?? undefined,
    checkedInAt:  row.checked_in_at  ?? undefined,
    checkedOutAt: row.checked_out_at ?? undefined,
    cancelledAt:  row.cancelled_at   ?? undefined,
  };
}

function mapBooking(row: BookingRow): MockBooking {
  const override: CheckoutOverride | undefined = row.override_checkout
    ? {
        used:           true,
        reason:         row.override_reason ?? "",
        by:             "Admin",   // TODO: look up real user name when auth is added
        overrideUsedAt: row.override_at ?? undefined,
      }
    : undefined;

  // ── Map per-room junction rows ────────────────────────────
  const rooms: BookingRoom[] = (row.booking_rooms ?? []).map(mapBookingRoom);

  // ── Map extra charges ─────────────────────────────────────
  const extraCharges: BookingExtraCharge[] = (row.booking_extra_charges ?? [])
    .map(ec => ({
      id:             ec.id,
      bookingId:      row.id,
      bookingRoomId:  ec.booking_room_id ?? undefined,
      amount:         ec.amount,
      reason:         ec.reason,
      chargeType:     ec.charge_type ?? undefined,
      appliedAt:      ec.applied_at,
    }));

  // ── Backward-compat shims — sourced from rooms[0] ─────────
  // For single-room bookings (rooms.length === 1) these match
  // existing behaviour exactly. For multi-room bookings, callers
  // that need per-room detail should read booking.rooms[i] directly.
  const r0 = rooms[0];

  return {
    id:           row.booking_ref,
    guestName:    row.guests?.name    ?? "",
    phone:        row.guests?.phone   ?? "",
    email:        row.guests?.email && !isPlaceholderEmail(row.guests.email)
                    ? row.guests.email
                    : undefined,
    guestId:      row.guests?.id ?? undefined,

    // ── New multi-room fields ─────────────────────────────────
    rooms,
    extraCharges,

    // ── Backward-compat shims (sourced from rooms[0]) ─────────
    roomNumber:   r0?.roomNumber   ?? "",
    roomCategory: r0?.roomCategory ?? cap(row.room_category_at_booking),
    checkIn:      r0?.checkIn      ?? formatDateForDisplay(row.check_in_date),
    checkOut:     r0?.checkOut     ?? formatDateForDisplay(row.check_out_date),
    checkInISO:   r0?.checkInISO   ?? row.check_in_date  ?? undefined,
    checkOutISO:  r0?.checkOutISO  ?? row.check_out_date ?? undefined,
    nights:       r0?.nights       ?? row.nights,
    bookingRate:  r0?.bookingRate  ?? row.booking_rate   ?? undefined,

    // ── Fields that remain on the bookings table ──────────────
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
    fixedRate:          row.fixed_rate          ?? undefined,
    // Legacy scalar extra-charge columns — kept during transition.
    // New charges are in extraCharges[] (from booking_extra_charges table).
    extraChargeAmount:  row.extra_charge_amount ?? undefined,
    extraChargeReason:  row.extra_charge_reason ?? undefined,
    createdAt:    row.created_at,
    checkedInAt:  row.checked_in_at  ?? undefined,
    checkedOutAt: row.checked_out_at ?? undefined,

    // ── Early checkout shims (preferred source: rooms[0]) ─────
    // Falls back to legacy bookings columns for robustness (e.g.
    // if booking_rooms JOIN returns empty for an edge-case row).
    actualCheckoutDate:   r0?.actualCheckoutDate
                            ?? row.actual_checkout_date   ?? undefined,
    earlyNightsDeducted:  r0 ? r0.earlyNightsDeducted
                             : (row.early_nights_deducted  ?? undefined),
    earlyDeductionAmount: r0 ? r0.earlyDeductionAmount
                             : (row.early_deduction_amount ?? undefined),

    // ── Additional discount (bookings table only) ─────────────
    additionalDiscountAmount: row.additional_discount_amount ?? undefined,
    additionalDiscountReason: row.additional_discount_reason ?? undefined,
    additionalDiscountBy:     row.additional_discount_by     ?? undefined,
    additionalDiscountAt:     row.additional_discount_at     ?? undefined,
    lastPaymentMethod: (row.last_payment_method ?? undefined) as
      MockBooking["lastPaymentMethod"],
  };
}

// ─────────────────────────────────────────────────────────────
// SELECT FRAGMENT  (reused across queries)
// ─────────────────────────────────────────────────────────────
// rooms!room_id is intentionally dropped — room data now comes
// from the booking_rooms nested join. The bookings.room_id column
// is kept as a legacy backward-compat column but not joined here.
const BOOKING_SELECT = `
  *,
  guests!primary_guest_id ( id, name, phone, email ),
  booking_guests ( name, nationality, sort_order ),
  booking_rooms (
    id, booking_id, room_id,
    check_in_date, check_out_date, nights,
    room_category, booking_rate, status,
    actual_checkout_date, early_nights_deducted, early_deduction_amount,
    confirmed_at, checked_in_at, checked_out_at, cancelled_at,
    rooms ( room_number, category )
  ),
  booking_extra_charges ( id, booking_room_id, amount, reason, charge_type, applied_at )
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

/**
 * Fetches a single booking by booking_ref (e.g. "BK-1037").
 * Returns null if no matching row — caller should 404 in that case.
 * Throws on DB error.
 */
export async function getBookingByRef(bookingRef: string): Promise<MockBooking | null> {
  const { data, error } = await supabase
    .from("bookings")
    .select(BOOKING_SELECT)
    .eq("booking_ref", bookingRef)
    .maybeSingle();

  if (error) {
    console.error("[getBookingByRef] query failed:");
    console.error("  bookingRef :", bookingRef);
    console.error("  message    :", error.message);
    console.error("  details    :", error.details);
    console.error("  hint       :", error.hint);
    console.error("  code       :", error.code);
    throw new Error(
      `[getBookingByRef] failed — ${error.message}` +
      (error.code    ? ` (code: ${error.code})`      : "") +
      (error.hint    ? ` | hint: ${error.hint}`       : "") +
      (error.details ? ` | details: ${error.details}` : ""),
    );
  }

  return data ? mapBooking(data as BookingRow) : null;
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
  phone: string,
  email?: string,
): Promise<string> {
  const trimmedPhone = phone.trim();
  const trimmedEmail = email?.trim() || undefined;

  // ── 1. Look up by phone ───────────────────────────────────────
  const { data: existing } = await supabase
    .from("guests")
    .select("id, email")
    .eq("phone", trimmedPhone)
    .maybeSingle();

  if (existing) {
    console.log("[createBooking] Step 1 — found existing guest:", existing.id);

    // ── 1a. Upgrade placeholder email if caller supplied a real one ──
    if (trimmedEmail && isPlaceholderEmail(existing.email)) {
      try {
        const { error: upErr, status: upStatus, statusText: upST } = await supabase
          .from("guests")
          .update({ email: trimmedEmail })
          .eq("id", existing.id);

        if (upErr) {
          if (upErr.code === "23505") {
            // Another guest already owns this email — skip silently
            console.warn(
              "[createBooking] Step 1 — email already in use, skipping upgrade:",
              trimmedEmail,
            );
          } else {
            logSupabaseError("Step 1 — UPDATE guests email", upErr, upStatus, upST, { id: existing.id, email: trimmedEmail });
            throw upErr;
          }
        } else {
          console.log("[createBooking] Step 1 — upgraded placeholder email for guest:", existing.id);
        }
      } catch (err: unknown) {
        // Re-throw unless it was already handled above (23505 unique violation)
        const pgErr = err as { code?: string };
        if (pgErr?.code !== "23505") throw err;
      }
    }

    return existing.id;
  }

  // ── 2. Not found — create a minimal profile ───────────────────
  //    Email: use the real email if provided; otherwise placeholder.
  //    On 23505 collision (real email already owned by another guest),
  //    fall back to placeholder and retry — booking must not crash.
  const placeholderEmail = `${trimmedPhone.replace(/\W/g, "")}.noemail@hotel.local`;
  let emailToUse = trimmedEmail ?? placeholderEmail;

  console.log("[createBooking] Step 1 — creating new guest, email:", emailToUse);

  let { data: created, error, status, statusText } = await supabase
    .from("guests")
    .insert({ name: name.trim(), phone: trimmedPhone, email: emailToUse })
    .select("id")
    .single();

  // If the provided real email collides with another guest, retry with placeholder
  if (error?.code === "23505" && emailToUse !== placeholderEmail) {
    console.warn(
      `[findOrCreateGuest] Email '${emailToUse}' already in use by another guest.` +
      ` Falling back to placeholder for this booking.`,
    );
    emailToUse = placeholderEmail;
    ({ data: created, error, status, statusText } = await supabase
      .from("guests")
      .insert({ name: name.trim(), phone: trimmedPhone, email: emailToUse })
      .select("id")
      .single());
  }

  if (error) {
    logSupabaseError("Step 1 — INSERT guests", error, status, statusText,
      { name: name.trim(), phone: trimmedPhone, email: emailToUse });
    throw error;
  }

  console.log("[createBooking] Step 1 — guest created:", created!.id);
  return created!.id;
}

// ─────────────────────────────────────────────────────────────
// CREATE
// ─────────────────────────────────────────────────────────────

/**
 * Create a booking in Supabase.
 *
 * Accepts a CreateBookingInput (the write-path type) rather than MockBooking
 * (the read/display type). This allows multi-room bookings: input.rooms[] maps
 * directly to the p_rooms[] parameter of create_booking_with_rooms RPC.
 *
 * Steps:
 *   1.   Find or create the primary guest profile.
 *   2.   Resolve room UUID(s) from room_number(s) via a single IN query.
 *   2.5. Overlap check for every room in the booking.
 *   3.   Call create_booking_with_rooms RPC (booking + booking_rooms + rooms.status
 *        + initial payment — all in one atomic transaction).
 *   3.5. Non-fatal UPDATE bookings.fixed_rate (RPC doesn't write this column).
 *   4.   Insert additional guests into booking_guests.
 *   5.   Re-fetch with all joins and return mapBooking().
 */
export async function createBooking(
  input: CreateBookingInput,
): Promise<MockBooking> {
  console.log(
    "[createBooking] Starting — booking_ref (client-assigned):", input.id,
    "| guest:", input.primaryGuest.name,
    "| rooms:", input.rooms.map(r => r.roomNumber).join(", "),
  );

  // ── Step 1 — Resolve primary guest UUID ───────────────────────────────────
  const guestId = await findOrCreateGuest(
    input.primaryGuest.name,
    input.primaryGuest.phone,
    input.primaryGuest.email,
  );

  // ── Step 2 — Resolve room UUID(s) via single IN query ─────────────────────
  const roomNumbers = input.rooms.map(r => r.roomNumber);
  console.log("[createBooking] Step 2 — looking up rooms:", roomNumbers.join(", "));

  const {
    data:       roomRows,
    error:      roomErr,
    status:     roomStatus,
    statusText: roomStatusText,
  } = await supabase
    .from("rooms")
    .select("id, room_number")
    .in("room_number", roomNumbers);

  if (roomErr) {
    logSupabaseError(
      `Step 2 — SELECT rooms (room_numbers: ${roomNumbers.join(", ")})`,
      roomErr, roomStatus, roomStatusText,
    );
  }

  // Build roomNumber → UUID map; verify every requested room was found
  const roomUUIDMap = new Map<string, string>(
    (roomRows ?? []).map(r => [r.room_number as string, r.id as string]),
  );
  for (const r of input.rooms) {
    if (!roomUUIDMap.has(r.roomNumber)) {
      logSupabaseError(
        `Step 2 — room not found (room_number=${r.roomNumber})`,
        null, undefined, undefined,
      );
    }
  }
  console.log("[createBooking] Step 2 — resolved UUIDs:", Object.fromEntries(roomUUIDMap));

  // ── Step 2.5 — Overlap / double-booking check (per room) ──────────────────
  //
  // Query booking_rooms for any active row on each room whose dates overlap
  // the requested range using the half-open interval rule:
  //   existing.check_in_date  < new.check_out_date   (existing starts before new ends)
  //   existing.check_out_date > new.check_in_date    (existing ends after new starts)
  //
  // "Checked Out" and "Cancelled" are excluded. Same-day checkout→check-in is
  // ALLOWED: check_in_date of the new booking equals check_out_date of the old,
  // so `existing.check_out_date > new.check_in_date` is FALSE (equal, not >).
  //
  // Layer A (UI useMemo) and Layer B (handleSubmit guard) have already run;
  // this is the final DB-level guard against race conditions.
  for (const roomInput of input.rooms) {
    const roomUUID = roomUUIDMap.get(roomInput.roomNumber)!;
    console.log(
      `[createBooking] Step 2.5 — overlap check: room ${roomInput.roomNumber}` +
      ` (uuid: ${roomUUID}) ${roomInput.checkIn} → ${roomInput.checkOut}`,
    );

    const { data: conflictRows, error: conflictErr } = await supabase
      .from("booking_rooms")
      .select("check_in_date, check_out_date, status, bookings!booking_id(booking_ref)")
      .eq("room_id", roomUUID)
      .in("status", ["confirmed", "checked_in"])
      .lt("check_in_date", roomInput.checkOut)   // existing starts before new ends
      .gt("check_out_date", roomInput.checkIn);  // existing ends after new starts

    if (conflictErr) {
      // Non-fatal: UI layers already checked; log and proceed.
      console.warn(
        `[createBooking] Step 2.5 — overlap query failed for room ${roomInput.roomNumber}, proceeding:`,
        conflictErr.message,
      );
    } else if (conflictRows && conflictRows.length > 0) {
      const c = conflictRows[0];
      const cBookings = c.bookings as Array<{ booking_ref: string }>;
      const msg =
        `Room ${roomInput.roomNumber} is unavailable for this date range. ` +
        `Existing booking ${cBookings[0]?.booking_ref ?? "unknown"} covers ` +
        `${c.check_in_date} – ${c.check_out_date} (status: ${c.status}). ` +
        `Please select another room or different dates.`;
      console.error("[createBooking] Step 2.5 — BLOCKED:", msg);
      throw new Error(msg);
    } else {
      console.log(`[createBooking] Step 2.5 — room ${roomInput.roomNumber} is available`);
    }
  }

  // ── Step 3 — create_booking_with_rooms RPC ───────────────────────────────
  // Atomically INSERTs:
  //   • bookings row        (status = confirmed, booking_ref = input.id)
  //   • booking_rooms row(s) with per-room rate, dates, and nights
  //   • rooms.status        → reserved for each room
  //   • payments row        (when p_initial_payment > 0 AND p_payment_method IS NOT NULL)
  // Returns the new booking UUID.
  //
  // NOTE: The RPC does NOT write fixed_rate (no booking_rooms equivalent).
  //       Step 3.5 below handles that as a non-fatal follow-up UPDATE.
  const roomsPayload = input.rooms.map(roomInput => ({
    room_id:        roomUUIDMap.get(roomInput.roomNumber)!,
    check_in_date:  roomInput.checkIn,
    check_out_date: roomInput.checkOut,
    nights:         roomInput.nights,
    category:       roomInput.roomCategory.toLowerCase(),
    rate:           roomInput.bookingRate ?? roomInput.fixedRate ?? 0,
  }));

  console.log(
    "[createBooking] Step 3 — RPC create_booking_with_rooms" +
    ` | booking_ref: ${input.id}` +
    ` | total_amount: ${input.totalAmount}` +
    ` | rooms:`, roomsPayload,
  );

  const { data: bookingUUID, error: rpcErr } = await supabase.rpc(
    "create_booking_with_rooms",
    {
      p_booking_ref:      input.id,
      p_primary_guest_id: guestId,
      p_total_guests:     input.totalGuests,
      p_rooms:            roomsPayload,
      p_total_amount:     input.totalAmount,
      p_initial_payment:  input.amountPaid > 0 ? input.amountPaid        : 0,
      p_payment_method:   input.amountPaid > 0 ? input.amountPaidMethod  : null,
      p_recorded_by:      null,
      p_status:           BOOKING_STATUS_TO_DB[input.status] ?? "confirmed",
    },
  );

  if (rpcErr || !bookingUUID) {
    logSupabaseError(
      "Step 3 — RPC create_booking_with_rooms",
      rpcErr,
      undefined,
      undefined,
      { p_booking_ref: input.id, rooms: roomsPayload },
    );
  }

  console.log("[createBooking] Step 3 — RPC succeeded, booking UUID:", bookingUUID);

  // ── Step 3.5 — UPDATE bookings.fixed_rate (non-fatal) ─────────────────────
  // fixed_rate is a booking-level concept with no booking_rooms equivalent.
  // mapBooking() reads row.fixed_rate directly, so it must be written here.
  // For multi-room bookings we use rooms[0]'s fixedRate — a v1 simplification
  // (all rooms share one published-rate audit entry on the bookings row).
  // Non-fatal: the booking is already committed; a missed fixed_rate is
  // cosmetic — it resolves on next page load via mapBooking's fallback chain.
  const primaryFixedRate = input.rooms[0]?.fixedRate;
  if (primaryFixedRate != null && primaryFixedRate > 0) {
    const { error: frErr } = await supabase
      .from("bookings")
      .update({ fixed_rate: primaryFixedRate })
      .eq("id", bookingUUID as string);

    if (frErr) {
      console.warn(
        "[createBooking] Step 3.5 — UPDATE bookings.fixed_rate FAILED (non-fatal):",
        frErr.message, "| booking UUID:", bookingUUID,
      );
    } else {
      console.log("[createBooking] Step 3.5 — fixed_rate written:", primaryFixedRate);
    }
  } else {
    console.log("[createBooking] Step 3.5 — no fixed_rate to write, skipping");
  }

  // ── Step 4 — Insert additional guests ─────────────────────────────────────
  if (input.additionalGuests.length > 0) {
    const guestRows = input.additionalGuests.map((g, i) => ({
      booking_id:  bookingUUID as string,
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

  // ── Step 5 — Re-fetch with all joins ──────────────────────────────────────
  console.log("[createBooking] Step 5 — re-fetching booking with joins, uuid:", bookingUUID);

  const {
    data: full,
    error: fetchErr,
    status: fetchStatus,
    statusText: fetchStatusText,
  } = await supabase
    .from("bookings")
    .select(BOOKING_SELECT)
    .eq("id", bookingUUID as string)
    .single();

  if (fetchErr || !full) {
    logSupabaseError("Step 5 — SELECT bookings (re-fetch with joins)", fetchErr, fetchStatus, fetchStatusText);
  }

  console.log("[createBooking] Step 5 — complete. Booking ref:", (full as BookingRow).booking_ref);
  return mapBooking(full as BookingRow);
}

// ─────────────────────────────────────────────────────────────
// UPDATE — BOOKING FIELDS
// ─────────────────────────────────────────────────────────────

/**
 * All editable booking fields — all optional so callers only pass what changed.
 * ISO date strings ("YYYY-MM-DD") for dates; no display-format parsing needed.
 */
export type UpdateBookingPayload = {
  guestName?:    string;
  phone?:        string;
  email?:        string;       // empty string = leave email unchanged (not cleared to placeholder)
  roomNumber?:   string;
  checkInISO?:   string;       // YYYY-MM-DD
  checkOutISO?:  string;       // YYYY-MM-DD
  // nights is omitted — it is a PostgreSQL GENERATED column (check_out_date - check_in_date).
  // Writing to it produces error 23508. Dates are sent instead; the DB recomputes nights.
  totalAmount?:  number;
  fixedRate?:    number | null;
  bookingRate?:  number | null;
  totalGuests?:        number;
  additionalGuests?:   AdditionalGuest[];
  roomCategory?: string;
};

/** A single payment transaction row from the `payments` table. */
export type Payment = {
  id:        string;
  amount:    number;
  method:    PaymentMethod;
  notes:     string | null;
  createdAt: string;          // ISO timestamp, e.g. "2026-05-06T10:32:00+06:00"
};

/**
 * Edit a booking's fields in Supabase.
 *
 * @param bookingRef      "BK-1041" — human-readable booking reference
 * @param changes         only the fields being changed need to be included
 * @param currentGuestId  UUID from MockBooking.guestId; guest row is skipped if undefined
 *
 * Steps:
 *   1. Fetch current booking (UUID, room_id, paid_amount, dates, status).
 *   2. If room or dates changed: overlap check (current booking excluded via .neq).
 *   3. Build bookings UPDATE payload.
 *   4. If totalAmount changed: derive payment_status manually
 *      (fn_sync_payment_status fires on paid_amount changes only, not total_amount).
 *   5. Execute bookings UPDATE.
 *   6. If room_id changed: cascade old-room and new-room statuses manually
 *      (fn_sync_room_status fires on status column changes only, not room_id changes).
 *   7. If guest fields changed and currentGuestId known: UPDATE guests row directly;
 *      23505 (email taken) → throw, not silent.
 *   8. Re-fetch with all joins, return mapBooking().
 */
export async function updateBooking(
  bookingRef: string,
  changes: UpdateBookingPayload,
  currentGuestId?: string,
): Promise<MockBooking> {
  console.log("[updateBooking] Starting — booking_ref:", bookingRef, "| changes:", changes);

  // ── Step 1 — Fetch current booking ─────────────────────────────────────
  const { data: current, error: curErr } = await supabase
    .from("bookings")
    .select("id, booking_ref, room_id, paid_amount, total_amount, status, check_in_date, check_out_date, booking_rooms(id, room_id)")
    .eq("booking_ref", bookingRef)
    .single();

  if (curErr || !current) {
    const msg = curErr?.message ?? "row not found";
    console.error("[updateBooking] Step 1 — SELECT bookings FAILED:", msg, curErr);
    throw new Error(`[updateBooking] Could not fetch booking ${bookingRef}: ${msg}`);
  }

  console.log("[updateBooking] Step 1 — uuid:", current.id,
    "| room_id:", current.room_id,
    "| paid:", current.paid_amount, "/ total:", current.total_amount,
    "| status:", current.status);

  // ── Step 2 — Overlap check (room changed, or dates changed, or both) ────
  // Always exclude the current booking itself via .neq so it doesn't block itself.
  const roomChanged  = changes.roomNumber !== undefined;
  const datesChanged = changes.checkInISO !== undefined || changes.checkOutISO !== undefined;

  let resolvedRoomId: string | undefined;   // set here if roomChanged; used in Steps 3 + 6

  if (roomChanged || datesChanged) {
    if (roomChanged) {
      // Resolve new room UUID
      const { data: roomRow, error: roomErr } = await supabase
        .from("rooms")
        .select("id")
        .eq("room_number", changes.roomNumber!)
        .single();

      if (roomErr || !roomRow) {
        const msg = roomErr?.message ?? "not found";
        console.error("[updateBooking] Step 2 — SELECT rooms FAILED:", msg);
        throw new Error(`[updateBooking] Room ${changes.roomNumber} not found: ${msg}`);
      }

      resolvedRoomId = roomRow.id;
      console.log("[updateBooking] Step 2 — new room UUID:", resolvedRoomId);
    }

    const targetRoomId = resolvedRoomId ?? current.room_id;   // new room or same room
    const ciISO = changes.checkInISO  ?? current.check_in_date;
    const coISO = changes.checkOutISO ?? current.check_out_date;

    console.log(
      `[updateBooking] Step 2 — overlap check: room_id ${targetRoomId}` +
      ` | ${ciISO} → ${coISO} (excluding ${bookingRef})`
    );

    const { data: conflicts, error: conflictErr } = await supabase
      .from("booking_rooms")
      .select("check_in_date, check_out_date, status, bookings!booking_id(booking_ref)")
      .eq("room_id", targetRoomId)
      .in("status", ["confirmed", "checked_in"])
      .lt("check_in_date", coISO)
      .gt("check_out_date", ciISO)
      .neq("booking_id", current.id);    // ← exclude current booking by UUID

    if (conflictErr) {
      // Proceeding on overlap query failure risks a double-booking — throw instead.
      console.error("[updateBooking] Step 2 — overlap query FAILED:", conflictErr);
      throw new Error(
        "[updateBooking] Could not verify room availability — " + conflictErr.message
      );
    }

    if (conflicts && conflicts.length > 0) {
      const c = conflicts[0];
      const cBookings = c.bookings as Array<{ booking_ref: string }>;
      throw new Error(
        `Room is unavailable for ${ciISO} – ${coISO}. ` +
        `Booking ${cBookings[0]?.booking_ref ?? "unknown"} covers ${c.check_in_date} – ${c.check_out_date} (${c.status}).`
      );
    }

    console.log("[updateBooking] Step 2 — no conflicts found");
  }

  // ── Step 3 — Build bookings UPDATE payload ──────────────────────────────
  const bookingUpdate: Record<string, unknown> = {};
  if (resolvedRoomId             !== undefined) bookingUpdate.room_id                  = resolvedRoomId;
  if (changes.checkInISO         !== undefined) bookingUpdate.check_in_date            = changes.checkInISO;
  if (changes.checkOutISO        !== undefined) bookingUpdate.check_out_date           = changes.checkOutISO;
  // nights is GENERATED — never written (error 23508). DB recomputes from dates automatically.
  if (changes.totalAmount        !== undefined) bookingUpdate.total_amount             = changes.totalAmount;
  if (changes.fixedRate          !== undefined) bookingUpdate.fixed_rate               = changes.fixedRate;
  if (changes.bookingRate        !== undefined) bookingUpdate.booking_rate             = changes.bookingRate;
  if (changes.totalGuests        !== undefined) bookingUpdate.total_guests             = changes.totalGuests;
  if (changes.roomCategory       !== undefined)
    bookingUpdate.room_category_at_booking = changes.roomCategory.toLowerCase();

  // ── Step 4 — Manually sync payment_status when total_amount changes ──────
  // fn_sync_payment_status fires on paid_amount changes only (payments INSERT chain).
  // Changing total_amount directly does NOT re-trigger it — must derive manually.
  // derivePaymentStatus returns Title Case ("Unpaid"/"Partial"/"Paid") so .toLowerCase()
  // is needed to match the DB's lowercase payment_status enum.
  if (changes.totalAmount !== undefined) {
    const newPmtStatus = derivePaymentStatus(changes.totalAmount, current.paid_amount);
    bookingUpdate.payment_status = newPmtStatus.toLowerCase();
    console.log("[updateBooking] Step 4 — totalAmount changed →", changes.totalAmount,
      "| derived payment_status:", bookingUpdate.payment_status);
  }

  // ── Step 4.5 — Guard against phantom bookings ───────────────────────────
  // If the new total_amount would fall below the already-recorded paid_amount,
  // the booking would appear "Paid" but no additional payment was actually received
  // for the gap. The UI validates this first (validateEdit), but this is the
  // hard server-side guard.
  if (changes.totalAmount !== undefined && changes.totalAmount < current.paid_amount) {
    throw new Error(
      `PHANTOM BOOKING WARNING — booking ${bookingRef}: ` +
      `new totalAmount (${changes.totalAmount}) is less than paid_amount (${current.paid_amount}). ` +
      `Reduce the amount paid first via a payment adjustment, then lower the total.`
    );
  }

  // ── Step 5 — Execute bookings UPDATE ────────────────────────────────────
  if (Object.keys(bookingUpdate).length > 0) {
    console.log("[updateBooking] Step 5 — UPDATE bookings, payload:", bookingUpdate);

    const { error: updErr, status: updStatus, statusText: updST } = await supabase
      .from("bookings")
      .update(bookingUpdate)
      .eq("booking_ref", bookingRef);

    if (updErr) {
      console.error("──────────── [updateBooking] Step 5 — UPDATE bookings FAILED ────────────");
      console.error("  message    :", updErr.message);
      console.error("  details    :", updErr.details);
      console.error("  hint       :", updErr.hint);
      console.error("  code       :", updErr.code);
      console.error("  HTTP status:", updStatus, updST);
      console.error("  payload    :", bookingUpdate);
      console.error("────────────────────────────────────────────────────────────────────────");
      throw new Error(
        `[updateBooking] UPDATE bookings failed — ${updErr.message}` +
        (updErr.code    ? ` (code: ${updErr.code})`       : "") +
        (updErr.hint    ? ` | hint: ${updErr.hint}`        : "") +
        (updErr.details ? ` | details: ${updErr.details}`  : ""),
      );
    }
    console.log("[updateBooking] Step 5 — booking updated");
  } else {
    console.log("[updateBooking] Step 5 — no booking-level changes, skipping UPDATE");
  }

  // ── Step 5.5 — Mirror field changes to booking_rooms ──────────────────────
  // Phase 4.4: the bookings table is the legacy write path; booking_rooms is the
  // authoritative source that mapBooking() reads from (via the r0 shim). Any edit
  // that touches room, dates, rate, or category must also update the booking_rooms
  // row so the re-fetch in Step 8 returns the correct values.
  //
  // Current edit UI only supports single-room edits. We update ALL booking_rooms
  // rows for this booking (there is normally exactly one) because if the room, dates
  // or rate changed, they changed for the whole booking. When the multi-room add/remove
  // UI lands (Phase 5+), this block will be replaced with per-room RPC calls.
  const brRoomFields =
    resolvedRoomId             !== undefined ||
    changes.checkInISO         !== undefined ||
    changes.checkOutISO        !== undefined ||
    changes.bookingRate        !== undefined ||
    changes.roomCategory       !== undefined;

  if (brRoomFields) {
    const brPayload: Record<string, unknown> = {};
    if (resolvedRoomId       !== undefined) brPayload.room_id        = resolvedRoomId;
    if (changes.checkInISO   !== undefined) brPayload.check_in_date  = changes.checkInISO;
    if (changes.checkOutISO  !== undefined) brPayload.check_out_date = changes.checkOutISO;
    if (changes.bookingRate  !== undefined) brPayload.booking_rate   = changes.bookingRate;
    if (changes.roomCategory !== undefined)
      brPayload.room_category = changes.roomCategory.toLowerCase();

    // Derive the booking UUID (already in scope as current.id)
    console.log("[updateBooking] Step 5.5 — UPDATE booking_rooms, booking_id:", current.id, "| payload:", brPayload);

    const { error: brErr } = await supabase
      .from("booking_rooms")
      .update(brPayload)
      .eq("booking_id", current.id);

    if (brErr) {
      // Non-fatal: booking row is already updated; log loudly but don't abort.
      // The bookings table is source-of-truth for legacy columns; booking_rooms
      // will be corrected on next page load via mapBooking's fallback chain.
      console.error("[updateBooking] Step 5.5 — UPDATE booking_rooms FAILED:", brErr.message,
        "| booking_id:", current.id, "| payload:", brPayload);
    } else {
      console.log("[updateBooking] Step 5.5 — booking_rooms updated successfully");
    }
  } else {
    console.log("[updateBooking] Step 5.5 — no room-level changes, skipping booking_rooms UPDATE");
  }

  // TODO: Wrap booking UPDATE + room cascade in a Postgres transaction (RPC function)
  //       for true atomicity. For now we log loudly on partial failures.
  //
  // ── Step 6 — Room status cascade (only when room_id actually changed) ────
  // fn_sync_room_status fires on bookings.status changes ONLY — not room_id changes.
  // When a booking moves rooms we must manually fix both the old and new room rows.
  if (resolvedRoomId !== undefined && resolvedRoomId !== current.room_id) {
    // 6a — Old room: check if any other active booking still holds it
    const { data: otherRows, error: otherErr } = await supabase
      .from("bookings")
      .select("booking_ref")
      .eq("room_id", current.room_id)
      .in("status", ["confirmed", "checked_in"])
      .neq("booking_ref", bookingRef)
      .limit(1);

    if (otherErr) {
      console.error("[updateBooking] Step 6a — other-bookings check failed:", otherErr.message);
    }

    const oldRoomStatus = (otherRows && otherRows.length > 0) ? "reserved" : "available";
    console.log("[updateBooking] Step 6a — old room_id:", current.room_id, "→", oldRoomStatus);

    const { error: oldErr } = await supabase
      .from("rooms").update({ status: oldRoomStatus }).eq("id", current.room_id);
    if (oldErr) console.error("[updateBooking] Step 6a — UPDATE old room failed:", oldErr.message);

    // 6b — New room: derive status from booking's current status
    const bookingStatus = DB_TO_BOOKING_STATUS[current.status] ?? "Confirmed";
    const newRoomStatus = (bookingToRoomStatus(bookingStatus) ?? "Reserved").toLowerCase();
    console.log("[updateBooking] Step 6b — new room_id:", resolvedRoomId, "→", newRoomStatus);

    const { error: newErr } = await supabase
      .from("rooms").update({ status: newRoomStatus }).eq("id", resolvedRoomId);
    if (newErr) console.error("[updateBooking] Step 6b — UPDATE new room failed:", newErr.message);
  }

  // ── Step 7 — Update guest record ────────────────────────────────────────
  // Direct UPDATE by guestId — no find-or-create (that would create a duplicate profile).
  // Email: empty string in changes.email is treated as "leave unchanged" — placeholder
  // generation is a creation-time concern only, not applicable on edit.
  // 23505 on email (unique violation) → throw with user-readable message, not silent.
  const guestFieldsChanged =
    changes.guestName !== undefined ||
    changes.phone     !== undefined ||
    (changes.email !== undefined && changes.email.trim() !== "");

  if (guestFieldsChanged && currentGuestId) {
    const guestUpdate: Record<string, unknown> = {};
    if (changes.guestName !== undefined) guestUpdate.name  = changes.guestName.trim();
    if (changes.phone     !== undefined) guestUpdate.phone = changes.phone.trim();
    if (changes.email !== undefined && changes.email.trim() !== "") {
      guestUpdate.email = changes.email.trim();
    }

    console.log("[updateBooking] Step 7 — UPDATE guests, id:", currentGuestId, "| payload:", guestUpdate);

    const { error: gErr, status: gStatus, statusText: gST } = await supabase
      .from("guests")
      .update(guestUpdate)
      .eq("id", currentGuestId);

    if (gErr) {
      if (gErr.code === "23505") {
        // Email already belongs to another guest — surface a readable error to the UI
        console.error("[updateBooking] Step 7 — email collision:", changes.email);
        throw new Error(
          `The email "${changes.email}" is already registered to another guest. ` +
          `Use a different email or leave it blank.`,
        );
      }
      console.error("──────────── [updateBooking] Step 7 — UPDATE guests FAILED ────────────");
      console.error("  message    :", gErr.message);
      console.error("  details    :", gErr.details);
      console.error("  hint       :", gErr.hint);
      console.error("  code       :", gErr.code);
      console.error("  HTTP status:", gStatus, gST);
      console.error("  guestId    :", currentGuestId, "| payload:", guestUpdate);
      console.error("────────────────────────────────────────────────────────────────────────");
      throw new Error(
        `[updateBooking] Guest update failed — ${gErr.message}` +
        (gErr.code    ? ` (code: ${gErr.code})`       : "") +
        (gErr.hint    ? ` | hint: ${gErr.hint}`        : "") +
        (gErr.details ? ` | details: ${gErr.details}`  : ""),
      );
    }
    console.log("[updateBooking] Step 7 — guest updated:", currentGuestId);
  } else if (changes.guestName !== undefined || changes.phone !== undefined || changes.email !== undefined) {
    console.warn("[updateBooking] Step 7 — guest fields in changes but no currentGuestId; guest row NOT updated");
  }

  // ── Step 7.5 — Replace additional guests ────────────────────────────────
  // When additionalGuests is present in changes, DELETE all existing booking_guests
  // rows for this booking then re-INSERT the new list. Sort order is preserved by
  // the array index. An empty array means "remove all additional guests".
  if (changes.additionalGuests !== undefined) {
    console.log("[updateBooking] Step 7.5 — replacing booking_guests, count:", changes.additionalGuests.length);

    // 7.5a — Fetch booking UUID (needed for booking_guests FK)
    const { data: bRow, error: bRowErr } = await supabase
      .from("bookings")
      .select("id")
      .eq("booking_ref", bookingRef)
      .single();

    if (bRowErr || !bRow) {
      console.error("[updateBooking] Step 7.5 — could not fetch booking id:", bRowErr?.message);
      // Non-fatal: proceed without updating booking_guests
    } else {
      // 7.5b — DELETE existing rows
      const { error: delErr } = await supabase
        .from("booking_guests")
        .delete()
        .eq("booking_id", bRow.id);

      if (delErr) {
        console.error("[updateBooking] Step 7.5 — DELETE booking_guests failed:", delErr.message);
      } else if (changes.additionalGuests.length > 0) {
        // 7.5c — INSERT new rows
        const guestRows = changes.additionalGuests.map((g, i) => ({
          booking_id:  bRow.id,
          name:        g.name,
          nationality: g.nationality ?? null,
          sort_order:  i + 1,
        }));

        const { error: insErr } = await supabase
          .from("booking_guests")
          .insert(guestRows);

        if (insErr) {
          console.error("[updateBooking] Step 7.5 — INSERT booking_guests failed:", insErr.message);
        } else {
          console.log("[updateBooking] Step 7.5 — booking_guests replaced, rows:", guestRows.length);
        }
      } else {
        console.log("[updateBooking] Step 7.5 — no additional guests, booking_guests cleared");
      }
    }
  }

  // ── Step 8 — Re-fetch with all joins ────────────────────────────────────
  console.log("[updateBooking] Step 8 — re-fetching with joins, booking_ref:", bookingRef);

  const { data: full, error: reFetchErr } = await supabase
    .from("bookings")
    .select(BOOKING_SELECT)
    .eq("booking_ref", bookingRef)
    .single();

  if (reFetchErr || !full) {
    const msg = reFetchErr?.message ?? "row not found";
    console.error("[updateBooking] Step 8 — re-fetch FAILED:", msg);
    throw new Error(`[updateBooking] Re-fetch failed for ${bookingRef}: ${msg}`);
  }

  console.log("[updateBooking] Step 8 — complete:", (full as BookingRow).booking_ref);
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
  amount: number,
  method: PaymentMethod,
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
    .select("id, total_amount, paid_amount, extra_charge_amount, early_deduction_amount, additional_discount_amount")
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
  // Mirror calcTrueDue formula — caps at the TRUE outstanding balance,
  // including extra charges, early-checkout deductions, and additional
  // discounts. Previous naive formula (total − paid) silently dropped
  // payments when extra charges existed (e.g. checkout surcharge added
  // after all room-rate payments were collected), breaking financial
  // integrity: optimistic React state diverged from DB paid_amount.
  const trueDue =
    booking.total_amount
    + ((booking.extra_charge_amount         as number | null) ?? 0)
    - ((booking.early_deduction_amount      as number | null) ?? 0)
    - ((booking.additional_discount_amount  as number | null) ?? 0)
    - booking.paid_amount;

  const safeAmount = Math.min(amount, trueDue);

  if (safeAmount <= 0) {
    // Positive amount requested but nothing genuinely owed — throw so that
    // HotelContext's .catch() can roll back the optimistic amountPaid update.
    // This prevents React state from permanently diverging from DB paid_amount.
    if (amount > 0) {
      throw new Error(
        `[recordPayment] No outstanding balance for booking ${id}. ` +
        `True due: ৳${trueDue}, Already paid: ৳${booking.paid_amount}, Requested: ৳${amount}`
      );
    }
    // amount = 0 is a legitimate no-op (e.g. ৳0 advance at booking creation)
    console.log("[recordPayment] amount is 0 — nothing to insert, returning.");
    return;
  }

  const paymentPayload = { booking_id: booking.id, amount: safeAmount, method };
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
// UPDATE — NORMAL CHECKOUT  (no outstanding balance)
// ─────────────────────────────────────────────────────────────

/**
 * Check out a booking that has no outstanding balance.
 *
 * Step 1 — Calls `checkout_booking_room` RPC (atomic):
 *   • Sets booking_rooms.status → checked_out
 *   • Sets rooms.status         → cleaning
 *   • Records actual_checkout_date + early deduction on the booking_rooms row
 *   • Advances bookings.status  → checked_out (when this is the last active room)
 *
 * Step 2 — Updates bookings table for fields the RPC doesn't own:
 *   extra_charge_amount/reason and additional_discount_* columns.
 *   Skipped entirely when neither is present.
 *
 * @param id                       booking_ref ("BK-1041"), not the UUID
 * @param bookingRoomId            booking_rooms.id for the room being checked out (rooms[0] for single-room bookings)
 * @param extraChargeAmount        additional amount charged at checkout (0 = none)
 * @param extraChargeReason        human-readable reason, e.g. "Mini-bar - 3 soft drinks"
 * @param actualCheckoutDate       ISO date (YYYY-MM-DD) the guest actually left
 * @param earlyNightsDeducted      number of unused nights deducted (0 if on-time/late)
 * @param earlyDeductionAmount     BDT amount deducted for early checkout (0 if none)
 * @param additionalDiscountAmount ad-hoc discount applied at checkout (0 = none)
 * @param additionalDiscountReason optional plain-text reason for the discount
 * @param additionalDiscountBy     auth.users UUID of who applied the discount (null if none)
 */
export async function checkoutNormal(
  id: string,
  bookingRoomId: string,
  extraChargeAmount: number,
  extraChargeReason: string | null,
  actualCheckoutDate: string,
  earlyNightsDeducted: number,
  earlyDeductionAmount: number,
  additionalDiscountAmount: number,
  additionalDiscountReason: string | null,
  additionalDiscountBy: string | null,
): Promise<void> {
  // ── Step 1 — checkout_booking_room RPC ─────────────────────────────────────
  // Atomically sets booking_rooms.status, rooms.status = cleaning, stamps
  // actual_checkout_date + early deduction, and advances bookings.status when
  // this is the last active room on the booking.
  console.log(
    "[checkoutNormal] Step 1 — RPC checkout_booking_room" +
    ` | bookingRoomId: ${bookingRoomId}` +
    ` | actualCheckoutDate: ${actualCheckoutDate}` +
    ` | earlyNightsDeducted: ${earlyNightsDeducted}` +
    ` | earlyDeductionAmount: ${earlyDeductionAmount}`
  );

  const { error: rpcErr } = await supabase.rpc("checkout_booking_room", {
    p_booking_room_id:       bookingRoomId,
    p_actual_checkout_date:  actualCheckoutDate || null,
    p_early_nights_deducted: earlyNightsDeducted,
    p_deduction_amount:      earlyDeductionAmount,
  });

  if (rpcErr) {
    console.error("──────────── [checkoutNormal] Step 1 — RPC checkout_booking_room FAILED ────────────");
    console.error("  message       :", rpcErr.message);
    console.error("  details       :", rpcErr.details);
    console.error("  hint          :", rpcErr.hint);
    console.error("  code          :", rpcErr.code);
    console.error("  bookingRoomId :", bookingRoomId);
    console.error("  booking_ref   :", id);
    console.error("────────────────────────────────────────────────────────────────────────────────────");
    throw new Error(
      `[checkoutNormal] checkout_booking_room RPC failed — ${rpcErr.message}` +
      (rpcErr.code    ? ` (code: ${rpcErr.code})`       : "") +
      (rpcErr.hint    ? ` | hint: ${rpcErr.hint}`        : "") +
      (rpcErr.details ? ` | details: ${rpcErr.details}`  : "")
    );
  }

  console.log("[checkoutNormal] Step 1 — RPC succeeded for booking_ref:", id);

  // ── Step 2 — Update bookings for fields the RPC doesn't own ────────────────
  // extra_charge_* and additional_discount_* live only on the bookings table.
  // Skip the UPDATE entirely when neither is present.
  const bookingsPayload: Record<string, unknown> = {};

  if (extraChargeAmount > 0) {
    bookingsPayload.extra_charge_amount = extraChargeAmount;
    bookingsPayload.extra_charge_reason = extraChargeReason || null;
  }
  if (additionalDiscountAmount > 0) {
    bookingsPayload.additional_discount_amount = additionalDiscountAmount;
    bookingsPayload.additional_discount_at     = new Date().toISOString();
    if (additionalDiscountReason) bookingsPayload.additional_discount_reason = additionalDiscountReason;
    if (additionalDiscountBy)     bookingsPayload.additional_discount_by     = additionalDiscountBy;
  }

  if (Object.keys(bookingsPayload).length > 0) {
    console.log("[checkoutNormal] Step 2 — UPDATE bookings, booking_ref:", id, "| payload:", bookingsPayload);

    const { error, status, statusText } = await supabase
      .from("bookings")
      .update(bookingsPayload)
      .eq("booking_ref", id);

    if (error) {
      console.error("──────────── [checkoutNormal] Step 2 — UPDATE bookings FAILED ────────────");
      console.error("  message    :", error.message);
      console.error("  details    :", error.details);
      console.error("  hint       :", error.hint);
      console.error("  code       :", error.code);
      console.error("  HTTP status:", status, statusText);
      console.error("  booking_ref:", id);
      console.error("  payload    :", bookingsPayload);
      console.error("────────────────────────────────────────────────────────────────────");
      throw new Error(
        `[checkoutNormal] bookings update failed — ${error.message}` +
        (error.code    ? ` (code: ${error.code})`       : "") +
        (error.hint    ? ` | hint: ${error.hint}`        : "") +
        (error.details ? ` | details: ${error.details}`  : "")
      );
    }

    console.log("[checkoutNormal] Step 2 — extra charge / discount written for booking_ref:", id);
  } else {
    console.log("[checkoutNormal] Step 2 — no extra charges or discount, skipping bookings UPDATE");
  }

  console.log("[checkoutNormal] complete for booking_ref:", id);
}

// ─────────────────────────────────────────────────────────────
// UPDATE — ADMIN OVERRIDE CHECKOUT
// ─────────────────────────────────────────────────────────────

/**
 * Admin-only: check out a booking that has an outstanding balance.
 *
 * Step 1 — Calls `checkout_booking_room` RPC (atomic):
 *   • Sets booking_rooms.status → checked_out
 *   • Sets rooms.status         → cleaning
 *   • Records actual_checkout_date + early deduction on the booking_rooms row
 *   • Advances bookings.status  → checked_out (when this is the last active room)
 *
 * Step 2 — Updates bookings table for fields the RPC doesn't own:
 *   override audit fields (always written) + extra_charge_* + additional_discount_*.
 *
 * @param id                       booking_ref ("BK-1041"), not the UUID
 * @param bookingRoomId            booking_rooms.id for the room being checked out (rooms[0] for single-room bookings)
 * @param overrideReason           free-text reason entered by the admin
 * @param overrideBy               auth.users UUID of the admin performing the override
 * @param extraChargeAmount        additional amount charged at checkout (0 = none)
 * @param extraChargeReason        formatted reason string for the extra charge
 * @param actualCheckoutDate       ISO date (YYYY-MM-DD) the guest actually left
 * @param earlyNightsDeducted      number of unused nights deducted (0 if on-time/late)
 * @param earlyDeductionAmount     BDT amount deducted for early checkout (0 if none)
 * @param additionalDiscountAmount ad-hoc discount applied at checkout (0 = none)
 * @param additionalDiscountReason optional plain-text reason for the discount
 * @param additionalDiscountBy     auth.users UUID of who applied the discount (null if none)
 */
export async function checkoutWithOverride(
  id: string,
  bookingRoomId: string,
  overrideReason: string,
  overrideBy: string,
  extraChargeAmount?: number,
  extraChargeReason?: string | null,
  actualCheckoutDate?: string,
  earlyNightsDeducted?: number,
  earlyDeductionAmount?: number,
  additionalDiscountAmount?: number,
  additionalDiscountReason?: string | null,
  additionalDiscountBy?: string | null,
): Promise<void> {
  // ── Step 1 — checkout_booking_room RPC ─────────────────────────────────────
  // Atomically sets booking_rooms.status, rooms.status = cleaning, stamps
  // actual_checkout_date + early deduction, and advances bookings.status when
  // this is the last active room on the booking.
  console.log(
    "[checkoutWithOverride] Step 1 — RPC checkout_booking_room" +
    ` | bookingRoomId: ${bookingRoomId}` +
    ` | actualCheckoutDate: ${actualCheckoutDate ?? "none"}` +
    ` | earlyNightsDeducted: ${earlyNightsDeducted ?? 0}` +
    ` | earlyDeductionAmount: ${earlyDeductionAmount ?? 0}`
  );

  const { error: rpcErr } = await supabase.rpc("checkout_booking_room", {
    p_booking_room_id:       bookingRoomId,
    p_actual_checkout_date:  actualCheckoutDate  || null,
    p_early_nights_deducted: earlyNightsDeducted ?? 0,
    p_deduction_amount:      earlyDeductionAmount ?? 0,
  });

  if (rpcErr) {
    console.error("──────────── [checkoutWithOverride] Step 1 — RPC checkout_booking_room FAILED ────────────");
    console.error("  message       :", rpcErr.message);
    console.error("  details       :", rpcErr.details);
    console.error("  hint          :", rpcErr.hint);
    console.error("  code          :", rpcErr.code);
    console.error("  bookingRoomId :", bookingRoomId);
    console.error("  booking_ref   :", id);
    console.error("──────────────────────────────────────────────────────────────────────────────────────────");
    throw new Error(
      `[checkoutWithOverride] checkout_booking_room RPC failed — ${rpcErr.message}` +
      (rpcErr.code    ? ` (code: ${rpcErr.code})`       : "") +
      (rpcErr.hint    ? ` | hint: ${rpcErr.hint}`        : "") +
      (rpcErr.details ? ` | details: ${rpcErr.details}`  : "")
    );
  }

  console.log("[checkoutWithOverride] Step 1 — RPC succeeded for booking_ref:", id);

  // ── Step 2 — Update bookings for override audit + fields RPC doesn't own ───
  // Override audit fields are always written (override_checkout, override_reason,
  // override_by, override_at). Extra charges and additional discount are conditional.
  const updatePayload: Record<string, unknown> = {
    override_checkout: true,
    override_reason:   overrideReason.trim() || "No reason provided",
    override_by:       overrideBy,
    override_at:       new Date().toISOString(),
  };
  if (extraChargeAmount && extraChargeAmount > 0) {
    updatePayload.extra_charge_amount = extraChargeAmount;
    updatePayload.extra_charge_reason = extraChargeReason || null;
  }
  if (additionalDiscountAmount && additionalDiscountAmount > 0) {
    updatePayload.additional_discount_amount = additionalDiscountAmount;
    updatePayload.additional_discount_at     = new Date().toISOString();
    if (additionalDiscountReason) updatePayload.additional_discount_reason = additionalDiscountReason;
    if (additionalDiscountBy)     updatePayload.additional_discount_by     = additionalDiscountBy;
  }

  console.log("[checkoutWithOverride] Step 2 — UPDATE bookings, booking_ref:", id, "| payload:", updatePayload);

  const { error, status, statusText } = await supabase
    .from("bookings")
    .update(updatePayload)
    .eq("booking_ref", id);

  if (error) {
    console.error("──────────── [checkoutWithOverride] Step 2 — UPDATE bookings FAILED ────────────");
    console.error("  message    :", error.message);
    console.error("  details    :", error.details);
    console.error("  hint       :", error.hint);
    console.error("  code       :", error.code);
    console.error("  HTTP status:", status, statusText);
    console.error("  booking_ref:", id);
    console.error("  payload    :", updatePayload);
    console.error("─────────────────────────────────────────────────────────────────────────────────");
    // Common causes:
    //   42501 — RLS blocks UPDATE on bookings for this role
    //   42703 — column does not exist (check override_checkout / override_reason /
    //            override_at column names in Supabase Table Editor → bookings table)
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
      `[checkoutWithOverride] bookings update failed — ${error.message}` +
      (error.code    ? ` (code: ${error.code})`       : "") +
      (error.hint    ? ` | hint: ${error.hint}`        : "") +
      (error.details ? ` | details: ${error.details}`  : "")
    );
  }

  console.log("[checkoutWithOverride] complete for booking_ref:", id);
}

// ─────────────────────────────────────────────────────────────
// PAYMENTS FETCH
// ─────────────────────────────────────────────────────────────

/**
 * Fetches all payment rows for a booking, ordered oldest-first.
 * Returns an empty array if the booking has no payments yet.
 * Throws on DB error (caller should catch and show an error state).
 */
export async function getPaymentsByBookingRef(
  bookingRef: string,
): Promise<Payment[]> {
  // Step 1: resolve booking_ref → internal UUID
  const { data: bookingRow, error: bookingErr } = await supabase
    .from("bookings")
    .select("id")
    .eq("booking_ref", bookingRef)
    .single();

  if (bookingErr) {
    // PGRST116 = no row found (.single() on zero rows). A missing booking
    // just means no payments — the page's getBookingByRef call is the source
    // of truth for whether the booking exists and will trigger notFound().
    if (bookingErr.code === "PGRST116") {
      console.warn(
        `[getPaymentsByBookingRef] booking not found: ${bookingRef} — returning empty payments`,
      );
      return [];
    }
    // Any other error is a real failure (RLS block, network, schema mismatch) — log and throw
    console.error("[getPaymentsByBookingRef] booking lookup failed:");
    console.error("  bookingRef :", bookingRef);
    console.error("  message    :", bookingErr.message  ?? "(none)");
    console.error("  details    :", bookingErr.details  ?? "(none)");
    console.error("  hint       :", bookingErr.hint     ?? "(none)");
    console.error("  code       :", bookingErr.code     ?? "(none)");
    throw new Error(`[getPaymentsByBookingRef] ${bookingErr.message}`);
  }
  // Supabase .single() returned null data without an error — shouldn't happen,
  // but guard defensively to avoid downstream null-deref
  if (!bookingRow) {
    console.warn(
      `[getPaymentsByBookingRef] booking not found: ${bookingRef} — returning empty payments`,
    );
    return [];
  }

  // Step 2: fetch all payments for that booking UUID, oldest first
  const { data, error } = await supabase
    .from("payments")
    .select("id, amount, method, notes, created_at")
    .eq("booking_id", bookingRow.id)
    .order("created_at", { ascending: true });

  if (error) {
    console.error("[getPaymentsByBookingRef] payments fetch failed:");
    console.error("  bookingRef :", bookingRef);
    console.error("  booking_id :", bookingRow.id);
    console.error("  message    :", error.message  ?? "(none)");
    console.error("  details    :", error.details  ?? "(none)");
    console.error("  hint       :", error.hint     ?? "(none)");
    console.error("  code       :", error.code     ?? "(none)");
    throw new Error(
      `[getPaymentsByBookingRef] payments fetch failed — ${error.message}` +
      (error.code    ? ` (code: ${error.code})`       : "") +
      (error.hint    ? ` | hint: ${error.hint}`        : "") +
      (error.details ? ` | details: ${error.details}`  : ""),
    );
  }

  return (data ?? []).map(row => ({
    id:        row.id as string,
    amount:    Number(row.amount),
    method:    row.method as PaymentMethod,
    notes:     row.notes ?? null,
    createdAt: row.created_at as string,
  }));
}

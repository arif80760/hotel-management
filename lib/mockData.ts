// lib/mockData.ts
//
// ─── CENTRAL MOCK DATA ────────────────────────────────────────────────────────
//
// This is the SINGLE SOURCE OF TRUTH for all frontend data in the app.
// Every page and component imports its initial data from here.
//
// TODO (when backend is ready):
//   Replace `MOCK_ROOMS`    with a Supabase query → SELECT * FROM rooms
//   Replace `MOCK_BOOKINGS` with a Supabase query → SELECT * FROM bookings
//   Replace `ROOM_CATALOG`  with data derived from the rooms table
//   Remove this file once live data is wired in.
//
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// SHARED TYPES
// ─────────────────────────────────────────────────────────────

/** Possible occupancy states for a room. */
export type RoomStatus =
  | "Available"
  | "Occupied"
  | "Reserved"
  | "Cleaning"
  | "Maintenance";

/** Lifecycle states for a booking. */
export type BookingStatus =
  | "Confirmed"
  | "Checked In"
  | "Checked Out"
  | "Cancelled";

/**
 * Payment state for a booking.
 *   Unpaid    — no money collected yet
 *   Partial   — deposit taken, balance outstanding
 *   Paid      — fully settled
 *   Cancelled — booking is cancelled; payment state is not actionable
 */
export type PaymentStatus = "Paid" | "Partial" | "Unpaid" | "Cancelled";

/**
 * Payment method — mirrors the PostgreSQL payment_method enum.
 * Only the 5 user-selectable values are listed here.
 * Legacy DB values ("online", "other") are handled by formatPaymentMethod.
 */
export const PAYMENT_METHODS = [
  "cash", "card", "bkash", "nagad", "bank_transfer",
] as const;
export type PaymentMethod = typeof PAYMENT_METHODS[number];

/** Display labels for the 5 user-selectable payment methods. */
export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  cash:          "Cash",
  card:          "Card",
  bkash:         "Bkash",
  nagad:         "Nagad",
  bank_transfer: "Bank Transfer",
};

/**
 * Returns true if the email is null/undefined or is a system-generated
 * placeholder of the form "<digits>.noemail@hotel.local".
 */
export function isPlaceholderEmail(email: string | null | undefined): boolean {
  if (!email) return true;
  return email.endsWith(".noemail@hotel.local");
}

/**
 * Returns the email string for display — empty string if it is a placeholder.
 * Use this anywhere you want to show an email to the user but suppress noise.
 */
export function displayEmail(email: string | null | undefined): string {
  return isPlaceholderEmail(email) ? "" : (email ?? "");
}

/**
 * Format any DB payment_method value for display — including legacy
 * values ("online", "other") that are not user-selectable but may
 * exist on older rows.
 */
export function formatPaymentMethod(method: string | null | undefined): string {
  if (!method) return "—";
  const known = PAYMENT_METHOD_LABELS[method as PaymentMethod];
  if (known) return known;
  // Legacy / unknown value — capitalize each word, replace underscores
  return method.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * A secondary guest sharing the room.
 * The primary/responsible guest is stored directly on MockBooking.
 * Additional guests are listed here — name + nationality for hotel records.
 */
export type AdditionalGuest = {
  name:        string;
  nationality: string;
};

/**
 * Audit record stamped onto a booking when an admin overrides a blocked checkout.
 * Kept as a nested object so it's easy to query / index later in Supabase.
 * TODO: When auth is added, replace `by: string` with `by: UserId`.
 */
export type CheckoutOverride = {
  used:            true;     // always true when present — guards against partial writes
  reason:          string;   // admin's stated reason for bypassing the payment gate
  by:              string;   // simulated role — will be real user ID once auth exists
  overrideUsedAt?: string;   // ISO 8601 — when the override was performed
};

/**
 * Hotel-wide stay timing policy — single source of truth for all timing calculations.
 *   Standard check-in:  12:00 PM
 *   Standard checkout:  11:59 AM
 *   Grace period:       30 minutes after checkout time
 */
export const HOTEL_POLICY = {
  checkinHour:    12,   // 12:00 PM
  checkinMinute:  0,
  checkoutHour:   11,   // 11:59 AM
  checkoutMinute: 59,
  graceMinutes:   30,
} as const;

// ─────────────────────────────────────────────────────────────
// BOOKING ROOM — per-room stay record (booking_rooms junction)
// ─────────────────────────────────────────────────────────────

/**
 * Room-level lifecycle status.
 * Extends BookingStatus with 'Checked Out Early' — a room-level-only value
 * that occurs when a guest departs before the scheduled check_out_date.
 * booking.status (booking-level) never uses 'Checked Out Early'.
 */
export type BookingRoomStatus = BookingStatus | "Checked Out Early";

/**
 * One room's stay within a booking.
 * Corresponds to a single booking_rooms row, with room_number joined from rooms.
 *
 * For single-room bookings (booking.rooms.length === 1) all fields mirror
 * the backward-compat shims on MockBooking. For multi-room bookings,
 * read booking.rooms[i] directly for per-room detail.
 */
export interface BookingRoom {
  id:           string;   // booking_rooms.id UUID
  bookingId:    string;   // booking_rooms.booking_id UUID
  roomId:       string;   // booking_rooms.room_id UUID (internal — not shown in UI)
  roomNumber:   string;   // from rooms JOIN, e.g. "204"
  roomCategory: string;   // capitalised for UI, e.g. "Deluxe"
  checkIn:      string;   // display string: "Jul 10, 2026"
  checkOut:     string;   // display string: "Jul 13, 2026"
  checkInISO:   string;   // "2026-07-10"
  checkOutISO:  string;   // "2026-07-13"
  nights:       number;
  bookingRate:  number;   // negotiated rate per night for this room
  status:       BookingRoomStatus;
  // Early checkout (0 / undefined when on-time or late)
  actualCheckoutDate?:   string;   // ISO date — set only when checked out early or on early departure
  earlyNightsDeducted:   number;   // 0 for on-time or late checkout
  earlyDeductionAmount:  number;   // 0 for on-time or late checkout
  // Lifecycle timestamps (ISO 8601)
  confirmedAt?:  string;
  checkedInAt?:  string;
  checkedOutAt?: string;
  cancelledAt?:  string;
}

/**
 * An itemised extra charge applied to a booking, optionally attributed to a room.
 * Corresponds to a booking_extra_charges row.
 */
export interface BookingExtraCharge {
  id:             string;
  bookingId:      string;
  bookingRoomId?: string;   // undefined = booking-level charge; set = per-room charge
  roomNumber?:    string;   // denormalised for display — set when bookingRoomId is present
  amount:         number;   // always > 0
  reason:         string;
  chargeType?:    string;   // 'mini_bar' | 'laundry' | 'damage' | 'other'
  appliedAt:      string;   // ISO 8601 timestamp
}

// ─────────────────────────────────────────────────────────────
// REFUND
// ─────────────────────────────────────────────────────────────

/** Refund lifecycle status. */
export type RefundStatus = "pending" | "disbursed" | "denied";

/**
 * A refund record raised at booking cancellation or early checkout.
 * Two-step lifecycle: pending (created) → disbursed (money returned) or denied.
 *
 * bookings.paid_amount IS decremented on disbursement: disburse_refund inserts
 * a negative payment row, which fires trg_sync_paid_amount and decrements
 * paid_amount atomically (Phase 8.5, 2026-05-09-phase8.5-refund-disbursement.sql).
 */
export interface Refund {
  id:                  string;
  bookingId:           string;
  bookingRoomId:       string | null;   // null = whole-booking refund
  amount:              number;
  reason:              string | null;
  status:              RefundStatus;
  createdAt:           string;          // ISO 8601
  createdBy:           string | null;   // auth.users UUID
  disbursedAt:         string | null;
  disbursedBy:         string | null;   // auth.users UUID
  disbursementMethod:  PaymentMethod | null;
  notes:               string | null;
}

// ─────────────────────────────────────────────────────────────
// MOCK ROOM
// ─────────────────────────────────────────────────────────────

/**
 * Room record.
 * Field naming matches the future database schema so the swap is a
 * straight 1-to-1 replacement (mock array → Supabase rows).
 *
 * Fields marked "placeholder" are populated with demo values now but
 * will be managed via the admin UI / database later.
 */
export type MockRoom = {
  id:         string;       // e.g. "room-101"  →  future db primary key (uuid)
  roomNumber: string;       // display label, e.g. "101"
  floor:      string;       // "Floor 1" | "Floor 2" | "Floor 3" | "Floor 4"
  category:   string;       // "Single" | "Double" | "Deluxe" | "Suite" | "Family"
  status:     RoomStatus;   // live occupancy state
  price:      number;       // nightly rate in USD  [placeholder — editable later]
  capacity:   number;       // max guests           [placeholder — editable later]
  amenities:  string[];     // feature list for the Rooms page
};

/**
 * Audit record stamped onto a booking when an admin overrides a blocked checkout.
 * Kept as a nested object so it's easy to query / index later in Supabase.
 * TODO: When auth is added, replace `by: string` with `by: UserId`.
 */

/**
 * Booking record.
 * Core fields match the user's spec; extended fields (nights, payment,
 * amount) are kept for UI display until they can be computed server-side.
 */
export type MockBooking = {
  id:           string;          // e.g. "BK-1041"  →  future db primary key
  guestName:    string;          // full guest name
  phone:        string;          // contact number
  /**
   * UUID of the primary guest record in the `guests` table.
   * Populated from the JOIN in mapBooking(). Used during booking edit
   * to UPDATE the guest row directly (name/phone/email) without going
   * through findOrCreateGuest — which would create a new record instead
   * of modifying the existing one.
   */
  guestId?:      string;
  // ── Multi-room fields (Phase 3+) ─────────────────────────────────────
  // Authoritative per-room data. Always populated from booking_rooms via
  // mapBooking(). Single-room bookings have rooms.length === 1. For future
  // multi-room bookings, iterate booking.rooms[i] for per-room detail
  // instead of the backward-compat shim fields below.
  rooms:         BookingRoom[];
  extraCharges:  BookingExtraCharge[];
  // ── Backward-compat shims (populated from rooms[0] at mapBooking time) ─
  // All existing callsites continue to work unchanged for single-room
  // bookings (rooms.length === 1). For multi-room bookings prefer reading
  // booking.rooms[i] directly.
  /**
   * Backward-compat shim: returns rooms[0]'s value. For
   * multi-room bookings (rooms.length > 1), prefer reading
   * booking.rooms[i] directly. Will be removed in a future phase.
   */
  roomNumber:   string;          // which room, e.g. "204"
  /**
   * Backward-compat shim: returns rooms[0]'s value. For
   * multi-room bookings (rooms.length > 1), prefer reading
   * booking.rooms[i] directly. Will be removed in a future phase.
   */
  roomCategory: string;          // room type at time of booking
  /**
   * Backward-compat shim: returns rooms[0]'s value. For
   * multi-room bookings (rooms.length > 1), prefer reading
   * booking.rooms[i] directly. Will be removed in a future phase.
   */
  checkIn:      string;          // formatted, e.g. "Apr 21, 2025"
  /**
   * Backward-compat shim: returns rooms[0]'s value. For
   * multi-room bookings (rooms.length > 1), prefer reading
   * booking.rooms[i] directly. Will be removed in a future phase.
   */
  checkOut:     string;
  /**
   * Backward-compat shim: returns rooms[0]'s value. For
   * multi-room bookings (rooms.length > 1), prefer reading
   * booking.rooms[i] directly. Will be removed in a future phase.
   */
  nights:       number;
  status:       BookingStatus;
  payment:      PaymentStatus;   // auto-derived from totalAmount vs amountPaid
  totalAmount:  number;          // total charge for the stay (BDT)
  amountPaid:   number;          // running net: incremented on payment INSERT, decremented on negative payment INSERT (refund disbursement or cancel-with-disbursement)
  // dueAmount is derived at render via calcTrueDue() (not stored)
  totalGuests:       number;           // total number of guests in the room (including primary)
  additionalGuests:  AdditionalGuest[]; // named guests beyond the primary responsible guest
  isNew?:            boolean;           // UI flag — highlights rows added this session
  /**
   * Present only when an admin overrode the payment gate at checkout.
   * Absence means checkout was either normal or hasn't happened yet.
   * TODO: Store in a separate checkout_overrides table in Supabase.
   */
  checkoutOverride?: CheckoutOverride;
  // ── Room rate fields ─────────────────────────────────────
  // fixedRate   = published/standard nightly rate at time of booking
  // bookingRate = actual negotiated nightly rate (may be discounted)
  // When bookingRate < fixedRate → a discount was applied.
  // totalAmount is always computed from bookingRate × nights.
  fixedRate?:    number;   // standard published rate per night
  /**
   * Backward-compat shim: returns rooms[0]'s value. For
   * multi-room bookings (rooms.length > 1), prefer reading
   * booking.rooms[i] directly. Will be removed in a future phase.
   */
  bookingRate?:  number;   // actual rate charged per night (may differ)
  // ── Extra charges stamped at checkout ────────────────────
  // Legacy scalar columns on bookings table — kept during transition.
  // New charges are written to booking_extra_charges (see extraCharges field above).
  // finalPayable = (totalAmount + extraChargeAmount) - earlyDeductionAmount - additionalDiscountAmount - amountPaid
  extraChargeAmount?: number;   // total extra charge applied at checkout
  extraChargeReason?: string;   // e.g. "Mini-bar - 3 soft drinks"
  // ── Lifecycle timestamps (ISO 8601) ───────────────────────
  // Set once when the event occurs; never mutated afterwards.
  // TODO: Derive from a database trigger / server action when backend exists.
  createdAt?:    string;   // when the booking record was first created
  checkedInAt?:  string;   // when status transitioned to "Checked In"
  checkedOutAt?: string;   // when status transitioned to "Checked Out"
  // ── Checkout timing (Step 1 — display only) ──────────────────────────────
  actualChargedNights?: number;   // nights charged (same as planned for now)
  lateCheckoutMinutes?: number;   // minutes past scheduled checkout (negative = early)
  // ── Early checkout billing shims (populated from rooms[0]) ───────────────
  // For single-room bookings these match the booking_rooms row exactly.
  // For multi-room bookings, read booking.rooms[i].earlyDeductionAmount etc. directly.
  /**
   * Backward-compat shim: returns rooms[0]'s value. For
   * multi-room bookings (rooms.length > 1), prefer reading
   * booking.rooms[i] directly. Will be removed in a future phase.
   */
  actualCheckoutDate?:       string;   // ISO date (YYYY-MM-DD) guest actually vacated
  /**
   * Backward-compat shim: returns rooms[0]'s value. For
   * multi-room bookings (rooms.length > 1), prefer reading
   * booking.rooms[i] directly. Will be removed in a future phase.
   */
  earlyNightsDeducted?:      number;   // unused nights deducted from the bill
  /**
   * Backward-compat shim: returns rooms[0]'s value. For
   * multi-room bookings (rooms.length > 1), prefer reading
   * booking.rooms[i] directly. Will be removed in a future phase.
   */
  earlyDeductionAmount?:     number;   // total deduction in BDT (earlyNightsDeducted × bookingRate)
  // ── Additional discount at checkout (Step 2) ─────────────────────────────
  // Ad-hoc discount negotiated at checkout. No role restriction — staff or admin.
  // Cannot exceed remaining balance after early deduction.
  additionalDiscountAmount?: number;   // discount amount in BDT
  additionalDiscountReason?: string;   // optional plain-text reason, e.g. "Loyalty discount"
  additionalDiscountBy?:     string;   // auth.users UUID of who applied the discount
  additionalDiscountAt?:     string;   // ISO 8601 timestamp when discount was applied
  // ── Payment method (most recent payment) ─────────────────────────────────
  // Denormalized from the payments table via DB trigger fn_sync_last_payment_method.
  // Undefined when the booking has no payment rows yet.
  // Legacy DB values "online" and "other" are allowed so existing rows don't break types.
  lastPaymentMethod?: PaymentMethod | "online" | "other";
  // ── Guest contact ─────────────────────────────────────────────────────────
  email?:        string;   // real email if captured; absent / placeholder → hide in UI
  // ── ISO dates (backward-compat shims) ───────────────────────────────────
  /**
   * Backward-compat shim: returns rooms[0]'s value. For
   * multi-room bookings (rooms.length > 1), prefer reading
   * booking.rooms[i] directly. Will be removed in a future phase.
   */
  checkInISO?:   string;   // "YYYY-MM-DD" from DB check_in_date
  /**
   * Backward-compat shim: returns rooms[0]'s value. For
   * multi-room bookings (rooms.length > 1), prefer reading
   * booking.rooms[i] directly. Will be removed in a future phase.
   */
  checkOutISO?:  string;   // "YYYY-MM-DD" from DB check_out_date
};

// ─────────────────────────────────────────────────────────────
// BOOKING CREATION INPUT  (write-path types)
// ─────────────────────────────────────────────────────────────

/**
 * One room's input data for booking creation.
 *
 * All date fields use ISO format (YYYY-MM-DD) — the form hands these
 * directly from `<input type="date">` values so no display-format
 * parsing is needed in the service layer.
 */
export type RoomInput = {
  roomNumber:   string;   // e.g. "204" — used to look up room UUID in service Step 2
  roomCategory: string;   // e.g. "Deluxe" — resolved from rooms table; stored for audit
  fixedRate:    number;   // published nightly rate at time of booking
  bookingRate:  number;   // actual negotiated rate (≤ fixedRate for discounts)
  checkIn:      string;   // ISO date "YYYY-MM-DD" — shared across rooms in v1
  checkOut:     string;   // ISO date "YYYY-MM-DD"
  nights:       number;   // checkOut − checkIn in calendar days
};

/**
 * Write-path input for booking creation.
 *
 * Deliberately separate from MockBooking, which is the READ / DISPLAY shape
 * populated by mapBooking() from DB JOINs. MockBooking is the source of truth
 * for all display, filtering, and checkout logic. CreateBookingInput is
 * constructed only by the booking form and consumed only by:
 *   • bookingsService.createBooking()
 *   • HotelContext.createBooking() (which bridges from MockBooking in Phase 5.1,
 *     then accepts CreateBookingInput directly from Phase 5.2 onward)
 *
 * The rooms[] array maps directly to the p_rooms parameter of the
 * create_booking_with_rooms Supabase RPC.
 */
export type CreateBookingInput = {
  /** Client-generated optimistic booking ref, e.g. "BK-1042". */
  id:               string;
  primaryGuest: {
    name:   string;
    phone:  string;
    email?: string;
  };
  additionalGuests: AdditionalGuest[];
  totalGuests:      number;
  /** One or more rooms — minimum 1. Maps 1-to-1 to p_rooms[] in the RPC. */
  rooms:            RoomInput[];
  /** Sum of all rooms' (bookingRate × nights). Auto-computed by the form. */
  totalAmount:      number;
  amountPaid:       number;
  /** Payment method for the initial deposit (used when amountPaid > 0). */
  amountPaidMethod: PaymentMethod;
  status:           BookingStatus;
};

// ─────────────────────────────────────────────────────────────
// ROOM CATALOG
// A fast lookup: roomNumber → { category, price }.
// Used by the booking form for inline type hints and total estimates.
// TODO: Derive this from a live rooms query instead.
// ─────────────────────────────────────────────────────────────
// (Defined after MOCK_ROOMS so it can be derived from it.)

// ─────────────────────────────────────────────────────────────
// MOCK ROOMS  — 48 rooms across 4 floors
// Status counts: Occupied=31, Available=12, Cleaning=2,
//                Maintenance=1, Reserved=2  →  total=48
// ─────────────────────────────────────────────────────────────
export const MOCK_ROOMS: MockRoom[] = [

  // ── Floor 1  (14 rooms: 101–114) ──────────────────────────
  { id: "room-101", roomNumber: "101", floor: "Floor 1", category: "Single", status: "Occupied",    price: 89,  capacity: 1, amenities: ["WiFi", "TV"] },
  { id: "room-102", roomNumber: "102", floor: "Floor 1", category: "Single", status: "Available",   price: 89,  capacity: 1, amenities: ["WiFi", "TV"] },
  { id: "room-103", roomNumber: "103", floor: "Floor 1", category: "Double", status: "Occupied",    price: 129, capacity: 2, amenities: ["WiFi", "TV"] },
  { id: "room-104", roomNumber: "104", floor: "Floor 1", category: "Double", status: "Cleaning",    price: 129, capacity: 2, amenities: ["WiFi", "TV"] },
  { id: "room-105", roomNumber: "105", floor: "Floor 1", category: "Double", status: "Occupied",    price: 129, capacity: 2, amenities: ["WiFi", "TV", "Mini Bar"] },
  { id: "room-106", roomNumber: "106", floor: "Floor 1", category: "Double", status: "Available",   price: 129, capacity: 2, amenities: ["WiFi", "TV", "Mini Bar"] },
  { id: "room-107", roomNumber: "107", floor: "Floor 1", category: "Family", status: "Occupied",    price: 199, capacity: 4, amenities: ["WiFi", "TV", "Kitchenette"] },
  { id: "room-108", roomNumber: "108", floor: "Floor 1", category: "Family", status: "Occupied",    price: 199, capacity: 4, amenities: ["WiFi", "TV", "Kitchenette"] },
  { id: "room-109", roomNumber: "109", floor: "Floor 1", category: "Double", status: "Occupied",    price: 129, capacity: 2, amenities: ["WiFi", "TV"] },
  { id: "room-110", roomNumber: "110", floor: "Floor 1", category: "Double", status: "Maintenance", price: 129, capacity: 2, amenities: ["WiFi", "TV"] },
  { id: "room-111", roomNumber: "111", floor: "Floor 1", category: "Single", status: "Occupied",    price: 89,  capacity: 1, amenities: ["WiFi", "TV"] },
  { id: "room-112", roomNumber: "112", floor: "Floor 1", category: "Single", status: "Available",   price: 89,  capacity: 1, amenities: ["WiFi", "TV"] },
  { id: "room-113", roomNumber: "113", floor: "Floor 1", category: "Double", status: "Occupied",    price: 129, capacity: 2, amenities: ["WiFi", "TV", "Mini Bar"] },
  { id: "room-114", roomNumber: "114", floor: "Floor 1", category: "Double", status: "Occupied",    price: 129, capacity: 2, amenities: ["WiFi", "TV"] },

  // ── Floor 2  (12 rooms: 201–212) ──────────────────────────
  { id: "room-201", roomNumber: "201", floor: "Floor 2", category: "Deluxe", status: "Occupied",  price: 179, capacity: 2, amenities: ["WiFi", "TV", "Mini Bar", "City View"] },
  { id: "room-202", roomNumber: "202", floor: "Floor 2", category: "Deluxe", status: "Occupied",  price: 179, capacity: 2, amenities: ["WiFi", "TV", "Mini Bar", "City View"] },
  { id: "room-203", roomNumber: "203", floor: "Floor 2", category: "Suite",  status: "Available", price: 299, capacity: 3, amenities: ["WiFi", "TV", "Jacuzzi", "Ocean View"] },
  { id: "room-204", roomNumber: "204", floor: "Floor 2", category: "Deluxe", status: "Occupied",  price: 179, capacity: 2, amenities: ["WiFi", "TV", "Mini Bar"] },
  { id: "room-205", roomNumber: "205", floor: "Floor 2", category: "Deluxe", status: "Occupied",  price: 179, capacity: 2, amenities: ["WiFi", "TV", "Mini Bar", "City View"] },
  { id: "room-206", roomNumber: "206", floor: "Floor 2", category: "Suite",  status: "Reserved",  price: 299, capacity: 3, amenities: ["WiFi", "TV", "Jacuzzi", "Ocean View"] },
  { id: "room-207", roomNumber: "207", floor: "Floor 2", category: "Double", status: "Occupied",  price: 129, capacity: 2, amenities: ["WiFi", "TV"] },
  { id: "room-208", roomNumber: "208", floor: "Floor 2", category: "Double", status: "Cleaning",  price: 129, capacity: 2, amenities: ["WiFi", "TV"] },
  { id: "room-209", roomNumber: "209", floor: "Floor 2", category: "Deluxe", status: "Available", price: 179, capacity: 2, amenities: ["WiFi", "TV", "Mini Bar"] },
  { id: "room-210", roomNumber: "210", floor: "Floor 2", category: "Deluxe", status: "Occupied",  price: 179, capacity: 2, amenities: ["WiFi", "TV", "Mini Bar", "City View"] },
  { id: "room-211", roomNumber: "211", floor: "Floor 2", category: "Suite",  status: "Available", price: 299, capacity: 3, amenities: ["WiFi", "TV", "Jacuzzi", "Ocean View"] },
  { id: "room-212", roomNumber: "212", floor: "Floor 2", category: "Double", status: "Occupied",  price: 129, capacity: 2, amenities: ["WiFi", "TV"] },

  // ── Floor 3  (12 rooms: 301–312) ──────────────────────────
  { id: "room-301", roomNumber: "301", floor: "Floor 3", category: "Suite",  status: "Occupied",  price: 299, capacity: 3, amenities: ["WiFi", "TV", "Jacuzzi", "Ocean View"] },
  { id: "room-302", roomNumber: "302", floor: "Floor 3", category: "Double", status: "Occupied",  price: 129, capacity: 2, amenities: ["WiFi", "TV"] },
  { id: "room-303", roomNumber: "303", floor: "Floor 3", category: "Deluxe", status: "Available", price: 179, capacity: 2, amenities: ["WiFi", "TV", "Mini Bar", "City View"] },
  { id: "room-304", roomNumber: "304", floor: "Floor 3", category: "Deluxe", status: "Occupied",  price: 179, capacity: 2, amenities: ["WiFi", "TV", "Mini Bar", "City View"] },
  { id: "room-305", roomNumber: "305", floor: "Floor 3", category: "Deluxe", status: "Reserved",  price: 179, capacity: 2, amenities: ["WiFi", "TV", "Mini Bar"] },
  { id: "room-306", roomNumber: "306", floor: "Floor 3", category: "Suite",  status: "Occupied",  price: 299, capacity: 3, amenities: ["WiFi", "TV", "Jacuzzi", "Ocean View"] },
  { id: "room-307", roomNumber: "307", floor: "Floor 3", category: "Double", status: "Occupied",  price: 129, capacity: 2, amenities: ["WiFi", "TV"] },
  { id: "room-308", roomNumber: "308", floor: "Floor 3", category: "Double", status: "Available", price: 129, capacity: 2, amenities: ["WiFi", "TV", "Mini Bar"] },
  { id: "room-309", roomNumber: "309", floor: "Floor 3", category: "Deluxe", status: "Occupied",  price: 179, capacity: 2, amenities: ["WiFi", "TV", "Mini Bar", "City View"] },
  { id: "room-310", roomNumber: "310", floor: "Floor 3", category: "Double", status: "Occupied",  price: 129, capacity: 2, amenities: ["WiFi", "TV"] },
  { id: "room-311", roomNumber: "311", floor: "Floor 3", category: "Double", status: "Available", price: 129, capacity: 2, amenities: ["WiFi", "TV", "Mini Bar"] },
  { id: "room-312", roomNumber: "312", floor: "Floor 3", category: "Suite",  status: "Occupied",  price: 299, capacity: 3, amenities: ["WiFi", "TV", "Jacuzzi", "Ocean View"] },

  // ── Floor 4  (10 rooms: 401–410, all Premium Suites) ──────
  { id: "room-401", roomNumber: "401", floor: "Floor 4", category: "Suite", status: "Occupied",  price: 549, capacity: 4, amenities: ["WiFi", "TV", "Jacuzzi", "Ocean View", "Butler Service"] },
  { id: "room-402", roomNumber: "402", floor: "Floor 4", category: "Suite", status: "Occupied",  price: 549, capacity: 4, amenities: ["WiFi", "TV", "Jacuzzi", "Ocean View", "Butler Service"] },
  { id: "room-403", roomNumber: "403", floor: "Floor 4", category: "Suite", status: "Available", price: 549, capacity: 4, amenities: ["WiFi", "TV", "Jacuzzi", "Ocean View"] },
  { id: "room-404", roomNumber: "404", floor: "Floor 4", category: "Suite", status: "Occupied",  price: 549, capacity: 4, amenities: ["WiFi", "TV", "Jacuzzi", "Ocean View", "Butler Service"] },
  { id: "room-405", roomNumber: "405", floor: "Floor 4", category: "Suite", status: "Available", price: 549, capacity: 4, amenities: ["WiFi", "TV", "Jacuzzi", "Ocean View"] },
  { id: "room-406", roomNumber: "406", floor: "Floor 4", category: "Suite", status: "Occupied",  price: 549, capacity: 4, amenities: ["WiFi", "TV", "Jacuzzi", "Ocean View", "Butler Service"] },
  { id: "room-407", roomNumber: "407", floor: "Floor 4", category: "Suite", status: "Occupied",  price: 549, capacity: 4, amenities: ["WiFi", "TV", "Jacuzzi", "Ocean View"] },
  { id: "room-408", roomNumber: "408", floor: "Floor 4", category: "Suite", status: "Occupied",  price: 549, capacity: 4, amenities: ["WiFi", "TV", "Jacuzzi", "Ocean View", "Butler Service"] },
  { id: "room-409", roomNumber: "409", floor: "Floor 4", category: "Suite", status: "Occupied",  price: 549, capacity: 4, amenities: ["WiFi", "TV", "Jacuzzi", "Ocean View"] },
  { id: "room-410", roomNumber: "410", floor: "Floor 4", category: "Suite", status: "Available", price: 549, capacity: 4, amenities: ["WiFi", "TV", "Jacuzzi", "Ocean View"] },
];

// ─────────────────────────────────────────────────────────────
// ROOM CATALOG  (derived from MOCK_ROOMS — no duplication)
// Fast O(1) lookup: roomNumber → { category, price }
// TODO: When Supabase is connected, replace with a server-side
//       function that queries the rooms table.
// ─────────────────────────────────────────────────────────────
export const ROOM_CATALOG: Record<string, { category: string; price: number; capacity: number }> =
  Object.fromEntries(
    MOCK_ROOMS.map(r => [r.roomNumber, { category: r.category, price: r.price, capacity: r.capacity }])
  );

// ─────────────────────────────────────────────────────────────
// MOCK GUESTS  — 8 demo guest profiles
// TODO: Replace with Supabase query → SELECT * FROM guests
// ─────────────────────────────────────────────────────────────

/**
 * Guest profile record.
 * Field naming matches the future database schema for easy migration.
 */
export type MockGuest = {
  id:          string;   // e.g. "G-001"  →  future db primary key (uuid)
  name:        string;   // full name
  email:       string;
  phone:       string;
  nationality: string;
  notes:       string;   // freeform staff notes  [placeholder — editable later]
  vip:         boolean;  // VIP flag               [placeholder — editable later]
};

/**
 * A guest identity/travel document uploaded for a booking.
 * Stored in Supabase Storage (bucket: guest-documents) + booking_documents table.
 */
export type BookingDocument = {
  id:           string;   // uuid
  bookingRef:   string;   // matches MockBooking.id, e.g. "BK-1041"
  documentType: string;   // "Passport" | "National ID Card" | etc.
  fileUrl:      string;   // public URL from Supabase Storage
  storagePath:  string;   // storage object key — used for deletion
  fileName:     string;   // original file name from the browser
  fileType:     string;   // MIME type, e.g. "image/jpeg" or "application/pdf"
  note?:        string;   // optional staff note
  uploadedBy?:  string;   // uuid of the user who uploaded
  createdAt:    string;   // ISO 8601
};

export const MOCK_GUESTS: MockGuest[] = [
  { id: "G-001", name: "James Whitfield", email: "j.whitfield@email.com",  phone: "+1 617 555 0101",   nationality: "American",     notes: "Prefers high-floor rooms. Regular guest.",       vip: true  },
  { id: "G-002", name: "Priya Nair",      email: "priya.nair@email.com",   phone: "+91 98 5550 102",   nationality: "Indian",       notes: "",                                               vip: false },
  { id: "G-003", name: "Carlos Mendez",   email: "c.mendez@email.com",     phone: "+52 55 5550 103",   nationality: "Mexican",      notes: "Shellfish allergy — alert kitchen.",             vip: false },
  { id: "G-004", name: "Sophie Laurent",  email: "s.laurent@email.com",    phone: "+33 6 5550 0104",   nationality: "French",       notes: "Requests extra pillows and hypoallergenic linen.", vip: true },
  { id: "G-005", name: "Robert Kim",      email: "r.kim@email.com",        phone: "+82 10 5550 105",   nationality: "South Korean", notes: "",                                               vip: false },
  { id: "G-006", name: "Amina Hassan",    email: "a.hassan@email.com",     phone: "+971 50 555 0106",  nationality: "Emirati",      notes: "VIP lounge access required. Corporate account.", vip: true  },
  { id: "G-007", name: "David Okoye",     email: "d.okoye@email.com",      phone: "+234 80 5550 107",  nationality: "Nigerian",     notes: "",                                               vip: false },
  { id: "G-008", name: "Yuki Tanaka",     email: "y.tanaka@email.com",     phone: "+81 90 5550 108",   nationality: "Japanese",     notes: "Long-stay guest. Special rate agreement on file.", vip: true },
];

// ─────────────────────────────────────────────────────────────
// MOCK BOOKINGS  — 8 demo reservations
// TODO: Replace with a Supabase query → SELECT * FROM bookings
//       ORDER BY created_at DESC
// ─────────────────────────────────────────────────────────────
export const MOCK_BOOKINGS: MockBooking[] = [
  {
    // Arriving TODAY (Apr 22, 2026) — no deposit taken
    id: "BK-1041", guestName: "James Whitfield", phone: "+1 617 555 0101",
    roomNumber: "204", roomCategory: "Deluxe",
    checkIn: "Apr 22, 2026", checkOut: "Apr 25, 2026", nights: 3,
    status: "Confirmed", payment: "Unpaid", totalAmount: 537, amountPaid: 0,
    totalGuests: 1, additionalGuests: [],
    rooms: [], extraCharges: [],
    createdAt: "2026-04-18T10:30:00.000Z",
  },
  {
    // Arriving TODAY (Apr 22, 2026) — fully paid upfront, suite for two
    id: "BK-1040", guestName: "Priya Nair", phone: "+91 98 5550 102",
    roomNumber: "312", roomCategory: "Suite",
    checkIn: "Apr 22, 2026", checkOut: "Apr 27, 2026", nights: 5,
    status: "Confirmed", payment: "Paid", totalAmount: 1495, amountPaid: 1495,
    totalGuests: 2,
    additionalGuests: [
      { name: "Arjun Nair", nationality: "Indian" },
    ],
    rooms: [], extraCharges: [],
    createdAt: "2026-04-15T14:20:00.000Z",
  },
  {
    // In-house + departing TODAY (Apr 22, 2026) — 50% deposit, balance due
    id: "BK-1039", guestName: "Carlos Mendez", phone: "+52 55 5550 103",
    roomNumber: "115", roomCategory: "Double",
    checkIn: "Apr 20, 2026", checkOut: "Apr 22, 2026", nights: 2,
    status: "Checked In", payment: "Partial", totalAmount: 258, amountPaid: 129,
    totalGuests: 1, additionalGuests: [],
    rooms: [], extraCharges: [],
    createdAt: "2026-04-17T09:00:00.000Z",
    checkedInAt: "2026-04-20T14:30:00.000Z",
  },
  {
    // In-house — fully paid, family of four, mid-stay
    id: "BK-1038", guestName: "Sophie Laurent", phone: "+33 6 5550 0104",
    roomNumber: "408", roomCategory: "Suite",
    checkIn: "Apr 20, 2026", checkOut: "Apr 27, 2026", nights: 7,
    status: "Checked In", payment: "Paid", totalAmount: 3843, amountPaid: 3843,
    totalGuests: 4,
    additionalGuests: [
      { name: "Marc Laurent",   nationality: "French"  },
      { name: "Elise Laurent",  nationality: "French"  },
      { name: "Lucas Laurent",  nationality: "French"  },
    ],
    rooms: [], extraCharges: [],
    createdAt: "2026-04-10T11:15:00.000Z",
    checkedInAt: "2026-04-20T15:45:00.000Z",
  },
  {
    // Checked out — fully settled
    id: "BK-1037", guestName: "Robert Kim", phone: "+82 10 5550 105",
    roomNumber: "101", roomCategory: "Single",
    checkIn: "Apr 19, 2026", checkOut: "Apr 21, 2026", nights: 2,
    status: "Checked Out", payment: "Paid", totalAmount: 178, amountPaid: 178,
    totalGuests: 1, additionalGuests: [],
    rooms: [], extraCharges: [],
    createdAt: "2026-04-16T08:00:00.000Z",
    checkedInAt: "2026-04-19T12:00:00.000Z",
    checkedOutAt: "2026-04-21T11:30:00.000Z",
  },
  {
    // Checked out — fully settled
    id: "BK-1036", guestName: "Amina Hassan", phone: "+971 50 555 0106",
    roomNumber: "230", roomCategory: "Double",
    checkIn: "Apr 17, 2026", checkOut: "Apr 21, 2026", nights: 4,
    status: "Checked Out", payment: "Paid", totalAmount: 516, amountPaid: 516,
    totalGuests: 1, additionalGuests: [],
    rooms: [], extraCharges: [],
    createdAt: "2026-04-10T16:30:00.000Z",
    checkedInAt: "2026-04-17T13:00:00.000Z",
    checkedOutAt: "2026-04-21T10:15:00.000Z",
  },
  {
    // Arriving TODAY (Apr 22, 2026) — Confirmed, no payment yet
    id: "BK-1035", guestName: "David Okoye", phone: "+234 80 5550 107",
    roomNumber: "305", roomCategory: "Deluxe",
    checkIn: "Apr 22, 2026", checkOut: "Apr 25, 2026", nights: 3,
    status: "Confirmed", payment: "Unpaid", totalAmount: 537, amountPaid: 0,
    totalGuests: 1, additionalGuests: [],
    rooms: [], extraCharges: [],
    createdAt: "2026-04-20T07:45:00.000Z",
  },
  {
    // Cancelled — full refund scenario (paid = total, both shown for records)
    id: "BK-1034", guestName: "Yuki Tanaka", phone: "+81 90 5550 108",
    roomNumber: "412", roomCategory: "Suite",
    checkIn: "Apr 15, 2026", checkOut: "Apr 20, 2026", nights: 5,
    status: "Cancelled", payment: "Paid", totalAmount: 2745, amountPaid: 2745,
    totalGuests: 1, additionalGuests: [],
    rooms: [], extraCharges: [],
    createdAt: "2026-04-05T19:00:00.000Z",
  },
];

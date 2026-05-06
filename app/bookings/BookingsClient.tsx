"use client";

// app/bookings/BookingsClient.tsx
//
// Booking management with multi-guest support.
// Each booking has ONE primary/responsible guest plus an optional
// list of additional guests (name + nationality).
//
// Guest rules:
//   • Primary guest → stored as guestName / phone on the booking
//   • Total Guests  → totalGuests count on the booking
//   • Additional    → additionalGuests[] — one entry per extra named guest
//
// Room status sync (via HotelContext):
//   Confirmed  → Reserved
//   Checked In → Occupied
//   Checked Out→ Cleaning
//   Cancelled  → Available

import { useState, useEffect, useMemo } from "react";
import Link from "next/link";
import { useHotel } from "@/contexts/HotelContext";
import { useAuth } from "@/contexts/AuthContext";
import {
  type BookingStatus,
  type PaymentStatus,
  type PaymentMethod,
  type MockBooking as Booking,
  type AdditionalGuest,
  type BookingDocument,
  HOTEL_POLICY,
  PAYMENT_METHODS,
  PAYMENT_METHOD_LABELS,
  formatPaymentMethod,
  displayEmail,
} from "@/lib/mockData";
import {
  DOCUMENT_TYPES,
  ALLOWED_EXTENSIONS_LABEL,
  ALLOWED_MIME_TYPES,
  getDocuments,
  uploadDocument,
  deleteDocument,
} from "@/services/documentsService";

// ─────────────────────────────────────────────────────────────
// LOCAL TYPES
// ─────────────────────────────────────────────────────────────

/** A document staged in the Create Booking form — held locally until the
 *  booking_ref is available (after createBooking resolves). */
type PendingDoc = {
  id:       string;   // temp UUID for React key / updates
  docType:  string;
  file:     File | null;
  note:     string;
};

type FormData = {
  guest:            string;
  phone:            string;
  email:            string;
  room:             string;
  checkIn:          string;
  checkOut:         string;
  status:           BookingStatus;
  totalGuests:      number;
  additionalGuests: AdditionalGuest[];
  // Rate fields — stored as strings for simple <input> bindings
  fixedRate:        string;   // published/standard room rate per night (auto-filled from room)
  bookingRate:      string;   // actual negotiated rate per night (editable for discounts)
  // Payment fields — stored as strings so <input> bindings are simple
  totalAmount:      string;   // total charge = bookingRate × nights (auto-computed, editable)
  amountPaid:       string;   // deposit/payment collected at booking time
};

/** Form state for the Edit Booking modal. All number inputs stored as strings. */
type EditFormData = {
  guestName:        string;
  phone:            string;
  email:            string;
  room:             string;
  checkIn:          string;   // YYYY-MM-DD
  checkOut:         string;   // YYYY-MM-DD
  totalGuests:      number;
  additionalGuests: AdditionalGuest[];
  fixedRate:        string;
  bookingRate:      string;
  totalAmount:      string;
  amountPaid:       string;   // display-only read-only context (not sent to service)
};

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────
function calcNights(checkIn: string, checkOut: string): number {
  if (!checkIn || !checkOut) return 0;
  return Math.max(0, Math.floor(
    (new Date(checkOut).getTime() - new Date(checkIn).getTime()) / 86_400_000
  ));
}

function formatDate(iso: string): string {
  if (!iso) return "";
  return new Date(iso + "T00:00:00").toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric",
  });
}

function initials(name: string): string {
  return name.trim().split(/\s+/).map(n => n[0]).join("").slice(0, 2).toUpperCase();
}

const AVATAR_COLORS = [
  "bg-violet-100 text-violet-700", "bg-blue-100 text-blue-700",
  "bg-emerald-100 text-emerald-700", "bg-rose-100 text-rose-700",
  "bg-amber-100 text-amber-700", "bg-teal-100 text-teal-700",
  "bg-indigo-100 text-indigo-700", "bg-pink-100 text-pink-700",
];
function avatarColor(name: string): string {
  return AVATAR_COLORS[(name.charCodeAt(0) || 0) % AVATAR_COLORS.length];
}

function statusBadge(s: BookingStatus): string {
  const m: Record<BookingStatus, string> = {
    "Confirmed":   "bg-blue-50 text-blue-700 ring-1 ring-blue-200",
    "Checked In":  "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200",
    "Checked Out": "bg-slate-100 text-slate-500 ring-1 ring-slate-200",
    "Cancelled":   "bg-red-50 text-red-600 ring-1 ring-red-200",
  };
  return m[s];
}

function paymentBadge(p: PaymentStatus): string {
  const m: Record<PaymentStatus, string> = {
    Paid:    "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200",
    Partial: "bg-blue-50    text-blue-700    ring-1 ring-blue-200",
    Unpaid:  "bg-red-50     text-red-600     ring-1 ring-red-200",
  };
  return m[p];
}
function paymentDot(p: PaymentStatus): string {
  const m: Record<PaymentStatus, string> = {
    Paid: "bg-emerald-500", Partial: "bg-blue-500", Unpaid: "bg-red-400",
  };
  return m[p];
}
function paymentText(p: PaymentStatus): string {
  const m: Record<PaymentStatus, string> = {
    Paid: "text-emerald-600", Partial: "text-blue-600", Unpaid: "text-red-500",
  };
  return m[p];
}

/** Derives PaymentStatus purely from two numbers — single source of truth. */
function derivePaymentStatus(totalAmount: number, amountPaid: number): PaymentStatus {
  if (amountPaid <= 0)               return "Unpaid";
  if (amountPaid >= totalAmount)     return "Paid";
  return "Partial";
}

/**
 * Formats an ISO 8601 timestamp for human display.
 * e.g. "2026-04-22T14:30:00.000Z" → "Apr 22, 2026, 2:30 PM"
 */
function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true,
  });
}

const TODAY = new Date().toISOString().split("T")[0];

/** Extra charge type options shown in the checkout confirmation modal. */
const CHARGE_TYPES = [
  "Room damage", "Mini-bar", "Laundry", "Extra bed",
  "Late checkout", "Missing item", "Restaurant/Food", "Transport", "Other",
] as const;

/** Formats an extra charge type + note into a storable string. */
function formatChargeReason(type: string, note: string): string | null {
  if (!type) return null;
  return note.trim() ? `${type} - ${note.trim()}` : type;
}

/** Short date: "2026-04-22" → "Apr 22" */
function formatDateShort(iso: string): string {
  if (!iso) return "";
  return new Date(`${iso}T12:00:00`).toLocaleDateString("en-US", {
    month: "short", day: "numeric",
  });
}

/** Abbreviated day name: "2026-04-22" → "Wed" */
function dayName(iso: string): string {
  if (!iso) return "";
  return new Date(`${iso}T12:00:00`).toLocaleDateString("en-US", { weekday: "short" });
}

// ─────────────────────────────────────────────────────────────
// CHECKOUT TIMING HELPERS
// ─────────────────────────────────────────────────────────────

type CheckoutTiming = {
  scheduledAt:      Date;    // checkout date at 11:59 AM
  graceDeadlineAt:  Date;    // scheduledAt + 30 min (12:29 PM)
  actualAt:         Date;    // when modal was opened
  minutesDiff:      number;  // actual − scheduled (positive = late, negative = early)
  minutesPastGrace: number;  // actual − grace deadline (positive = truly late past grace)
  status:           "early" | "on_time" | "late";
};

/**
 * Calculates checkout timing status given the booking's checkout display date
 * ("Apr 25, 2026") and the actual checkout moment (when modal was opened).
 *
 *   Before 11:59 AM              → "early"
 *   11:59 AM – 12:29 PM (grace)  → "on_time"
 *   After 12:29 PM               → "late"
 */
function calcCheckoutTiming(checkOutDisplay: string, actualAt: Date): CheckoutTiming {
  const base = new Date(`${checkOutDisplay} 12:00:00`);   // parse local date
  const scheduledAt = new Date(base);
  scheduledAt.setHours(HOTEL_POLICY.checkoutHour, HOTEL_POLICY.checkoutMinute, 0, 0);
  const graceDeadlineAt = new Date(scheduledAt.getTime() + HOTEL_POLICY.graceMinutes * 60_000);
  const minutesDiff      = Math.round((actualAt.getTime() - scheduledAt.getTime())    / 60_000);
  const minutesPastGrace = Math.round((actualAt.getTime() - graceDeadlineAt.getTime()) / 60_000);
  let status: CheckoutTiming["status"];
  if      (minutesDiff <= 0)        status = "early";
  else if (minutesPastGrace <= 0)   status = "on_time";
  else                              status = "late";
  return { scheduledAt, graceDeadlineAt, actualAt, minutesDiff, minutesPastGrace, status };
}

/** Format a Date to "2:30 PM" */
function fmtTime(d: Date): string {
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
}

/** Format a Date to "Apr 22, 2026" */
function fmtShortDate(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/**
 * Canonical outstanding-balance formula.
 * Always use this instead of the naive (totalAmount − amountPaid).
 * Early deduction and additional discount are 0 for bookings not yet checked out,
 * so the formula naturally reduces to the original for in-progress stays.
 */
function calcTrueDue(b: {
  totalAmount:             number;
  amountPaid:              number;
  extraChargeAmount?:      number;
  earlyDeductionAmount?:   number;
  additionalDiscountAmount?: number;
}): number {
  return b.totalAmount
    + (b.extraChargeAmount          ?? 0)
    - (b.earlyDeductionAmount       ?? 0)
    - (b.additionalDiscountAmount   ?? 0)
    - b.amountPaid;
}

/**
 * Computes early-checkout billing deduction.
 * Calendar-date comparison only — wall-clock time is irrelevant.
 *
 *   earlyDays     = max(0, plannedCheckoutDate − actualCheckoutDate)  whole days
 *   earlyAmt      = earlyDays × bookingRate  (falls back to totalAmount / nights)
 *   actualDateISO = YYYY-MM-DD string for DB persistence
 */
function calcEarlyDeduction(
  checkOut:    string,              // display format "Apr 29, 2026"
  bookingRate: number | undefined,
  totalAmount: number,
  nights:      number,
  actualAt:    Date,
): { earlyDays: number; earlyAmt: number; actualDateISO: string } {
  const actualMidnight = new Date(actualAt);
  actualMidnight.setHours(0, 0, 0, 0);

  const plannedMidnight = new Date(`${checkOut} 00:00:00`);
  plannedMidnight.setHours(0, 0, 0, 0);

  const earlyDays = Math.max(0, Math.round(
    (plannedMidnight.getTime() - actualMidnight.getTime()) / 86_400_000
  ));

  const rate = (bookingRate && bookingRate > 0)
    ? bookingRate
    : nights > 0 ? totalAmount / nights : 0;

  const earlyAmt = earlyDays * rate;

  const y = actualAt.getFullYear();
  const m = String(actualAt.getMonth() + 1).padStart(2, "0");
  const d = String(actualAt.getDate()).padStart(2, "0");
  const actualDateISO = `${y}-${m}-${d}`;

  return { earlyDays, earlyAmt, actualDateISO };
}

const PAGE_SIZE = 20;

/** Returns an ISO date string (YYYY-MM-DD) offset by `days` from today. */
function dateOffsetISO(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

const EMPTY_FORM: FormData = {
  guest: "", phone: "", email: "", room: "", checkIn: "", checkOut: "",
  status: "Confirmed", totalGuests: 1, additionalGuests: [],
  fixedRate: "", bookingRate: "",
  totalAmount: "", amountPaid: "0",
};

const EMPTY_EDIT_FORM: EditFormData = {
  guestName: "", phone: "", email: "", room: "", checkIn: "", checkOut: "",
  totalGuests: 1, additionalGuests: [],
  fixedRate: "", bookingRate: "", totalAmount: "", amountPaid: "0",
};

// ─────────────────────────────────────────────────────────────
// DOUBLE-BOOKING HELPERS
// ─────────────────────────────────────────────────────────────

/**
 * Statuses that hold a room and must block new bookings for overlapping dates.
 * "Checked Out" and "Cancelled" release the room — they don't block.
 */
const BLOCKING_STATUSES = new Set<BookingStatus>(["Confirmed", "Checked In"]);

/**
 * Normalise any date string to "YYYY-MM-DD" for safe lexicographic comparison.
 * Accepts ISO dates ("2026-04-22") and display dates ("Apr 22, 2026").
 * Returns "" on parse failure so callers can skip the overlap test safely.
 */
function toISODate(s: string): string {
  if (!s) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;         // already ISO
  // Display-format string — append time so the Date constructor uses local
  // interpretation and getFullYear/Month/Date stay on the right calendar day.
  const d = new Date(`${s} 12:00:00`);
  if (isNaN(d.getTime())) return "";
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
  ].join("-");
}

/**
 * True when two date ranges for the SAME room overlap.
 * Uses the half-open [checkIn, checkOut) convention so that a checkout on
 * the same day as a new check-in is explicitly ALLOWED:
 *
 *   existingCheckIn  < newCheckOut
 *   existingCheckOut > newCheckIn
 *
 * Accepts any mix of ISO or display-format date strings.
 */
function bookingDatesOverlap(
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
 * @param excludeId  Optional booking_ref to skip (used when editing a booking).
 */
function findRoomConflict(
  bookings:   Booking[],
  roomNumber: string,
  checkIn:    string,   // ISO "YYYY-MM-DD"
  checkOut:   string,   // ISO "YYYY-MM-DD"
  excludeId?: string,
): Booking | undefined {
  if (!roomNumber || !checkIn || !checkOut) return undefined;
  return bookings.find(b => {
    if (excludeId && b.id === excludeId) return false;
    if (b.roomNumber.trim() !== roomNumber.trim()) return false;
    if (!BLOCKING_STATUSES.has(b.status)) return false;
    return bookingDatesOverlap(b.checkIn, b.checkOut, checkIn, checkOut);
  });
}

// Next workflow action per booking status
type ActionDef = { label: string; next: BookingStatus; style: string } | null;
function nextAction(status: BookingStatus): ActionDef {
  if (status === "Confirmed")  return { label: "Check In",  next: "Checked In",  style: "bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100" };
  if (status === "Checked In") return { label: "Check Out", next: "Checked Out", style: "bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100" };
  return null;
}

/** Returns true if the booking's check-in date is today or in the past. */
function canCheckInToday(checkInISO: string | undefined): boolean {
  if (!checkInISO) return true;   // no ISO date → don't block (safe fallback)
  const today = new Date().toISOString().slice(0, 10);
  return checkInISO <= today;
}

// ─────────────────────────────────────────────────────────────
// ROLE SIMULATION
// ─────────────────────────────────────────────────────────────
// COMPONENT
// ─────────────────────────────────────────────────────────────
interface Props {
  initialRoom: string | null;
}

export default function BookingsClient({ initialRoom }: Props) {
  // ── Shared context ─────────────────────────────────────────
  const {
    rooms, bookings, nextBookingId,
    createBooking, changeBookingStatus,
    checkoutNormal, checkoutWithOverride, recordPayment,
    updateBooking,
  } = useHotel();

  // Real role from authenticated session
  const { user, role } = useAuth();
  const isAdmin = role === "admin";

  // ── Local UI state ─────────────────────────────────────────
  const [formOpen,     setFormOpen]     = useState<boolean>(!!initialRoom);
  const [form,         setForm]         = useState<FormData>({ ...EMPTY_FORM, room: initialRoom ?? "" });
  const [errors,       setErrors]       = useState<Partial<Record<keyof FormData, string>>>({});
  const [successMsg,   setSuccessMsg]   = useState<string>("");
  const [activeFilter, setActiveFilter] = useState<string>("All");
  const [searchQuery,  setSearchQuery]  = useState<string>("");
  const [currentPage,  setCurrentPage]  = useState<number>(1);
  const [dateFrom,        setDateFrom]        = useState<string>(() => dateOffsetISO(-7));
  const [dateTo,          setDateTo]          = useState<string>(() => dateOffsetISO(30));
  const [dateFilterActive, setDateFilterActive] = useState<boolean>(true);

  // ── Payment modal state ─────────────────────────────────────
  // payModal holds the booking being paid against; null = modal closed.
  const [payModal,     setPayModal]     = useState<Booking | null>(null);
  const [payAmount,    setPayAmount]    = useState<string>("");
  const [payError,     setPayError]     = useState<string>("");

  // ── Checkout confirmation modal state ──────────────────────
  const [checkoutConfirm, setCheckoutConfirm] = useState<Booking | null>(null);
  // Extra charge fields
  const [chargeType,   setChargeType]   = useState<string>("");
  const [chargeAmount, setChargeAmount] = useState<string>("");
  const [chargeNote,   setChargeNote]   = useState<string>("");
  const [chargeError,  setChargeError]  = useState<string>("");
  // In-modal payment
  const [showModalPay,   setShowModalPay]   = useState<boolean>(false);
  const [modalPayAmt,    setModalPayAmt]    = useState<string>("");
  const [modalPayError,  setModalPayError]  = useState<string>("");
  // Override
  const [overrideReason, setOverrideReason] = useState<string>("");
  const [overrideError,  setOverrideError]  = useState<string>("");
  // More Discount (ad-hoc checkout discount)
  const [moreDiscountAmt,    setMoreDiscountAmt]    = useState<string>("");
  const [moreDiscountReason, setMoreDiscountReason] = useState<string>("");
  const [discountError,      setDiscountError]      = useState<string>("");

  const [bookingPayMethod,  setBookingPayMethod]  = useState<PaymentMethod>("cash");
  const [payMethod,         setPayMethod]         = useState<PaymentMethod>("cash");
  const [checkoutPayMethod, setCheckoutPayMethod] = useState<PaymentMethod>("cash");

  // ── Checkout timing — time captured when modal opens ────────
  // Used as the "actual checkout time" in the timing analysis panel.
  const [checkoutOpenedAt, setCheckoutOpenedAt] = useState<Date | null>(null);

  // ── Documents modal ─────────────────────────────────────────
  const [docsModal,      setDocsModal]      = useState<Booking | null>(null);
  const [docsList,       setDocsList]       = useState<BookingDocument[]>([]);
  const [docsLoading,    setDocsLoading]    = useState<boolean>(false);
  const [docsError,      setDocsError]      = useState<string>("");
  // Upload form inside the documents modal
  const [docType,        setDocType]        = useState<string>("");
  const [docFile,        setDocFile]        = useState<File | null>(null);
  const [docNote,        setDocNote]        = useState<string>("");
  const [docUploading,   setDocUploading]   = useState<boolean>(false);
  const [docUploadError, setDocUploadError] = useState<string>("");

  // ── Pending documents (Create Booking form) ─────────────────
  // Documents staged before the booking exists; uploaded after createBooking.
  const [pendingDocs,      setPendingDocs]      = useState<PendingDoc[]>([]);
  const [pendingDocError,  setPendingDocError]  = useState<string>("");

  // ── Timeline modal ───────────────────────────────────────────
  // null = closed; set to a booking to show that booking's full timeline.
  const [timelineModal, setTimelineModal] = useState<Booking | null>(null);

  // ── Page view ───────────────────────────────────────────────
  // "bookings" = full booking list (existing)
  // "dues"     = outstanding-dues monitor (new)
  const [pageView,  setPageView]  = useState<"bookings" | "dues">("bookings");
  const [dueFilter, setDueFilter] = useState<"all" | "inhouse" | "checkedout">("all");

  // ── Edit booking modal state ────────────────────────────────
  // editTarget: the booking currently being edited (null = modal closed)
  const [editTarget,  setEditTarget]  = useState<Booking | null>(null);
  const [editForm,    setEditForm]    = useState<EditFormData>({ ...EMPTY_EDIT_FORM });
  const [editErrors,  setEditErrors]  = useState<Partial<Record<keyof EditFormData, string>>>({});
  const [editSaving,  setEditSaving]  = useState<boolean>(false);

  // ── Edit confirmation modal state (risky-change review step) ─
  // confirmDiffs: row-by-row diff shown in the rose-tinted confirm modal.
  // pendingChanges: the payload staged for submit once the user confirms.
  type DiffRow = { field: string; from: string; to: string };
  const [confirmDiffs,   setConfirmDiffs]   = useState<DiffRow[] | null>(null);
  const [pendingChanges, setPendingChanges] = useState<import("@/services/bookingsService").UpdateBookingPayload | null>(null);

  // ── Derived ────────────────────────────────────────────────
  // Look up the room being entered in the live rooms list from context.
  // This means newly added rooms (from the Rooms page) are immediately
  // available for booking without a page reload.
  const roomInfo = useMemo(() => {
    const found = rooms.find(r => r.roomNumber === form.room.trim());
    return found
      ? { category: found.category, price: found.price, capacity: found.capacity }
      : null;
  }, [rooms, form.room]);

  const nights         = calcNights(form.checkIn, form.checkOut);
  const estimatedTotal = roomInfo && nights > 0 ? roomInfo.price * nights : null;

  // Rate derived values
  const fixedRateNum   = parseFloat(form.fixedRate)   || roomInfo?.price || 0;
  const bookingRateNum = parseFloat(form.bookingRate)  || fixedRateNum;
  const discountPerNight = fixedRateNum > 0 && bookingRateNum < fixedRateNum
    ? fixedRateNum - bookingRateNum : 0;
  const discountPct = fixedRateNum > 0 && discountPerNight > 0
    ? Math.round((discountPerNight / fixedRateNum) * 100) : 0;
  const totalSaving  = discountPerNight > 0 && nights > 0 ? discountPerNight * nights : 0;

  // ── Room availability (Layer A — real-time form feedback) ───
  // Scans the live bookings array whenever the room number or dates change.
  // Shows a warning banner BEFORE the user submits — no network call needed.
  const roomConflict = useMemo((): Booking | null => {
    const room = form.room.trim();
    if (!room || !form.checkIn || !form.checkOut) return null;
    if (calcNights(form.checkIn, form.checkOut) <= 0) return null;
    return findRoomConflict(bookings, room, form.checkIn, form.checkOut) ?? null;
  }, [bookings, form.room, form.checkIn, form.checkOut]); // eslint-disable-line react-hooks/exhaustive-deps

  // Live amountPaid for the booking in the checkout confirmation modal.
  // Updates in real-time when the staff records a payment inside the modal.
  const liveAmountPaid = useMemo(() => {
    if (!checkoutConfirm) return 0;
    return bookings.find(b => b.id === checkoutConfirm.id)?.amountPaid
      ?? checkoutConfirm.amountPaid;
  }, [bookings, checkoutConfirm?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Payment derived values (updated live as the user types)
  const totalAmountNum  = parseFloat(form.totalAmount) || 0;
  const amountPaidNum   = parseFloat(form.amountPaid)  || 0;
  const dueAmount       = Math.max(0, totalAmountNum - amountPaidNum);
  const formPayStatus   = derivePaymentStatus(totalAmountNum, amountPaidNum);

  const tabFilteredBookings =
    activeFilter === "All" ? bookings : bookings.filter(b => b.status === activeFilter);

  const filteredBookings = useMemo(() => {
    let result = tabFilteredBookings;

    // Date filter (check-in date range — uses ISO string for safe cross-browser comparison)
    if (dateFilterActive && (dateFrom || dateTo)) {
      result = result.filter(b => {
        if (!b.checkInISO) return true;   // no ISO date → don't exclude
        if (dateFrom && b.checkInISO < dateFrom) return false;
        if (dateTo   && b.checkInISO > dateTo)   return false;
        return true;
      });
    }

    // Search filter
    const q = searchQuery.trim().toLowerCase();
    if (q) {
      result = result.filter(b =>
        b.id.toLowerCase().includes(q) ||
        b.guestName.toLowerCase().includes(q) ||
        (b.phone ?? "").toLowerCase().includes(q)
      );
    }

    return result;
  }, [tabFilteredBookings, searchQuery, dateFilterActive, dateFrom, dateTo]);

  // Reset to page 1 whenever the filter set changes
  useEffect(() => {
    setCurrentPage(1);
  }, [activeFilter, searchQuery, dateFilterActive, dateFrom, dateTo]);

  const pagedBookings = filteredBookings.slice(
    (currentPage - 1) * PAGE_SIZE,
    currentPage * PAGE_SIZE,
  );
  const totalPages = Math.ceil(filteredBookings.length / PAGE_SIZE);

  const counts: Record<string, number> = {
    All:           bookings.length,
    Confirmed:     bookings.filter(b => b.status === "Confirmed").length,
    "Checked In":  bookings.filter(b => b.status === "Checked In").length,
    "Checked Out": bookings.filter(b => b.status === "Checked Out").length,
    Cancelled:     bookings.filter(b => b.status === "Cancelled").length,
  };

  // ── Dues view derived values ────────────────────────────────
  // All bookings with any outstanding balance, regardless of status.
  // Uses calcTrueDue() so early deductions and additional discounts are
  // accounted for — guests who left early and fully paid their reduced bill
  // will not appear here as having an outstanding balance.
  const dueBookings = useMemo(
    () => bookings.filter(b => calcTrueDue(b) > 0),
    [bookings]
  );

  const filteredDueBookings = useMemo(() => {
    if (dueFilter === "inhouse")    return dueBookings.filter(b => b.status === "Confirmed" || b.status === "Checked In");
    if (dueFilter === "checkedout") return dueBookings.filter(b => b.status === "Checked Out");
    return dueBookings;
  }, [dueBookings, dueFilter]);

  const totalOutstanding = useMemo(
    () => dueBookings.reduce((sum, b) => sum + calcTrueDue(b), 0),
    [dueBookings]
  );
  const dueInHouseCount     = dueBookings.filter(b => b.status === "Confirmed" || b.status === "Checked In").length;
  const dueCheckedOutCount  = dueBookings.filter(b => b.status === "Checked Out").length;
  const dueOverrideCount    = dueBookings.filter(b => b.checkoutOverride?.used).length;

  // Threshold above which a due amount is flagged as "high" with an extra icon
  const HIGH_DUE_THRESHOLD = 500;

  // ── Edit modal derived values ──────────────────────────────
  const editNights = calcNights(editForm.checkIn, editForm.checkOut);

  const editRoomConflict = useMemo((): Booking | null => {
    if (!editTarget) return null;
    const room = editForm.room.trim();
    if (!room || !editForm.checkIn || !editForm.checkOut) return null;
    if (editNights <= 0) return null;
    return findRoomConflict(bookings, room, editForm.checkIn, editForm.checkOut, editTarget.id) ?? null;
  }, [bookings, editForm.room, editForm.checkIn, editForm.checkOut, editTarget?.id, editNights]); // eslint-disable-line react-hooks/exhaustive-deps

  const editFixedRateNum     = parseFloat(editForm.fixedRate)   || 0;
  const editBookingRateNum   = parseFloat(editForm.bookingRate)  || editFixedRateNum;
  const editDiscountPerNight = editFixedRateNum > 0 && editBookingRateNum < editFixedRateNum
    ? editFixedRateNum - editBookingRateNum : 0;
  const editDiscountPct      = editFixedRateNum > 0 && editDiscountPerNight > 0
    ? Math.round((editDiscountPerNight / editFixedRateNum) * 100) : 0;
  const editTotalSaving      = editDiscountPerNight > 0 && editNights > 0
    ? editDiscountPerNight * editNights : 0;

  const editHasChanges = editTarget !== null && (
    editForm.guestName   !== editTarget.guestName                                     ||
    editForm.phone       !== (editTarget.phone ?? "")                                 ||
    editForm.email       !== (editTarget.email ?? "")                                 ||
    editForm.room        !== editTarget.roomNumber                                    ||
    editForm.checkIn     !== (editTarget.checkInISO  ?? "")                           ||
    editForm.checkOut    !== (editTarget.checkOutISO ?? "")                           ||
    editForm.totalGuests !== editTarget.totalGuests                                   ||
    JSON.stringify(editForm.additionalGuests) !==
      JSON.stringify(editTarget.additionalGuests ?? [])                               ||
    parseFloat(editForm.totalAmount) !== editTarget.totalAmount                       ||
    parseFloat(editForm.fixedRate)   !== (editTarget.fixedRate   ?? 0)                ||
    parseFloat(editForm.bookingRate) !== (editTarget.bookingRate ?? 0)
  );

  // ── Effects ────────────────────────────────────────────────
  useEffect(() => {
    if (initialRoom) {
      setForm(f => ({ ...f, room: initialRoom }));
      setFormOpen(true);
    }
  }, [initialRoom]);

  useEffect(() => {
    if (!successMsg) return;
    const t = setTimeout(() => setSuccessMsg(""), 4000);
    return () => clearTimeout(t);
  }, [successMsg]);

  // Close payment modal on Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") closePayModal();
    }
    if (payModal) document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [payModal]);

  // Close checkout confirmation modal on Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") closeCheckoutConfirm();
    }
    if (checkoutConfirm) document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [checkoutConfirm]);

  // Close timeline modal on Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setTimelineModal(null);
    }
    if (timelineModal) document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [timelineModal]);

  // Close documents modal on Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") closeDocsModal(); }
    if (docsModal) document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [docsModal]); // eslint-disable-line react-hooks/exhaustive-deps

  // Pre-fill edit form fields when a booking is selected for editing
  useEffect(() => {
    if (!editTarget) return;
    setEditForm({
      guestName:        editTarget.guestName,
      phone:            editTarget.phone         ?? "",
      email:            editTarget.email         ?? "",
      room:             editTarget.roomNumber,
      checkIn:          editTarget.checkInISO    ?? "",
      checkOut:         editTarget.checkOutISO   ?? "",
      totalGuests:      editTarget.totalGuests,
      additionalGuests: editTarget.additionalGuests ?? [],
      fixedRate:        String(editTarget.fixedRate   ?? ""),
      bookingRate:      String(editTarget.bookingRate ?? ""),
      totalAmount:      String(editTarget.totalAmount),
      amountPaid:       String(editTarget.amountPaid),
    });
    setEditErrors({});
  }, [editTarget?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Close confirmation modal on Escape — leaves edit modal open behind it
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") handleConfirmCancel();
    }
    if (confirmDiffs !== null) document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [confirmDiffs]); // eslint-disable-line react-hooks/exhaustive-deps

  // Close edit booking modal on Escape (skip when confirm overlay is on top)
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (confirmDiffs !== null) return;   // confirm modal handles this ESC
        handleEditCancel();
      }
    }
    if (editTarget) document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [editTarget, confirmDiffs]); // eslint-disable-line react-hooks/exhaustive-deps

  // Prevent body scroll when edit modal is open
  useEffect(() => {
    if (editTarget) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => { document.body.style.overflow = ""; };
  }, [editTarget]);

  // Auto-fill fixedRate and bookingRate when the room changes.
  // Both start at the published room price. Staff can lower bookingRate to apply a discount.
  useEffect(() => {
    if (roomInfo) {
      setForm(prev => ({
        ...prev,
        fixedRate:   String(roomInfo.price),
        bookingRate: String(roomInfo.price),
      }));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomInfo?.price]);

  // Auto-fill totalAmount from bookingRate × nights.
  // Fires whenever the user edits bookingRate or when dates change.
  // Staff can still override totalAmount directly for packages or flat rates.
  useEffect(() => {
    const rate = parseFloat(form.bookingRate) || 0;
    if (rate > 0 && nights > 0) {
      setForm(prev => ({ ...prev, totalAmount: String(rate * nights) }));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.bookingRate, nights]);

  // ── Core form field handler ─────────────────────────────────
  function setField<K extends keyof FormData>(key: K, value: FormData[K]) {
    setForm(prev => ({ ...prev, [key]: value }));
    if (errors[key]) setErrors(prev => ({ ...prev, [key]: undefined }));
  }

  // ── Additional guests handlers ──────────────────────────────

  /** Append a blank guest row. Also bumps totalGuests if needed. */
  function addAdditionalGuest() {
    setForm(prev => {
      const next = [...prev.additionalGuests, { name: "", nationality: "" }];
      return {
        ...prev,
        additionalGuests: next,
        // auto-bump the count so it's always ≥ 1 (primary) + named extras
        totalGuests: Math.max(prev.totalGuests, next.length + 1),
      };
    });
  }

  /** Update a single field on one additional-guest row. */
  function updateAdditionalGuest(
    index: number,
    field: keyof AdditionalGuest,
    value: string
  ) {
    setForm(prev => ({
      ...prev,
      additionalGuests: prev.additionalGuests.map((g, i) =>
        i === index ? { ...g, [field]: value } : g
      ),
    }));
  }

  /** Remove an additional-guest row. */
  function removeAdditionalGuest(index: number) {
    setForm(prev => ({
      ...prev,
      additionalGuests: prev.additionalGuests.filter((_, i) => i !== index),
    }));
  }

  // ── Validation ─────────────────────────────────────────────
  function validate(): boolean {
    const e: Partial<Record<keyof FormData, string>> = {};
    if (!form.guest.trim()) e.guest    = "Guest name is required.";
    if (!form.room.trim())  e.room     = "Room number is required.";
    if (!form.checkIn)      e.checkIn  = "Check-in date is required.";
    if (!form.checkOut)     e.checkOut = "Check-out date is required.";
    if (form.checkIn && form.checkOut && calcNights(form.checkIn, form.checkOut) <= 0)
      e.checkOut = "Check-out must be after check-in.";
    if (form.email.trim()) {
      const em = form.email.trim();
      const at = em.indexOf("@");
      const dot = em.lastIndexOf(".");
      if (at < 1 || dot < at + 2 || dot === em.length - 1)
        e.email = "Invalid email format.";
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  // ── Submit ─────────────────────────────────────────────────
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validate()) return;

    // Validate pending documents — each must have both type and file, or be empty
    const incompleteDoc = pendingDocs.find(d => (d.docType && !d.file) || (!d.docType && d.file));
    if (incompleteDoc) {
      setPendingDocError(
        !incompleteDoc.docType
          ? "Please select a document type for each added document."
          : "Please select a file for each added document."
      );
      return;
    }
    setPendingDocError("");

    // ── Layer B: double-booking guard ─────────────────────────
    // Re-check against the live bookings array right before we commit.
    // This catches any race where the useMemo warning was dismissed or
    // the form was submitted programmatically.
    const conflict = findRoomConflict(bookings, form.room.trim(), form.checkIn, form.checkOut);
    if (conflict) {
      console.warn(
        `[handleSubmit] double-booking blocked — room ${form.room} conflicts with` +
        ` booking ${conflict.id} (${conflict.checkIn} – ${conflict.checkOut})`
      );
      setErrors(prev => ({
        ...prev,
        room: "Room is unavailable for this date range. Please select another room or different dates.",
      }));
      return;
    }
    // ─────────────────────────────────────────────────────────

    const n    = calcNights(form.checkIn, form.checkOut);
    const info = rooms.find(r => r.roomNumber === form.room.trim());

    // Strip empty rows from additionalGuests before saving
    const cleanedExtras = form.additionalGuests
      .filter(g => g.name.trim() !== "")
      .map(g => ({ name: g.name.trim(), nationality: g.nationality.trim() }));

    // Resolve amounts — fall back to room estimate if staff left totalAmount blank
    const resolvedTotal = totalAmountNum > 0
      ? totalAmountNum
      : info ? info.price * n : 0;
    const resolvedPaid  = amountPaidNum;

    const resolvedFixedRate   = parseFloat(form.fixedRate)   || info?.price || 0;
    const resolvedBookingRate = parseFloat(form.bookingRate) || resolvedFixedRate;

    const newBooking: Booking = {
      id:               `BK-${nextBookingId}`,
      guestName:        form.guest.trim(),
      phone:            form.phone.trim() || "—",
      email:            form.email.trim() || undefined,
      roomNumber:       form.room.trim(),
      roomCategory:     info?.category ?? "Unknown",
      checkIn:          formatDate(form.checkIn),
      checkOut:         formatDate(form.checkOut),
      checkInISO:       form.checkIn,    // already YYYY-MM-DD from <input type="date">
      checkOutISO:      form.checkOut,
      nights:           n,
      status:           form.status,
      payment:          derivePaymentStatus(resolvedTotal, resolvedPaid),
      totalAmount:      resolvedTotal,
      amountPaid:       resolvedPaid,
      fixedRate:        resolvedFixedRate   || undefined,
      bookingRate:      resolvedBookingRate || undefined,
      // Ensure count is never less than actual named guests + primary
      totalGuests:      Math.max(form.totalGuests, cleanedExtras.length + 1),
      additionalGuests: cleanedExtras,
      createdAt:        new Date().toISOString(),
      isNew:            true,
    };

    createBooking(newBooking, bookingPayMethod);

    const guestSummary = cleanedExtras.length > 0
      ? ` · ${newBooking.totalGuests} guests total`
      : "";
    const paymentSummary = resolvedPaid > 0
      ? ` · ৳${resolvedPaid.toLocaleString()} paid`
      : " · payment pending";

    // ── Upload staged documents (if any) ───────────────────────
    const docsToUpload = pendingDocs.filter(d => d.docType && d.file);
    if (docsToUpload.length > 0) {
      const bookingRef = newBooking.id;
      let uploadFailed = false;

      // Sequential uploads so each can be individually diagnosed in console
      for (const pd of docsToUpload) {
        try {
          await uploadDocument(
            bookingRef,
            pd.file!,
            pd.docType,
            pd.note || null,
            user?.id ?? null,
          );
          console.log(`[BookingsClient] pending doc uploaded → booking_ref=${bookingRef}, type=${pd.docType}`);
        } catch (err) {
          uploadFailed = true;
          const msg = err instanceof Error ? err.message : String(err);
          console.error(
            `[BookingsClient] pending doc upload failed →`,
            `\n  booking_ref: ${bookingRef}`,
            `\n  docType:     ${pd.docType}`,
            `\n  fileName:    ${pd.file!.name}`,
            `\n  error:       ${msg}`,
          );
        }
      }

      if (uploadFailed) {
        setSuccessMsg(
          `Booking ${newBooking.id} created for ${newBooking.guestName}${guestSummary}${paymentSummary} · Room ${newBooking.roomNumber} is now Reserved — ⚠️ Document upload failed. You can upload documents later from the Documents button.`
        );
      } else {
        setSuccessMsg(
          `Booking ${newBooking.id} created for ${newBooking.guestName}${guestSummary}${paymentSummary} · Room ${newBooking.roomNumber} is now Reserved`
        );
      }
    } else {
      setSuccessMsg(
        `Booking ${newBooking.id} created for ${newBooking.guestName}${guestSummary}${paymentSummary} · Room ${newBooking.roomNumber} is now Reserved`
      );
    }

    setPendingDocs([]);
    setPendingDocError("");
    setForm(EMPTY_FORM);
    setBookingPayMethod("cash");
    setFormOpen(false);
    setActiveFilter("All");
    setSearchQuery("");
    setDateFrom(dateOffsetISO(-7));
    setDateTo(dateOffsetISO(30));
    setDateFilterActive(true);
  }

  function handleCancel() {
    setForm({ ...EMPTY_FORM, room: initialRoom ?? "" });
    setBookingPayMethod("cash");
    setErrors({});
    setPendingDocs([]);
    setPendingDocError("");
    setFormOpen(false);
  }

  // ── Pending-doc helpers (Create Booking form) ───────────────

  function addPendingDoc() {
    setPendingDocs(prev => [
      ...prev,
      { id: crypto.randomUUID(), docType: "", file: null, note: "" },
    ]);
  }

  function updatePendingDoc(id: string, field: keyof Omit<PendingDoc, "id" | "file">, value: string) {
    setPendingDocs(prev =>
      prev.map(d => d.id === id ? { ...d, [field]: value } : d)
    );
  }

  function handlePendingFileChange(id: string, e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null;
    setPendingDocs(prev =>
      prev.map(d => d.id === id ? { ...d, file } : d)
    );
  }

  function removePendingDoc(id: string) {
    setPendingDocs(prev => prev.filter(d => d.id !== id));
  }

  // ── Payment modal handlers ──────────────────────────────────

  function openPayModal(booking: Booking) {
    // Guard: read live status + current role and block before even opening
    const liveStatus    = bookings.find(b => b.id === booking.id)?.status ?? booking.status;
    const currentRole   = role;
    const canAddPayment = currentRole === "admin" || liveStatus === "Checked In";

    if (!canAddPayment) {
      console.log("[recordPayment] blocked before check-in", {
        bookingId: booking.id,
        liveStatus,
        currentRole,
      });
      return;
    }
    setPayModal(booking);
    setPayAmount("");
    setPayError("");
    setPayMethod("cash");
  }

  function closePayModal() {
    setPayModal(null);
    setPayAmount("");
    setPayError("");
    setPayMethod("cash");
  }

  // ── Workflow action handler ─────────────────────────────────
  /**
   * Called whenever the "Check In" or "Check Out" button is clicked.
   * "Check Out" always opens the checkout confirmation modal — no checkout
   * can ever happen without the operator reviewing the billing summary first.
   * Check In passes straight through.
   */
  function handleWorkflowAction(booking: Booking, nextStatus: BookingStatus) {
    if (nextStatus === "Checked Out") {
      setCheckoutConfirm(booking);
      setCheckoutOpenedAt(new Date());   // stamp "actual checkout time" for timing panel
      setChargeType(""); setChargeAmount(""); setChargeNote(""); setChargeError("");
      setShowModalPay(false); setModalPayAmt(""); setModalPayError("");
      setOverrideReason(""); setOverrideError("");
      setMoreDiscountAmt(""); setMoreDiscountReason(""); setDiscountError("");
      setCheckoutPayMethod("cash");
    } else {
      changeBookingStatus(booking.id, nextStatus);
    }
  }

  // ── Checkout confirmation modal handlers ───────────────────
  function closeCheckoutConfirm() {
    setCheckoutConfirm(null);
    setCheckoutOpenedAt(null);
    setChargeType(""); setChargeAmount(""); setChargeNote(""); setChargeError("");
    setShowModalPay(false); setModalPayAmt(""); setModalPayError("");
    setOverrideReason(""); setOverrideError("");
    setMoreDiscountAmt(""); setMoreDiscountReason(""); setDiscountError("");
    setCheckoutPayMethod("cash");
  }

  /** Records a payment entered inside the checkout confirmation modal. */
  function handleModalPayment() {
    if (!checkoutConfirm) return;

    // ── Hard payment guard ────────────────────────────────────────
    // Read booking status from the LIVE bookings array (not the stale modal
    // snapshot) and role directly from the auth context.
    const liveBooking   = bookings.find(b => b.id === checkoutConfirm.id);
    const liveStatus    = liveBooking?.status ?? checkoutConfirm.status;
    const currentRole   = role;   // "admin" | "staff" | null — from useAuth()
    const canAddPayment = currentRole === "admin" || liveStatus === "Checked In";

    if (!canAddPayment) {
      console.log("[recordPayment] blocked before check-in", {
        bookingId: checkoutConfirm.id,
        liveStatus,
        currentRole,
      });
      setModalPayError("Payment can only be added after check-in.");
      return;
    }
    // ─────────────────────────────────────────────────────────────

    const amt       = parseFloat(modalPayAmt);
    const extraAmt  = parseFloat(chargeAmount) || 0;
    const { earlyAmt: earlyDeductionAmt } = calcEarlyDeduction(
      checkoutConfirm.checkOut,
      checkoutConfirm.bookingRate,
      checkoutConfirm.totalAmount,
      checkoutConfirm.nights,
      checkoutOpenedAt ?? new Date(),
    );
    const moreDiscAmt = parseFloat(moreDiscountAmt) || 0;
    const maxPay = (checkoutConfirm.totalAmount + extraAmt) - earlyDeductionAmt - moreDiscAmt - liveAmountPaid;
    if (isNaN(amt) || amt <= 0) {
      setModalPayError("Enter a valid amount greater than ৳0.");
      return;
    }
    if (amt > maxPay) {
      setModalPayError(`Cannot exceed outstanding balance of ৳${maxPay.toLocaleString()}.`);
      return;
    }
    recordPayment(checkoutConfirm.id, amt, checkoutPayMethod, currentRole ?? "staff");
    setShowModalPay(false);
    setModalPayAmt("");
    setModalPayError("");
  }

  /**
   * Validates extra charge fields; returns formatted reason string or null.
   * Returns undefined (not null) when validation fails — callers check for undefined.
   */
  function validateAndBuildCharge(): { amount: number; reason: string | null } | undefined {
    const amt = parseFloat(chargeAmount) || 0;
    if (chargeType && amt <= 0) {
      setChargeError("Enter a valid charge amount greater than ৳0.");
      return undefined;
    }
    if (chargeType === "Other" && !chargeNote.trim()) {
      setChargeError("Description is required when charge type is 'Other'.");
      return undefined;
    }
    return { amount: amt, reason: formatChargeReason(chargeType, chargeNote) };
  }

  /**
   * Validates "More Discount" inputs.
   * remainingAfterPayment = totalAmount + extraChargeAmt − earlyDeductionAmt − amountPaid
   * Returns { amount } on success, undefined on validation failure (sets discountError).
   */
  function validateAndBuildDiscount(
    remainingAfterPayment: number,
  ): { amount: number } | undefined {
    const amt = parseFloat(moreDiscountAmt) || 0;
    if (amt < 0) {
      setDiscountError("Discount amount cannot be negative.");
      return undefined;
    }
    if (amt > remainingAfterPayment) {
      setDiscountError(
        `Discount cannot exceed remaining balance of ৳${remainingAfterPayment.toLocaleString()}.`
      );
      return undefined;
    }
    return { amount: amt };
  }

  /**
   * Confirms normal checkout (finalPayable ≤ 0).
   * Stores extra charges if present, then changes status to Checked Out.
   */
  function handleConfirmCheckout() {
    if (!checkoutConfirm) return;
    const charge = validateAndBuildCharge();
    if (charge === undefined) return;
    const { earlyDays, earlyAmt: earlyDeductionAmt, actualDateISO } = calcEarlyDeduction(
      checkoutConfirm.checkOut,
      checkoutConfirm.bookingRate,
      checkoutConfirm.totalAmount,
      checkoutConfirm.nights,
      checkoutOpenedAt ?? new Date(),
    );
    const remainingAfterPayment =
      checkoutConfirm.totalAmount + charge.amount - earlyDeductionAmt - liveAmountPaid;
    const discount = validateAndBuildDiscount(remainingAfterPayment);
    if (discount === undefined) return;
    const finalPayable = remainingAfterPayment - discount.amount;
    if (finalPayable > 0) {
      setOverrideError("There is an outstanding balance. Admin override is required to proceed.");
      return;
    }
    checkoutNormal(
      checkoutConfirm.id,
      charge.amount,
      charge.reason,
      actualDateISO,
      earlyDays,
      earlyDeductionAmt,
      discount.amount,
      moreDiscountReason.trim() || null,
      checkoutPayMethod,
    );
    setSuccessMsg(
      `${checkoutConfirm.guestName} checked out · Room ${checkoutConfirm.roomNumber} is now Cleaning.`
    );
    closeCheckoutConfirm();
  }

  function handleAdminOverride(e: React.FormEvent) {
    e.preventDefault();
    if (!checkoutConfirm) return;
    if (!isAdmin) {
      setOverrideError("Only admins can use this override.");
      return;
    }
    const charge = validateAndBuildCharge();
    if (charge === undefined) return;
    const { earlyDays, earlyAmt: earlyDeductionAmt, actualDateISO } = calcEarlyDeduction(
      checkoutConfirm.checkOut,
      checkoutConfirm.bookingRate,
      checkoutConfirm.totalAmount,
      checkoutConfirm.nights,
      checkoutOpenedAt ?? new Date(),
    );
    const remainingAfterPayment =
      checkoutConfirm.totalAmount + charge.amount - earlyDeductionAmt - liveAmountPaid;
    const discount = validateAndBuildDiscount(remainingAfterPayment);
    if (discount === undefined) return;
    const finalPayable = remainingAfterPayment - discount.amount;
    checkoutWithOverride(
      checkoutConfirm.id,
      overrideReason,
      charge.amount,
      charge.reason,
      actualDateISO,
      earlyDays,
      earlyDeductionAmt,
      discount.amount,
      moreDiscountReason.trim() || null,
      checkoutPayMethod,
    );
    setSuccessMsg(
      `Admin override: ${checkoutConfirm.guestName} checked out with ৳${finalPayable.toLocaleString()} still outstanding.`
    );
    closeCheckoutConfirm();
  }

  // ── Document modal handlers ─────────────────────────────────

  async function openDocsModal(booking: Booking) {
    setDocsModal(booking);
    setDocsList([]);
    setDocsLoading(true);
    setDocsError("");
    setDocType(""); setDocFile(null); setDocNote(""); setDocUploadError("");
    try {
      const docs = await getDocuments(booking.id);
      setDocsList(docs);
    } catch (err) {
      // Surface the full error message from the service (includes Supabase details)
      const msg = err instanceof Error ? err.message : String(err);
      setDocsError(msg || "Could not load documents.");
    } finally {
      setDocsLoading(false);
    }
  }

  function closeDocsModal() {
    setDocsModal(null);
    setDocsList([]);
    setDocsLoading(false);
    setDocsError("");
    setDocType(""); setDocFile(null); setDocNote(""); setDocUploadError("");
  }

  async function handleDocUpload() {
    if (!docsModal) return;
    if (!docType) { setDocUploadError("Select a document type."); return; }
    if (!docFile)  { setDocUploadError("Select a file to upload."); return; }

    setDocUploading(true);
    setDocUploadError("");
    try {
      const newDoc = await uploadDocument(
        docsModal.id, docFile, docType, docNote || null, user?.id ?? null,
      );
      setDocsList(prev => [newDoc, ...prev]);
      setDocType(""); setDocFile(null); setDocNote("");
      setSuccessMsg(`Document uploaded for ${docsModal.guestName} · ${docsModal.id}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setDocUploadError(msg || "Upload failed. Please try again.");
    } finally {
      setDocUploading(false);
    }
  }

  async function handleDocDelete(docId: string, storagePath: string) {
    try {
      await deleteDocument(docId, storagePath);
      setDocsList(prev => prev.filter(d => d.id !== docId));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setDocsError(msg || "Could not delete document.");
    }
  }

  function handleDocFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null;
    if (!file) { setDocFile(null); return; }
    if (!ALLOWED_MIME_TYPES.includes(file.type)) {
      setDocUploadError(`Unsupported file type. Allowed: ${ALLOWED_EXTENSIONS_LABEL}`);
      e.target.value = "";
      return;
    }
    setDocUploadError("");
    setDocFile(file);
  }

  // ── Payment modal handlers ──────────────────────────────────

  function handlePaySubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!payModal) return;

    // ── Hard payment guard ────────────────────────────────────────
    // Always look up the booking from the LIVE state — never trust the
    // modal snapshot which may have been opened before a status change.
    const liveBooking   = bookings.find(b => b.id === payModal.id);
    const liveStatus    = liveBooking?.status ?? payModal.status;
    const currentRole   = role;   // "admin" | "staff" | null — from useAuth()
    const canAddPayment = currentRole === "admin" || liveStatus === "Checked In";

    if (!canAddPayment) {
      console.log("[recordPayment] blocked before check-in", {
        bookingId: payModal.id,
        liveStatus,
        currentRole,
      });
      setPayError("Payment can only be added after check-in.");
      return;
    }
    // ─────────────────────────────────────────────────────────────

    const amount = parseFloat(payAmount);
    const due    = calcTrueDue(payModal);

    if (!payAmount.trim() || isNaN(amount) || amount <= 0) {
      setPayError("Please enter a valid payment amount greater than ৳0.");
      return;
    }
    if (amount > due) {
      setPayError(
        `Amount cannot exceed the outstanding balance of ৳${due.toLocaleString()}. ` +
        `Enter ৳${due.toLocaleString()} or less.`
      );
      return;
    }

    recordPayment(payModal.id, amount, payMethod, currentRole ?? "staff");
    setSuccessMsg(
      `Payment of ৳${amount.toLocaleString()} recorded for booking ${payModal.id} · ` +
      `৳${(payModal.amountPaid + amount).toLocaleString()} now paid of ৳${payModal.totalAmount.toLocaleString()}`
    );
    closePayModal();
  }

  // ── Edit confirmation helpers ──────────────────────────────

  /** Returns true when any field that warrants a risky-change review step is changing. */
  function isRiskyEdit(changes: import("@/services/bookingsService").UpdateBookingPayload): boolean {
    return (
      changes.bookingRate  !== undefined ||
      changes.fixedRate    !== undefined ||
      changes.roomNumber   !== undefined ||
      changes.checkInISO   !== undefined ||
      changes.checkOutISO  !== undefined
    );
  }

  function handleConfirmCancel() {
    setConfirmDiffs(null);
    setPendingChanges(null);
  }

  function handleConfirmSubmit() {
    if (!editTarget || !pendingChanges) return;
    setEditSaving(true);
    updateBooking(editTarget.id, pendingChanges, editTarget);
    setConfirmDiffs(null);
    setPendingChanges(null);
    handleEditCancel();
  }

  // ── Edit booking handlers ──────────────────────────────────

  /** Append a blank additional-guest row in the edit form. */
  function addEditGuest() {
    setEditForm(prev => {
      const next = [...prev.additionalGuests, { name: "", nationality: "" }];
      return {
        ...prev,
        additionalGuests: next,
        totalGuests: Math.max(prev.totalGuests, next.length + 1),
      };
    });
  }

  /** Update a field on one additional-guest row in the edit form. */
  function updateEditGuest(index: number, field: keyof AdditionalGuest, value: string) {
    setEditForm(prev => ({
      ...prev,
      additionalGuests: prev.additionalGuests.map((g, i) =>
        i === index ? { ...g, [field]: value } : g
      ),
    }));
  }

  /** Remove an additional-guest row from the edit form. */
  function removeEditGuest(index: number) {
    setEditForm(prev => ({
      ...prev,
      additionalGuests: prev.additionalGuests.filter((_, i) => i !== index),
    }));
  }

  function validateEdit(): boolean {
    const e: Partial<Record<keyof EditFormData, string>> = {};
    if (!editForm.guestName.trim()) e.guestName = "Guest name is required.";
    if (!editForm.room.trim())      e.room      = "Room number is required.";
    if (!editForm.checkIn)          e.checkIn   = "Check-in date is required.";
    if (!editForm.checkOut)         e.checkOut  = "Check-out date is required.";
    if (editForm.checkIn && editForm.checkOut && calcNights(editForm.checkIn, editForm.checkOut) <= 0)
      e.checkOut = "Check-out must be after check-in.";
    if (editForm.email.trim()) {
      const em  = editForm.email.trim();
      const at  = em.indexOf("@");
      const dot = em.lastIndexOf(".");
      if (at < 1 || dot < at + 2 || dot === em.length - 1)
        e.email = "Invalid email format.";
    }
    // Guard: amountPaid cannot exceed totalAmount — prevents phantom "Paid" status.
    const editAmountPaidNum  = parseFloat(editForm.amountPaid)  || 0;
    const editTotalAmountNum = parseFloat(editForm.totalAmount) || 0;
    if (editAmountPaidNum > editTotalAmountNum && editTotalAmountNum > 0)
      e.amountPaid = `Amount paid (৳${editAmountPaidNum.toLocaleString()}) cannot exceed total amount (৳${editTotalAmountNum.toLocaleString()}).`;
    setEditErrors(e);
    return Object.keys(e).length === 0;
  }

  function handleEditSubmit() {
    if (!editTarget) return;
    if (!validateEdit()) return;
    if (!editHasChanges) { handleEditCancel(); return; }

    const changes: import("@/services/bookingsService").UpdateBookingPayload = {};

    if (editForm.guestName !== editTarget.guestName)
      changes.guestName = editForm.guestName.trim();

    if (editForm.phone !== (editTarget.phone ?? ""))
      changes.phone = editForm.phone.trim();

    if (editForm.email.trim() !== "" && editForm.email !== (editTarget.email ?? ""))
      changes.email = editForm.email.trim();

    if (editForm.room !== editTarget.roomNumber) {
      const editedRoomInfo = rooms.find(r => r.roomNumber === editForm.room.trim());
      changes.roomNumber   = editForm.room.trim();
      changes.roomCategory = (editedRoomInfo?.category ?? editTarget.roomCategory).toLowerCase();
    }

    if (editForm.checkIn  !== (editTarget.checkInISO  ?? "")) changes.checkInISO  = editForm.checkIn;
    if (editForm.checkOut !== (editTarget.checkOutISO ?? "")) changes.checkOutISO = editForm.checkOut;

    // Auto-recompute totalAmount when dates or rate change.
    // nights is a DB GENERATED column and cannot be written directly (error 23508).
    // The manual override check below lets the user's explicit totalAmount value win.
    const ciISO = changes.checkInISO  ?? editTarget.checkInISO  ?? "";
    const coISO = changes.checkOutISO ?? editTarget.checkOutISO ?? "";
    if (changes.checkInISO !== undefined || changes.checkOutISO !== undefined || changes.bookingRate !== undefined) {
      const rateForCompute = changes.bookingRate ?? editTarget.bookingRate ?? 0;
      const newNights      = calcNights(ciISO, coISO);
      if (rateForCompute > 0 && newNights > 0) changes.totalAmount = rateForCompute * newNights;
    }
    // Manual override: if user explicitly changed totalAmount, their value wins
    const newTotal = parseFloat(editForm.totalAmount);
    if (!isNaN(newTotal) && newTotal !== editTarget.totalAmount) changes.totalAmount = newTotal;

    const newFixed = parseFloat(editForm.fixedRate);
    if (!isNaN(newFixed) && newFixed !== (editTarget.fixedRate ?? 0))
      changes.fixedRate = newFixed;

    const newRate = parseFloat(editForm.bookingRate);
    if (!isNaN(newRate) && newRate !== (editTarget.bookingRate ?? 0))
      changes.bookingRate = newRate;

    if (editForm.totalGuests !== editTarget.totalGuests)
      changes.totalGuests = editForm.totalGuests;

    const cleanedExtras = editForm.additionalGuests
      .filter(g => g.name.trim() !== "")
      .map(g => ({ name: g.name.trim(), nationality: g.nationality.trim() }));
    if (JSON.stringify(cleanedExtras) !== JSON.stringify(editTarget.additionalGuests ?? []))
      changes.additionalGuests = cleanedExtras;

    if (Object.keys(changes).length === 0) { handleEditCancel(); return; }

    // ── Risky-edit review step ────────────────────────────────
    // Room, date, and rate changes get a confirmation modal showing a diff
    // table before the save is dispatched.
    if (isRiskyEdit(changes)) {
      const diffs: Array<{ field: string; from: string; to: string }> = [];
      if (changes.roomNumber  !== undefined)
        diffs.push({ field: "Room",           from: editTarget.roomNumber,       to: changes.roomNumber });
      if (changes.checkInISO  !== undefined)
        diffs.push({ field: "Check-in",       from: editTarget.checkInISO  ?? "", to: changes.checkInISO });
      if (changes.checkOutISO !== undefined)
        diffs.push({ field: "Check-out",      from: editTarget.checkOutISO ?? "", to: changes.checkOutISO });
      if (changes.bookingRate !== undefined)
        diffs.push({ field: "Booking Rate",   from: `৳${editTarget.bookingRate ?? 0}`, to: `৳${changes.bookingRate}` });
      if (changes.fixedRate   !== undefined)
        diffs.push({ field: "Published Rate", from: `৳${editTarget.fixedRate   ?? 0}`, to: `৳${changes.fixedRate}` });
      if (changes.totalAmount !== undefined)
        diffs.push({ field: "Total Amount",   from: `৳${editTarget.totalAmount}`,      to: `৳${changes.totalAmount}` });
      setConfirmDiffs(diffs);
      setPendingChanges(changes);
      return;
    }

    setEditSaving(true);
    updateBooking(editTarget.id, changes, editTarget);
    handleEditCancel();
  }

  function handleEditCancel() {
    setEditTarget(null);
    setEditForm({ ...EMPTY_EDIT_FORM });
    setEditErrors({});
    setEditSaving(false);
  }

  // ── Render ─────────────────────────────────────────────────
  return (
    <div className="p-7 max-w-[1400px] space-y-5">

      {/* ══════════════════════════════════════════════════════
          PAGE HEADER
      ══════════════════════════════════════════════════════ */}
      <div className="flex items-start justify-between">
        <div>
          {initialRoom && (
            <Link href="/" className="inline-flex items-center gap-1.5 text-[12px] font-medium text-slate-400 hover:text-slate-700 transition-colors mb-2 group">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-3.5 h-3.5 group-hover:-translate-x-0.5 transition-transform">
                <path d="M19 12H5M12 5l-7 7 7 7"/>
              </svg>
              Back to Room Board
            </Link>
          )}
          <h1 className="text-[22px] font-semibold text-slate-900 tracking-tight leading-none">Bookings</h1>
          <p className="text-[13px] text-slate-500 mt-1">{bookings.length} reservations total</p>
        </div>

        <div className="flex items-center gap-3">
          {!formOpen && (
            <button
              onClick={() => setFormOpen(true)}
              className="flex items-center gap-2 bg-slate-900 hover:bg-slate-800 text-white text-[13px] font-medium px-4 py-2.5 rounded-lg transition-colors shadow-sm"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-4 h-4">
                <path d="M12 5v14M5 12h14"/>
              </svg>
              New Booking
            </button>
          )}
        </div>
      </div>

      {/* ══════════════════════════════════════════════════════
          PAGE VIEW TABS
          "All Bookings" ↔ "Outstanding Dues"
      ══════════════════════════════════════════════════════ */}
      <div className="flex items-center gap-1 border-b border-slate-200 -mx-7 px-7">
        {([
          { key: "bookings" as const, label: "All Bookings",     count: bookings.length    },
          { key: "dues"     as const, label: "Outstanding Dues", count: dueBookings.length },
        ]).map(tab => (
          <button
            key={tab.key}
            onClick={() => setPageView(tab.key)}
            className={`flex items-center gap-2 px-5 py-3 text-[13px] font-semibold border-b-2 transition-colors -mb-px ${
              pageView === tab.key
                ? "border-slate-900 text-slate-900"
                : "border-transparent text-slate-400 hover:text-slate-700 hover:border-slate-300"
            }`}
          >
            {tab.label}
            <span className={`text-[11px] font-bold px-1.5 py-0.5 rounded-full ${
              pageView === tab.key
                ? tab.key === "dues" && tab.count > 0
                  ? "bg-rose-600 text-white"
                  : "bg-slate-800 text-white"
                : tab.key === "dues" && tab.count > 0
                  ? "bg-rose-50 text-rose-600 ring-1 ring-rose-200"
                  : "bg-slate-100 text-slate-500"
            }`}>
              {tab.count}
            </span>
          </button>
        ))}
      </div>

      {/* ══════════════════════════════════════════════════════
          SUCCESS BANNER — always visible across both views
      ══════════════════════════════════════════════════════ */}
      {successMsg && (
        <div className="flex items-center gap-3 bg-emerald-50 border border-emerald-200 rounded-xl px-5 py-3.5">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-5 h-5 text-emerald-600 flex-shrink-0">
            <path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><path d="M22 4L12 14.01l-3-3"/>
          </svg>
          <p className="text-[13px] font-medium text-emerald-800">{successMsg}</p>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════
          BOOKINGS VIEW — room banner, form, filters, table
      ══════════════════════════════════════════════════════ */}
      {pageView === "bookings" && (
      <>

      {/* ══════════════════════════════════════════════════════
          ROOM PRE-SELECTION BANNER
      ══════════════════════════════════════════════════════ */}
      {initialRoom && (
        <div className="flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-xl px-5 py-4">
          <div className="mt-0.5 flex-shrink-0 w-8 h-8 rounded-lg bg-amber-100 flex items-center justify-center">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" className="w-4 h-4 text-amber-600">
              <rect x="3" y="4" width="18" height="17" rx="2"/>
              <path d="M3 10h18M8 2v4M16 2v4M8 14h2M8 18h2M14 14h2M14 18h2"/>
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[13.5px] font-semibold text-amber-900">Creating booking for Room {initialRoom}</p>
            <p className="text-[12.5px] text-amber-700 mt-0.5">
              {roomInfo
                ? `${roomInfo.category} · $${roomInfo.price}/night · up to ${roomInfo.capacity} guest${roomInfo.capacity !== 1 ? "s" : ""} — fill in the details below.`
                : "Fill in the guest details below to confirm the reservation."}
            </p>
          </div>
          {roomInfo && (
            <span className="flex-shrink-0 text-[12px] font-bold text-amber-700 bg-amber-100 border border-amber-300 px-3 py-1.5 rounded-lg whitespace-nowrap">
              {roomInfo.category}
            </span>
          )}
        </div>
      )}

      {/* ══════════════════════════════════════════════════════
          NEW BOOKING FORM
      ══════════════════════════════════════════════════════ */}
      {formOpen && (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">

          {/* Form header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 bg-slate-50">
            <div className="flex items-center gap-2.5">
              <div className="w-7 h-7 rounded-lg bg-slate-800 flex items-center justify-center">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-3.5 h-3.5 text-white">
                  <path d="M12 5v14M5 12h14"/>
                </svg>
              </div>
              <div>
                <h2 className="text-[13.5px] font-semibold text-slate-800 leading-none">New Booking</h2>
                <p className="text-[11.5px] text-slate-400 mt-0.5">Fields marked * are required</p>
              </div>
            </div>
            <button onClick={handleCancel} className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-200 rounded-lg transition-colors">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-4 h-4">
                <path d="M18 6L6 18M6 6l12 12"/>
              </svg>
            </button>
          </div>

          <form onSubmit={handleSubmit} noValidate>

            {/* ── Section 1: Reservation details ── */}
            <div className="p-6 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">

              {/* Primary Guest Name */}
              <div>
                <label className="block text-[12px] font-semibold text-slate-600 mb-1.5 uppercase tracking-wide">
                  Primary Guest <span className="text-rose-500">*</span>
                </label>
                <input
                  type="text"
                  placeholder="Responsible guest name"
                  value={form.guest}
                  onChange={e => setField("guest", e.target.value)}
                  className={`w-full px-3.5 py-2.5 text-[13.5px] text-slate-800 bg-white border rounded-lg
                    placeholder:text-slate-300 focus:outline-none focus:ring-2 focus:ring-amber-400 focus:border-transparent transition
                    ${errors.guest ? "border-rose-300 bg-rose-50" : "border-slate-200"}`}
                />
                {errors.guest && <p className="mt-1 text-[11.5px] text-rose-600">{errors.guest}</p>}
              </div>

              {/* Phone */}
              <div>
                <label className="block text-[12px] font-semibold text-slate-600 mb-1.5 uppercase tracking-wide">
                  Phone Number
                </label>
                <input
                  type="tel"
                  placeholder="e.g. +1 617 555 0101"
                  value={form.phone}
                  onChange={e => setField("phone", e.target.value)}
                  className="w-full px-3.5 py-2.5 text-[13.5px] text-slate-800 bg-white border border-slate-200 rounded-lg
                    placeholder:text-slate-300 focus:outline-none focus:ring-2 focus:ring-amber-400 focus:border-transparent transition"
                />
              </div>

              {/* Email (optional) */}
              <div>
                <label className="block text-[12px] font-semibold text-slate-600 mb-1.5 uppercase tracking-wide">
                  Email <span className="text-slate-400 font-normal normal-case">(optional)</span>
                </label>
                <input
                  type="email"
                  placeholder="e.g. guest@example.com"
                  value={form.email}
                  onChange={e => setField("email", e.target.value)}
                  className={`w-full px-3.5 py-2.5 text-[13.5px] text-slate-800 bg-white border rounded-lg
                    placeholder:text-slate-300 focus:outline-none focus:ring-2 focus:ring-amber-400 focus:border-transparent transition
                    ${errors.email ? "border-rose-400 bg-rose-50" : "border-slate-200"}`}
                />
                {errors.email && (
                  <p className="mt-1 text-[11.5px] text-rose-500">{errors.email}</p>
                )}
              </div>

              {/* Room Number */}
              <div>
                <label className="block text-[12px] font-semibold text-slate-600 mb-1.5 uppercase tracking-wide">
                  Room Number <span className="text-rose-500">*</span>
                </label>
                <div className="relative">
                  <input
                    type="text"
                    placeholder="e.g. 204"
                    value={form.room}
                    onChange={e => setField("room", e.target.value)}
                    className={`w-full px-3.5 py-2.5 text-[13.5px] text-slate-800 bg-white border rounded-lg
                      placeholder:text-slate-300 focus:outline-none focus:ring-2 focus:ring-amber-400 focus:border-transparent transition
                      ${errors.room ? "border-rose-300 bg-rose-50" : "border-slate-200"}`}
                  />
                  {roomInfo && (
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[11px] font-semibold text-amber-600 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded pointer-events-none">
                      {roomInfo.category}
                    </span>
                  )}
                </div>
                {errors.room && <p className="mt-1 text-[11.5px] text-rose-600">{errors.room}</p>}
              </div>

              {/* Check-in */}
              <div>
                <label className="block text-[12px] font-semibold text-slate-600 mb-1.5 uppercase tracking-wide">
                  Check-in Date <span className="text-rose-500">*</span>
                </label>
                <input
                  type="date"
                  value={form.checkIn}
                  onChange={e => setField("checkIn", e.target.value)}
                  className={`w-full px-3.5 py-2.5 text-[13.5px] text-slate-800 bg-white border rounded-lg
                    focus:outline-none focus:ring-2 focus:ring-amber-400 focus:border-transparent transition
                    ${errors.checkIn ? "border-rose-300 bg-rose-50" : "border-slate-200"}`}
                />
                {errors.checkIn && <p className="mt-1 text-[11.5px] text-rose-600">{errors.checkIn}</p>}
                <p className="mt-1 text-[11.5px] text-slate-500">Past dates allowed for backdated entries.</p>
              </div>

              {/* Check-out */}
              <div>
                <label className="block text-[12px] font-semibold text-slate-600 mb-1.5 uppercase tracking-wide">
                  Check-out Date <span className="text-rose-500">*</span>
                </label>
                <input
                  type="date"
                  min={form.checkIn || TODAY}
                  value={form.checkOut}
                  onChange={e => setField("checkOut", e.target.value)}
                  className={`w-full px-3.5 py-2.5 text-[13.5px] text-slate-800 bg-white border rounded-lg
                    focus:outline-none focus:ring-2 focus:ring-amber-400 focus:border-transparent transition
                    ${errors.checkOut ? "border-rose-300 bg-rose-50" : "border-slate-200"}`}
                />
                {errors.checkOut && <p className="mt-1 text-[11.5px] text-rose-600">{errors.checkOut}</p>}
              </div>

              {/* Booking Status */}
              <div>
                <label className="block text-[12px] font-semibold text-slate-600 mb-1.5 uppercase tracking-wide">
                  Booking Status
                </label>
                <select
                  value={form.status}
                  onChange={e => setField("status", e.target.value as BookingStatus)}
                  className="w-full px-3.5 py-2.5 text-[13.5px] text-slate-800 bg-white border border-slate-200 rounded-lg
                    focus:outline-none focus:ring-2 focus:ring-amber-400 focus:border-transparent transition appearance-none cursor-pointer"
                >
                  <option value="Confirmed">Confirmed</option>
                  <option value="Checked In">Checked In</option>
                </select>
              </div>

              {/* ── Stay duration summary (hotel timing policy) ── */}
              {form.checkIn && form.checkOut && nights > 0 && (
                <div className="col-span-full flex items-center gap-3 bg-sky-50 border border-sky-200 rounded-lg px-4 py-2.5">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" className="w-4 h-4 text-sky-500 flex-shrink-0">
                    <circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>
                  </svg>
                  <p className="text-[13px] leading-relaxed">
                    <span className="font-bold text-sky-800">{dayName(form.checkIn)}</span>
                    {" "}<span className="text-sky-700">{formatDateShort(form.checkIn)}</span>
                    {" "}<span className="text-sky-400 mx-0.5">→</span>{" "}
                    <span className="font-bold text-sky-800">{dayName(form.checkOut)}</span>
                    {" "}<span className="text-sky-700">{formatDateShort(form.checkOut)}</span>
                    {" = "}
                    <span className="font-bold text-sky-900">{nights} night{nights !== 1 ? "s" : ""}</span>
                    <span className="text-sky-500 text-[11.5px] ml-2">· Check-in 12:00 PM · Check-out 11:59 AM</span>
                  </p>
                </div>
              )}

              {/* ── Room availability warning (Layer A — live feedback) ── */}
              {roomConflict && (
                <div className="col-span-full flex items-start gap-2.5 bg-rose-50 border border-rose-200 rounded-lg px-4 py-3">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-4 h-4 text-rose-500 flex-shrink-0 mt-0.5">
                    <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
                    <path d="M12 9v4M12 17h.01"/>
                  </svg>
                  <p className="text-[12px] text-rose-700 leading-relaxed">
                    <span className="font-semibold">Room unavailable.</span>{" "}
                    Room {form.room} is already booked{" "}
                    <span className="font-medium">{roomConflict.checkIn} – {roomConflict.checkOut}</span>{" "}
                    (booking <span className="font-mono">{roomConflict.id}</span>,{" "}
                    status: {roomConflict.status}).{" "}
                    Please select another room or different dates.
                  </p>
                </div>
              )}
            </div>

            {/* ── Section 2: Guests ── */}
            <div className="px-6 pb-5">

              {/* Separator */}
              <div className="flex items-center gap-3 mb-5">
                <span className="text-[11px] font-bold text-slate-400 uppercase tracking-widest whitespace-nowrap">
                  Guests
                </span>
                <div className="flex-1 h-px bg-slate-100" />
                {roomInfo && (
                  <span className="text-[11.5px] text-slate-400 whitespace-nowrap">
                    Room capacity: up to <span className="font-semibold text-slate-600">{roomInfo.capacity}</span> guest{roomInfo.capacity !== 1 ? "s" : ""}
                  </span>
                )}
              </div>

              {/* Total Guests */}
              <div className="flex items-end gap-6 mb-5">
                <div className="w-44">
                  <label className="block text-[12px] font-semibold text-slate-600 mb-1.5 uppercase tracking-wide">
                    Total Guests in Room
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={10}
                    value={form.totalGuests}
                    onChange={e =>
                      setField("totalGuests", Math.max(1, parseInt(e.target.value) || 1))
                    }
                    className="w-full px-3.5 py-2.5 text-[13.5px] text-slate-800 bg-white border border-slate-200 rounded-lg
                      focus:outline-none focus:ring-2 focus:ring-amber-400 focus:border-transparent transition"
                  />
                </div>

                {/* Contextual hint */}
                <p className="text-[12px] text-slate-400 pb-2.5 leading-relaxed">
                  {form.totalGuests === 1
                    ? "Primary guest only."
                    : `${form.totalGuests} guests total — ${form.totalGuests - 1} additional.`}
                </p>
              </div>

              {/* Additional Guests list */}
              <div>
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <span className="text-[12px] font-semibold text-slate-600 uppercase tracking-wide">
                      Additional Guests
                    </span>
                    <span className="ml-2 text-[12px] text-slate-400">(optional — name extra guests sharing the room)</span>
                  </div>
                  <button
                    type="button"
                    onClick={addAdditionalGuest}
                    className="flex items-center gap-1.5 text-[12px] font-semibold text-amber-600 hover:text-amber-700 bg-amber-50 hover:bg-amber-100 border border-amber-200 px-3 py-1.5 rounded-lg transition-colors"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="w-3.5 h-3.5">
                      <path d="M12 5v14M5 12h14"/>
                    </svg>
                    Add guest
                  </button>
                </div>

                {form.additionalGuests.length === 0 ? (
                  <p className="text-[12.5px] text-slate-400 italic py-2">
                    No additional guests listed yet.
                  </p>
                ) : (
                  <div className="space-y-2.5">

                    {/* Column labels */}
                    <div className="flex items-center gap-2 px-1">
                      <span className="w-6 flex-shrink-0" />
                      <span className="flex-1 text-[11px] font-semibold text-slate-400 uppercase tracking-wide">Full Name</span>
                      <span className="w-36 text-[11px] font-semibold text-slate-400 uppercase tracking-wide">Nationality</span>
                      <span className="w-8 flex-shrink-0" />
                    </div>

                    {form.additionalGuests.map((guest, i) => (
                      <div key={i} className="flex items-center gap-2">
                        {/* Row number — starts at 2 since primary is guest #1 */}
                        <span className="w-6 text-[11.5px] text-slate-400 font-medium text-right flex-shrink-0">
                          {i + 2}.
                        </span>

                        {/* Name */}
                        <input
                          type="text"
                          placeholder="Guest full name"
                          value={guest.name}
                          onChange={e => updateAdditionalGuest(i, "name", e.target.value)}
                          className="flex-1 px-3 py-2 text-[13px] text-slate-800 bg-white border border-slate-200 rounded-lg
                            placeholder:text-slate-300 focus:outline-none focus:ring-2 focus:ring-amber-400 focus:border-transparent transition"
                        />

                        {/* Nationality */}
                        <input
                          type="text"
                          placeholder="e.g. French"
                          value={guest.nationality}
                          onChange={e => updateAdditionalGuest(i, "nationality", e.target.value)}
                          className="w-36 px-3 py-2 text-[13px] text-slate-800 bg-white border border-slate-200 rounded-lg
                            placeholder:text-slate-300 focus:outline-none focus:ring-2 focus:ring-amber-400 focus:border-transparent transition"
                        />

                        {/* Remove */}
                        <button
                          type="button"
                          onClick={() => removeAdditionalGuest(i)}
                          className="w-8 h-8 flex items-center justify-center text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors flex-shrink-0"
                          title="Remove guest"
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-4 h-4">
                            <path d="M18 6L6 18M6 6l12 12"/>
                          </svg>
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* ── Section 2b: Guest Documents ── */}
            <div className="px-6 pb-5">

              {/* Section separator */}
              <div className="flex items-center gap-3 mb-4">
                <span className="text-[11px] font-bold text-slate-400 uppercase tracking-widest whitespace-nowrap">
                  Guest Documents
                </span>
                <div className="flex-1 h-px bg-slate-100" />
                <span className="text-[11px] text-slate-400 italic">Optional</span>
              </div>

              {/* Helper hint */}
              <p className="text-[12px] text-slate-400 mb-4">
                Upload guest ID, passport, or other documents now. You can also upload them later from the Documents button on any booking.
              </p>

              {/* Pending doc entries */}
              {pendingDocs.length > 0 && (
                <div className="space-y-3 mb-4">
                  {pendingDocs.map((pd, i) => (
                    <div key={pd.id} className="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-3">

                      {/* Row header */}
                      <div className="flex items-center justify-between">
                        <span className="text-[12px] font-semibold text-slate-500 uppercase tracking-wide">
                          Document {i + 1}
                        </span>
                        <button
                          type="button"
                          onClick={() => removePendingDoc(pd.id)}
                          className="w-7 h-7 flex items-center justify-center text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"
                          title="Remove document"
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-3.5 h-3.5">
                            <path d="M18 6L6 18M6 6l12 12"/>
                          </svg>
                        </button>
                      </div>

                      {/* Document type */}
                      <div>
                        <label className="block text-[11.5px] font-semibold text-slate-500 mb-1 uppercase tracking-wide">
                          Document Type <span className="text-rose-400">*</span>
                        </label>
                        <select
                          value={pd.docType}
                          onChange={e => updatePendingDoc(pd.id, "docType", e.target.value)}
                          className="w-full px-3 py-2 text-[13px] text-slate-800 bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-amber-400 focus:border-transparent transition"
                        >
                          <option value="">Select type…</option>
                          {DOCUMENT_TYPES.map(t => (
                            <option key={t} value={t}>{t}</option>
                          ))}
                        </select>
                      </div>

                      {/* File */}
                      <div>
                        <label className="block text-[11.5px] font-semibold text-slate-500 mb-1 uppercase tracking-wide">
                          File <span className="text-rose-400">*</span>
                        </label>
                        <input
                          type="file"
                          accept={ALLOWED_MIME_TYPES.join(",")}
                          onChange={e => handlePendingFileChange(pd.id, e)}
                          className="w-full text-[12.5px] text-slate-600 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0
                            file:text-[12px] file:font-semibold file:bg-amber-50 file:text-amber-700 hover:file:bg-amber-100
                            cursor-pointer transition"
                        />
                        <p className="text-[11px] text-slate-400 mt-1">{ALLOWED_EXTENSIONS_LABEL} — max 10 MB</p>
                      </div>

                      {/* Note */}
                      <div>
                        <label className="block text-[11.5px] font-semibold text-slate-500 mb-1 uppercase tracking-wide">
                          Note <span className="text-slate-400 font-normal normal-case">(optional)</span>
                        </label>
                        <input
                          type="text"
                          placeholder="e.g. Front side of ID"
                          value={pd.note}
                          onChange={e => updatePendingDoc(pd.id, "note", e.target.value)}
                          className="w-full px-3 py-2 text-[13px] text-slate-800 bg-white border border-slate-200 rounded-lg
                            placeholder:text-slate-300 focus:outline-none focus:ring-2 focus:ring-amber-400 focus:border-transparent transition"
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Add document button */}
              <button
                type="button"
                onClick={addPendingDoc}
                className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-violet-600 hover:text-violet-800 transition-colors"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
                  <circle cx="12" cy="12" r="10"/>
                  <path d="M12 8v8M8 12h8"/>
                </svg>
                Add Document
              </button>

              {/* Pre-submit error (e.g. missing type or file) */}
              {pendingDocError && (
                <p className="mt-2 text-[12px] text-rose-500 font-medium">{pendingDocError}</p>
              )}
            </div>

            {/* ── Section 3: Payment ── */}
            <div className="px-6 pb-5">

              {/* Section separator */}
              <div className="flex items-center gap-3 mb-5">
                <span className="text-[11px] font-bold text-slate-400 uppercase tracking-widest whitespace-nowrap">
                  Payment
                </span>
                <div className="flex-1 h-px bg-slate-100" />
              </div>

              {/* ── Rate fields ── */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-5 mb-5">

                {/* Fixed Room Rate */}
                <div>
                  <label className="block text-[12px] font-semibold text-slate-600 mb-1.5 uppercase tracking-wide">
                    Fixed Room Rate <span className="text-slate-400 font-normal normal-case">(per night)</span>
                  </label>
                  <div className="relative">
                    <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 font-semibold pointer-events-none">৳</span>
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      placeholder="Standard published rate"
                      value={form.fixedRate}
                      onChange={e => setField("fixedRate", e.target.value)}
                      onWheel={e => (e.target as HTMLInputElement).blur()}
                      className="w-full pl-7 pr-3.5 py-2.5 text-[13.5px] text-slate-800 bg-slate-50 border border-slate-200 rounded-lg
                        placeholder:text-slate-300 focus:outline-none focus:ring-2 focus:ring-amber-400 focus:border-transparent transition
                        [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                    />
                  </div>
                  <p className="mt-1 text-[11.5px] text-slate-400">Published rate. Auto-filled from room price.</p>
                </div>

                {/* Booking Rate / Discounted Rate */}
                <div>
                  <label className="block text-[12px] font-semibold text-slate-600 mb-1.5 uppercase tracking-wide">
                    Booking Rate <span className="text-slate-400 font-normal normal-case">(per night)</span>
                  </label>
                  <div className="relative">
                    <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 font-semibold pointer-events-none">৳</span>
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      placeholder="Actual negotiated rate"
                      value={form.bookingRate}
                      onChange={e => setField("bookingRate", e.target.value)}
                      onWheel={e => (e.target as HTMLInputElement).blur()}
                      className="w-full pl-7 pr-3.5 py-2.5 text-[13.5px] text-slate-800 bg-white border border-slate-200 rounded-lg
                        placeholder:text-slate-300 focus:outline-none focus:ring-2 focus:ring-amber-400 focus:border-transparent transition
                        [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                    />
                  </div>
                  <p className="mt-1 text-[11.5px] text-slate-400">Lower than fixed rate for discounts. Sets the total.</p>
                </div>

                {/* Discount / Rate Info Strip */}
                {fixedRateNum > 0 && bookingRateNum > 0 && fixedRateNum !== bookingRateNum && (
                  <div className={`sm:col-span-2 flex items-center gap-4 px-4 py-2.5 rounded-lg border text-[12px] font-medium ${
                    discountPerNight > 0
                      ? "bg-emerald-50 border-emerald-200 text-emerald-800"
                      : "bg-amber-50 border-amber-200 text-amber-800"
                  }`}>
                    {discountPerNight > 0 ? (
                      <>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-4 h-4 flex-shrink-0">
                          <path d="M20 12V22H4V12"/><path d="M22 7H2v5h20V7z"/><path d="M12 22V7"/><path d="M12 7H7.5a2.5 2.5 0 010-5C11 2 12 7 12 7z"/><path d="M12 7h4.5a2.5 2.5 0 000-5C13 2 12 7 12 7z"/>
                        </svg>
                        <span>
                          <span className="font-bold">{discountPct}% discount</span>
                          {" · "}৳{discountPerNight.toLocaleString()}/night off
                          {nights > 0 && <span className="font-bold"> · Total saving: ৳{totalSaving.toLocaleString()}</span>}
                        </span>
                      </>
                    ) : (
                      <>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-4 h-4 flex-shrink-0">
                          <circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>
                        </svg>
                        <span>
                          <span className="font-bold">Custom rate</span> — ${(bookingRateNum - fixedRateNum).toLocaleString()}/night above standard published rate
                        </span>
                      </>
                    )}
                  </div>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">

                {/* Total Amount */}
                <div>
                  <label className="block text-[12px] font-semibold text-slate-600 mb-1.5 uppercase tracking-wide">
                    Total Amount (BDT)
                  </label>
                  <div className="relative">
                    <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 font-semibold pointer-events-none">
                      ৳
                    </span>
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      placeholder="0.00"
                      value={form.totalAmount}
                      onChange={e => setField("totalAmount", e.target.value)}
                      onWheel={e => (e.target as HTMLInputElement).blur()}
                      className="w-full pl-7 pr-3.5 py-2.5 text-[13.5px] text-slate-800 bg-white border border-slate-200 rounded-lg
                        placeholder:text-slate-300 focus:outline-none focus:ring-2 focus:ring-amber-400 focus:border-transparent transition
                        [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                    />
                  </div>
                  <p className="mt-1 text-[11.5px] text-slate-400">
                    Auto-computed from booking rate × nights. Override for flat-rate packages.
                  </p>
                </div>

                {/* Amount Paid */}
                <div>
                  <label className="block text-[12px] font-semibold text-slate-600 mb-1.5 uppercase tracking-wide">
                    Amount Paid at Booking
                  </label>
                  <div className="relative">
                    <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 font-semibold pointer-events-none">
                      ৳
                    </span>
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      placeholder="0.00"
                      value={form.amountPaid}
                      onChange={e => setField("amountPaid", e.target.value)}
                      onWheel={e => (e.target as HTMLInputElement).blur()}
                      className="w-full pl-7 pr-3.5 py-2.5 text-[13.5px] text-slate-800 bg-white border border-slate-200 rounded-lg
                        placeholder:text-slate-300 focus:outline-none focus:ring-2 focus:ring-amber-400 focus:border-transparent transition
                        [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                    />
                  </div>
                  <p className="mt-1 text-[11.5px] text-slate-400">
                    Deposit or full payment collected now. Leave 0 if nothing paid yet.
                  </p>
                </div>

                {/* Payment Method — shown only when an initial payment is being collected */}
                {amountPaidNum > 0 && (
                  <div>
                    <label
                      htmlFor="bookingPayMethod"
                      className="block text-[12px] font-semibold text-slate-600 mb-1.5 uppercase tracking-wide"
                    >
                      Payment Method
                    </label>
                    <select
                      id="bookingPayMethod"
                      value={bookingPayMethod}
                      onChange={e => setBookingPayMethod(e.target.value as PaymentMethod)}
                      className="w-full px-3.5 py-2.5 text-[13.5px] text-slate-800 bg-white border border-slate-200 rounded-lg
                        focus:outline-none focus:ring-2 focus:ring-amber-400 focus:border-transparent transition"
                    >
                      {PAYMENT_METHODS.map(m => (
                        <option key={m} value={m}>{PAYMENT_METHOD_LABELS[m]}</option>
                      ))}
                    </select>
                  </div>
                )}

                {/* Due Amount + Payment Status — read-only, auto-computed */}
                <div className="sm:col-span-2 flex flex-wrap items-center gap-6 bg-slate-50 border border-slate-200 rounded-lg px-5 py-3.5">

                  {/* Due */}
                  <div>
                    <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-0.5">
                      Due Amount
                    </p>
                    <p className={`text-[18px] font-bold ${dueAmount > 0 ? "text-rose-600" : "text-emerald-600"}`}>
                      ৳{dueAmount.toLocaleString()}
                    </p>
                  </div>

                  <div className="h-8 w-px bg-slate-200 hidden sm:block" />

                  {/* Payment Status badge */}
                  <div>
                    <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1.5">
                      Payment Status
                    </p>
                    <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[12px] font-semibold ${paymentBadge(formPayStatus)}`}>
                      <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${paymentDot(formPayStatus)}`} />
                      {formPayStatus}
                    </span>
                  </div>

                  <div className="flex-1" />

                  <p className="text-[11.5px] text-slate-400 italic">
                    Auto-computed · will update as you type
                  </p>
                </div>
              </div>
            </div>

            {/* ── Booking summary strip ── */}
            {nights > 0 && (
              <div className="mx-6 mb-4 bg-slate-50 border border-slate-200 rounded-lg px-4 py-3 flex flex-wrap items-center gap-x-6 gap-y-2">
                <div className="text-center">
                  <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Nights</p>
                  <p className="text-[18px] font-bold text-slate-800">{nights}</p>
                </div>
                <div className="h-8 w-px bg-slate-200" />
                <div className="text-center">
                  <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Guests</p>
                  <p className="text-[18px] font-bold text-slate-800">{form.totalGuests}</p>
                </div>
                {roomInfo && (
                  <>
                    <div className="h-8 w-px bg-slate-200" />
                    <div className="text-center">
                      <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Rate / Night</p>
                      <p className="text-[18px] font-bold text-slate-800">৳{roomInfo.price}</p>
                    </div>
                  </>
                )}
                {estimatedTotal != null && (
                  <>
                    <div className="h-8 w-px bg-slate-200" />
                    <div className="text-center">
                      <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Total</p>
                      <p className="text-[18px] font-bold text-slate-800">৳{totalAmountNum > 0 ? totalAmountNum.toLocaleString() : estimatedTotal.toLocaleString()}</p>
                    </div>
                    <div className="h-8 w-px bg-slate-200" />
                    <div className="text-center">
                      <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Paid</p>
                      <p className="text-[18px] font-bold text-emerald-600">৳{amountPaidNum.toLocaleString()}</p>
                    </div>
                    <div className="h-8 w-px bg-slate-200" />
                    <div className="text-center">
                      <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Due</p>
                      <p className={`text-[18px] font-bold ${dueAmount > 0 ? "text-rose-600" : "text-emerald-600"}`}>
                        ৳{dueAmount.toLocaleString()}
                      </p>
                    </div>
                  </>
                )}
                <div className="flex-1" />
                <p className="text-[11.5px] text-slate-400 italic">Room will be marked Reserved on confirm</p>
              </div>
            )}

            {/* Form actions */}
            <div className="flex items-center justify-end gap-3 px-6 pb-5">
              <button
                type="button"
                onClick={handleCancel}
                className="px-4 py-2.5 text-[13px] font-medium text-slate-600 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="flex items-center gap-2 px-5 py-2.5 text-[13px] font-semibold text-white bg-slate-900 hover:bg-slate-800 rounded-lg transition-colors shadow-sm"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-4 h-4">
                  <path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><path d="M22 4L12 14.01l-3-3"/>
                </svg>
                Confirm Booking
              </button>
            </div>
          </form>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════
          FILTER TABS
      ══════════════════════════════════════════════════════ */}
      <div className="flex items-center gap-1 bg-white border border-slate-200 rounded-xl p-1 w-fit shadow-sm">
        {Object.entries(counts).map(([label, count]) => (
          <button
            key={label}
            onClick={() => setActiveFilter(label)}
            className={`flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-[13px] font-medium transition-colors ${
              activeFilter === label
                ? "bg-slate-900 text-white shadow-sm"
                : "text-slate-500 hover:text-slate-700 hover:bg-slate-50"
            }`}
          >
            {label}
            <span className={`text-[11px] font-bold px-1.5 py-0.5 rounded-full ${
              activeFilter === label ? "bg-white/20 text-white" : "bg-slate-100 text-slate-500"
            }`}>
              {count}
            </span>
          </button>
        ))}
      </div>

      {/* ── Toolbar: search + date range ───────────────────── */}
      <div className="flex items-center gap-3 flex-wrap">

        {/* Search */}
        <div className="relative w-full max-w-sm">
          <svg
            viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round"
            className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none"
          >
            <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>
          </svg>
          <input
            type="text"
            placeholder="Search by booking ID, phone, or guest name…"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="w-full pl-9 pr-8 py-2.5 text-[13px] text-slate-800 bg-white border border-slate-200 rounded-xl
              placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-400 focus:border-transparent
              shadow-sm transition"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery("")}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center
                text-slate-400 hover:text-slate-700 rounded-full hover:bg-slate-100 transition-colors"
              aria-label="Clear search"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="w-3 h-3">
                <path d="M18 6L6 18M6 6l12 12"/>
              </svg>
            </button>
          )}
        </div>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Date range filter */}
        <div className="flex items-center gap-2 flex-wrap">
          <label className="text-[12px] font-semibold text-slate-500 uppercase tracking-wide shrink-0">
            Check-in
          </label>

          <input
            type="date"
            value={dateFilterActive ? dateFrom : ""}
            disabled={!dateFilterActive}
            onChange={e => setDateFrom(e.target.value)}
            className={`px-2.5 py-1.5 text-[12.5px] rounded-lg border transition
              focus:outline-none focus:ring-2 focus:ring-amber-400 focus:border-transparent
              ${dateFilterActive
                ? "border-slate-200 text-slate-700 bg-white"
                : "border-slate-100 text-slate-300 bg-slate-50 cursor-not-allowed"}`}
          />

          <span className="text-[12px] text-slate-400">→</span>

          <input
            type="date"
            value={dateFilterActive ? dateTo : ""}
            disabled={!dateFilterActive}
            onChange={e => setDateTo(e.target.value)}
            className={`px-2.5 py-1.5 text-[12.5px] rounded-lg border transition
              focus:outline-none focus:ring-2 focus:ring-amber-400 focus:border-transparent
              ${dateFilterActive
                ? "border-slate-200 text-slate-700 bg-white"
                : "border-slate-100 text-slate-300 bg-slate-50 cursor-not-allowed"}`}
          />

          {/* "All Dates" toggle — amber fill when active (filter OFF), outlined when filter is ON */}
          <button
            onClick={() => setDateFilterActive(v => !v)}
            className={`px-3 py-1.5 text-[12px] font-semibold rounded-lg border transition
              ${!dateFilterActive
                ? "bg-amber-500 border-amber-500 text-white"
                : "border-slate-200 text-slate-500 bg-white hover:bg-slate-50"}`}
          >
            All Dates
          </button>
        </div>

      </div>

      {/* ══════════════════════════════════════════════════════
          BOOKINGS TABLE
      ══════════════════════════════════════════════════════ */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200">
                {["ID", "Primary Guest", "Room", "Guests", "Check-in", "Check-out", "Nights", "Status", "Total", "Paid", "Due", "Payment", "Action"].map((h) => (
                  <th key={h} className="text-left px-5 py-3 text-[11px] font-semibold text-slate-400 uppercase tracking-wider whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredBookings.length === 0 ? (
                <tr>
                  <td colSpan={13} className="px-5 py-10 text-center text-[13px] text-slate-400">
                    {searchQuery.trim()
                      ? "No bookings match your search."
                      : "No bookings match this filter."}
                  </td>
                </tr>
              ) : pagedBookings.map((b) => {
                const action  = nextAction(b.status);
                const due     = calcTrueDue(b);
                const isFutureCheckIn = action?.next === "Checked In" && !canCheckInToday(b.checkInISO);
                return (
                  <tr
                    key={b.id}
                    className={`transition-colors ${
                      b.isNew ? "bg-emerald-50/60 hover:bg-emerald-50" : "hover:bg-slate-50/70"
                    }`}
                  >
                    {/* ID */}
                    <td className="px-5 py-3.5">
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono text-[11.5px] text-slate-400">{b.id}</span>
                        {b.isNew && (
                          <span className="text-[10px] font-bold text-emerald-700 bg-emerald-100 px-1.5 py-0.5 rounded-full uppercase tracking-wide">
                            New
                          </span>
                        )}
                      </div>
                    </td>

                    {/* Primary Guest */}
                    <td className="px-5 py-3.5">
                      <div className="flex items-center gap-2.5">
                        <div className={`w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 text-[10px] font-bold ${avatarColor(b.guestName)}`}>
                          {initials(b.guestName)}
                        </div>
                        <div>
                          <p className="font-semibold text-slate-800 whitespace-nowrap">{b.guestName}</p>
                          {b.phone && b.phone !== "—" && (
                            <p className="text-[11px] text-slate-400">{b.phone}</p>
                          )}
                        </div>
                      </div>
                    </td>

                    {/* Room */}
                    <td className="px-5 py-3.5">
                      <p className="font-semibold text-slate-800">Room {b.roomNumber}</p>
                      <p className="text-[11px] text-slate-400">{b.roomCategory}</p>
                    </td>

                    {/* ── Guests column ────────────────────────────────────
                        Shows total count and up to 2 additional guest names.
                        Full list is in the booking data (additionalGuests[]).
                    ─────────────────────────────────────────────────────── */}
                    <td className="px-5 py-3.5">
                      <p className="font-medium text-slate-700 whitespace-nowrap">
                        {b.totalGuests} {b.totalGuests === 1 ? "guest" : "guests"}
                      </p>
                      {b.additionalGuests.length > 0 && (
                        <div className="mt-0.5 space-y-0.5">
                          {b.additionalGuests.slice(0, 2).map((g, i) => (
                            <p key={i} className="text-[11px] text-slate-400 truncate max-w-[130px]">
                              {g.name}
                            </p>
                          ))}
                          {b.additionalGuests.length > 2 && (
                            <p className="text-[11px] text-slate-400">
                              +{b.additionalGuests.length - 2} more
                            </p>
                          )}
                        </div>
                      )}
                    </td>

                    {/* Dates */}
                    <td className="px-5 py-3.5 text-slate-600 whitespace-nowrap">{b.checkIn}</td>
                    <td className="px-5 py-3.5 text-slate-600 whitespace-nowrap">{b.checkOut}</td>

                    {/* Nights */}
                    <td className="px-5 py-3.5 whitespace-nowrap">
                      <span className="font-semibold text-slate-700">{b.nights}</span>
                      <span className="text-slate-400 text-[12px]"> nt</span>
                    </td>

                    {/* Status cell
                        Override badge logic:
                        • due > 0 + override used → ACTIVE WARNING (amber): balance still outstanding
                        • due = 0 + override used → HISTORY NOTE (slate): settled after checkout
                        • no override            → nothing extra shown
                        `due` is already computed above from live booking data, never stale. */}
                    <td className="px-5 py-3.5">
                      <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-[11.5px] font-semibold whitespace-nowrap ${statusBadge(b.status)}`}>
                        {b.status}
                      </span>
                      {b.checkoutOverride?.used && (
                        due > 0 ? (
                          /* Active: balance still outstanding after an admin-override checkout */
                          <div
                            className="mt-1.5 inline-flex items-center gap-1 text-[10.5px] font-semibold text-amber-700 bg-amber-50 border border-amber-300 px-2 py-0.5 rounded-full cursor-default"
                            title={`Admin override · Reason: ${b.checkoutOverride.reason}`}
                          >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="w-3 h-3 flex-shrink-0">
                              <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
                              <path d="M12 9v4M12 17h.01"/>
                            </svg>
                            Due at checkout
                          </div>
                        ) : (
                          /* Settled: balance cleared after checkout — show quiet history note only */
                          <div
                            className="mt-1.5 inline-flex items-center gap-1 text-[10.5px] font-medium text-slate-400 bg-slate-50 border border-slate-200 px-2 py-0.5 rounded-full cursor-default"
                            title={`Override by ${b.checkoutOverride.by} · "${b.checkoutOverride.reason}" · Balance later settled in full`}
                          >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="w-3 h-3 flex-shrink-0">
                              <path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><path d="M22 4L12 14.01l-3-3"/>
                            </svg>
                            Settled · was overdue
                          </div>
                        )
                      )}
                    </td>

                    {/* Total Amount */}
                    <td className="px-5 py-3.5 font-semibold text-slate-800 whitespace-nowrap">
                      ৳{b.totalAmount.toLocaleString()}
                    </td>

                    {/* Amount Paid */}
                    <td className="px-5 py-3.5 whitespace-nowrap">
                      <span className={`font-semibold ${b.amountPaid > 0 ? "text-emerald-700" : "text-slate-400"}`}>
                        {b.amountPaid > 0 ? `৳${b.amountPaid.toLocaleString()}` : "—"}
                      </span>
                    </td>

                    {/* Due Amount */}
                    <td className="px-5 py-3.5 whitespace-nowrap">
                      {due > 0 ? (
                        <span className="font-semibold text-rose-600">৳{due.toLocaleString()}</span>
                      ) : (
                        <span className="text-slate-400 text-[12px]">—</span>
                      )}
                    </td>

                    {/* Payment Status badge */}
                    <td className="px-5 py-3.5">
                      <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11.5px] font-semibold whitespace-nowrap ${paymentBadge(b.payment)}`}>
                        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${paymentDot(b.payment)}`} />
                        {b.payment}
                      </span>
                    </td>

                    {/* Action — workflow, payment, documents, timeline */}
                    <td className="px-5 py-3.5">
                      <div className="flex flex-col gap-1.5 items-start">

                        {/* ── Booking workflow: Check In → Check Out ── */}
                        {action && (
                          <button
                            onClick={isFutureCheckIn ? undefined : () => handleWorkflowAction(b, action.next)}
                            disabled={isFutureCheckIn}
                            title={isFutureCheckIn ? `Check-in available on ${b.checkIn}` : undefined}
                            className={`text-[11.5px] font-semibold border px-3 py-1.5 rounded-lg whitespace-nowrap
                              ${isFutureCheckIn ? "opacity-50 cursor-not-allowed" : "transition-colors"} ${action.style}`}
                          >
                            {action.label}
                          </button>
                        )}

                        {/* ── Add Payment
                             Rule: staff can only pay when guest is Checked In.
                             Admin can always pay but sees a warning if not checked in yet. */}
                        {due > 0 && b.status !== "Checked Out" && (() => {
                          const checkedIn = b.status === "Checked In";
                          if (!isAdmin && !checkedIn) {
                            // Staff: guest not yet checked in — show locked message
                            return (
                              <p className="text-[10.5px] text-slate-400 italic leading-tight">
                                Payment available<br/>after check-in
                              </p>
                            );
                          }
                          // Admin (any status) or Staff (checked-in only)
                          const warnAdmin = isAdmin && !checkedIn;
                          return (
                            <button
                              onClick={() => openPayModal(b)}
                              title={warnAdmin ? "Guest not yet checked in — verify before recording" : undefined}
                              className={`inline-flex items-center gap-1.5 text-[11.5px] font-semibold px-3 py-1.5 rounded-lg transition-colors whitespace-nowrap ${
                                warnAdmin
                                  ? "text-amber-700 bg-amber-50 border border-amber-200 hover:bg-amber-100"
                                  : "text-emerald-700 bg-emerald-50 border border-emerald-200 hover:bg-emerald-100"
                              }`}
                            >
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="w-3 h-3">
                                <path d="M12 5v14M5 12h14"/>
                              </svg>
                              Add Payment
                            </button>
                          );
                        })()}

                        {/* ── Documents ── */}
                        <button
                          onClick={() => openDocsModal(b)}
                          className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-400 hover:text-violet-600 transition-colors"
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-3 h-3 flex-shrink-0">
                            <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
                            <path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/>
                          </svg>
                          Documents
                        </button>

                        {/* ── Timeline ── */}
                        <button
                          onClick={() => setTimelineModal(b)}
                          className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-400 hover:text-amber-600 transition-colors"
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-3 h-3 flex-shrink-0">
                            <circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>
                          </svg>
                          Timeline
                        </button>

                        {/* ── Edit (pencil) — only for editable statuses ── */}
                        {(b.status === "Confirmed" || b.status === "Checked In") && (
                          <button
                            onClick={() => setEditTarget(b)}
                            className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-400 hover:text-violet-600 transition-colors"
                          >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3 h-3 flex-shrink-0">
                              <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
                              <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
                            </svg>
                            Edit
                          </button>
                        )}

                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {filteredBookings.length > 0 && (
          <div className="px-5 py-3 border-t border-slate-100 bg-slate-50 flex items-center justify-between gap-4 flex-wrap">
            {/* Left — count summary */}
            <p className="text-[12px] text-slate-400 shrink-0">
              Showing {(currentPage - 1) * PAGE_SIZE + 1}–{Math.min(currentPage * PAGE_SIZE, filteredBookings.length)} of {filteredBookings.length} booking{filteredBookings.length !== 1 ? "s" : ""}
            </p>

            {/* Right — page controls (hidden when only 1 page) */}
            {totalPages > 1 && (
              <div className="flex items-center gap-1">
                {/* Prev */}
                <button
                  onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                  disabled={currentPage === 1}
                  className="px-2.5 py-1.5 text-[12px] font-medium rounded-md border border-slate-200 text-slate-600
                    hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed transition"
                >
                  ← Prev
                </button>

                {/* Page number buttons with ellipsis for >7 pages */}
                {(() => {
                  const pages: (number | "…")[] = [];
                  if (totalPages <= 7) {
                    for (let i = 1; i <= totalPages; i++) pages.push(i);
                  } else {
                    pages.push(1);
                    if (currentPage > 3) pages.push("…");
                    for (let i = Math.max(2, currentPage - 1); i <= Math.min(totalPages - 1, currentPage + 1); i++)
                      pages.push(i);
                    if (currentPage < totalPages - 2) pages.push("…");
                    pages.push(totalPages);
                  }
                  return pages.map((p, i) =>
                    p === "…" ? (
                      <span key={`ellipsis-${i}`} className="px-1.5 text-[12px] text-slate-400 select-none">…</span>
                    ) : (
                      <button
                        key={p}
                        onClick={() => setCurrentPage(p as number)}
                        className={`min-w-[30px] px-2 py-1.5 text-[12px] font-medium rounded-md border transition
                          ${currentPage === p
                            ? "bg-amber-500 border-amber-500 text-white"
                            : "border-slate-200 text-slate-600 hover:bg-slate-100"}`}
                      >
                        {p}
                      </button>
                    )
                  );
                })()}

                {/* Next */}
                <button
                  onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                  disabled={currentPage === totalPages}
                  className="px-2.5 py-1.5 text-[12px] font-medium rounded-md border border-slate-200 text-slate-600
                    hover:bg-slate-100 disabled:opacity-40 disabled:cursor-not-allowed transition"
                >
                  Next →
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* close BOOKINGS VIEW wrapper */}
      </>
      )}

      {/* ══════════════════════════════════════════════════════
          OUTSTANDING DUES VIEW
          Summary stat cards → filter tabs → dues table
      ══════════════════════════════════════════════════════ */}
      {pageView === "dues" && (
        <>

          {/* ── Warning banner ─────────────────────────────────── */}
          {dueBookings.length > 0 && (
            <div className="flex items-center gap-3 bg-rose-50 border border-rose-200 rounded-xl px-5 py-3.5">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-5 h-5 text-rose-500 flex-shrink-0">
                <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
                <path d="M12 9v4M12 17h.01"/>
              </svg>
              <p className="text-[13px] font-medium text-rose-800">
                <span className="font-bold">{dueBookings.length} booking{dueBookings.length !== 1 ? "s" : ""}</span> have outstanding balances totalling{" "}
                <span className="font-bold">৳{totalOutstanding.toLocaleString()}</span>. Use "Add Payment" on each row to record payments received.
              </p>
            </div>
          )}

          {/* ── Summary stat cards ─────────────────────────────── */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">

            {/* Total Outstanding */}
            <div className="bg-white border border-rose-200 rounded-xl px-5 py-4 shadow-sm">
              <p className="text-[11px] font-semibold text-rose-400 uppercase tracking-wider mb-1.5">Total Outstanding</p>
              <p className="text-[26px] font-bold text-rose-600 leading-none">৳{totalOutstanding.toLocaleString()}</p>
              <p className="text-[11.5px] text-slate-400 mt-1.5">across {dueBookings.length} booking{dueBookings.length !== 1 ? "s" : ""}</p>
            </div>

            {/* Bookings with dues */}
            <div className="bg-white border border-slate-200 rounded-xl px-5 py-4 shadow-sm">
              <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-1.5">Bookings With Dues</p>
              <p className="text-[26px] font-bold text-slate-800 leading-none">{dueBookings.length}</p>
              <p className="text-[11.5px] text-slate-400 mt-1.5">of {bookings.length} total bookings</p>
            </div>

            {/* In-house with due */}
            <div className="bg-white border border-amber-200 rounded-xl px-5 py-4 shadow-sm">
              <p className="text-[11px] font-semibold text-amber-500 uppercase tracking-wider mb-1.5">In-House With Due</p>
              <p className="text-[26px] font-bold text-amber-600 leading-none">{dueInHouseCount}</p>
              <p className="text-[11.5px] text-slate-400 mt-1.5">Confirmed or Checked In</p>
            </div>

            {/* Checked-out with due */}
            <div className="bg-white border border-rose-200 rounded-xl px-5 py-4 shadow-sm">
              <p className="text-[11px] font-semibold text-rose-400 uppercase tracking-wider mb-1.5">Checked-out With Due</p>
              <p className="text-[26px] font-bold text-rose-600 leading-none">{dueCheckedOutCount}</p>
              <p className="text-[11.5px] text-slate-400 mt-1.5">
                {dueOverrideCount > 0
                  ? `${dueOverrideCount} via admin override`
                  : "no overrides used"}
              </p>
            </div>
          </div>

          {/* ── Filter tabs ────────────────────────────────────── */}
          <div className="flex items-center gap-1 bg-white border border-slate-200 rounded-xl p-1 w-fit shadow-sm">
            {([
              { key: "all"        as const, label: "All Due",              count: dueBookings.length     },
              { key: "inhouse"    as const, label: "In-House With Due",    count: dueInHouseCount        },
              { key: "checkedout" as const, label: "Checked-out With Due", count: dueCheckedOutCount     },
            ]).map(f => (
              <button
                key={f.key}
                onClick={() => setDueFilter(f.key)}
                className={`flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-[13px] font-medium transition-colors ${
                  dueFilter === f.key
                    ? "bg-slate-900 text-white shadow-sm"
                    : "text-slate-500 hover:text-slate-700 hover:bg-slate-50"
                }`}
              >
                {f.label}
                <span className={`text-[11px] font-bold px-1.5 py-0.5 rounded-full ${
                  dueFilter === f.key ? "bg-white/20 text-white" : "bg-slate-100 text-slate-500"
                }`}>
                  {f.count}
                </span>
              </button>
            ))}
          </div>

          {/* ── Outstanding Dues Table ─────────────────────────── */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="bg-rose-50 border-b border-rose-100">
                    {["ID", "Primary Guest", "Room", "Check-in", "Check-out", "Booking Status", "Total", "Paid", "Method", "Due", "Payment", "Override", "Action"].map(h => (
                      <th key={h} className="text-left px-5 py-3 text-[11px] font-semibold text-rose-400 uppercase tracking-wider whitespace-nowrap">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredDueBookings.length === 0 ? (
                    <tr>
                      <td colSpan={13} className="px-5 py-14 text-center">
                        <div className="flex flex-col items-center gap-2">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="w-10 h-10 text-slate-200">
                            <path d="M9 12l2 2 4-4M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
                          </svg>
                          <p className="text-[14px] font-semibold text-slate-400">All clear!</p>
                          <p className="text-[12.5px] text-slate-300">No outstanding dues match this filter.</p>
                        </div>
                      </td>
                    </tr>
                  ) : filteredDueBookings.map(b => {
                    const due       = calcTrueDue(b);
                    const isHighDue = due >= HIGH_DUE_THRESHOLD;
                    return (
                      <tr
                        key={b.id}
                        className={`transition-colors ${
                          isHighDue
                            ? "bg-rose-50/50 hover:bg-rose-50/80"
                            : "hover:bg-slate-50/70"
                        }`}
                      >

                        {/* ID */}
                        <td className="px-5 py-3.5">
                          <span className="font-mono text-[11.5px] text-slate-400">{b.id}</span>
                        </td>

                        {/* Primary Guest */}
                        <td className="px-5 py-3.5">
                          <div className="flex items-center gap-2.5">
                            <div className={`w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 text-[10px] font-bold ${avatarColor(b.guestName)}`}>
                              {initials(b.guestName)}
                            </div>
                            <div>
                              <p className="font-semibold text-slate-800 whitespace-nowrap">{b.guestName}</p>
                              {b.phone && b.phone !== "—" && (
                                <p className="text-[11px] text-slate-400">{b.phone}</p>
                              )}
                            </div>
                          </div>
                        </td>

                        {/* Room */}
                        <td className="px-5 py-3.5">
                          <p className="font-semibold text-slate-800">Room {b.roomNumber}</p>
                          <p className="text-[11px] text-slate-400">{b.roomCategory}</p>
                        </td>

                        {/* Dates */}
                        <td className="px-5 py-3.5 text-slate-600 whitespace-nowrap">{b.checkIn}</td>
                        <td className="px-5 py-3.5 text-slate-600 whitespace-nowrap">{b.checkOut}</td>

                        {/* Booking Status + override warning badge */}
                        <td className="px-5 py-3.5">
                          <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-[11.5px] font-semibold whitespace-nowrap ${statusBadge(b.status)}`}>
                            {b.status}
                          </span>
                          {b.checkoutOverride?.used && (
                            <div
                              className="mt-1.5 inline-flex items-center gap-1 text-[10.5px] font-semibold text-amber-700 bg-amber-50 border border-amber-300 px-2 py-0.5 rounded-full cursor-default"
                              title={`Admin override · Reason: ${b.checkoutOverride.reason}`}
                            >
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="w-3 h-3 flex-shrink-0">
                                <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
                                <path d="M12 9v4M12 17h.01"/>
                              </svg>
                              Due at checkout
                            </div>
                          )}
                        </td>

                        {/* Total */}
                        <td className="px-5 py-3.5 font-semibold text-slate-800 whitespace-nowrap">
                          ৳{b.totalAmount.toLocaleString()}
                        </td>

                        {/* Paid */}
                        <td className="px-5 py-3.5 whitespace-nowrap">
                          <span className={`font-semibold ${b.amountPaid > 0 ? "text-emerald-700" : "text-slate-400"}`}>
                            {b.amountPaid > 0 ? `৳${b.amountPaid.toLocaleString()}` : "—"}
                          </span>
                        </td>

                        {/* Last Payment Method */}
                        <td className="px-5 py-3.5 whitespace-nowrap">
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-slate-100 text-slate-600">
                            {formatPaymentMethod(b.lastPaymentMethod)}
                          </span>
                        </td>

                        {/* Due — flame icon when ≥ HIGH_DUE_THRESHOLD */}
                        <td className="px-5 py-3.5 whitespace-nowrap">
                          <div className="flex items-center gap-1">
                            {isHighDue && (
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-3.5 h-3.5 text-rose-500 flex-shrink-0">
                                <path d="M8.5 14.5A2.5 2.5 0 0011 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 11-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 002.5 3z"/>
                              </svg>
                            )}
                            <span className={`font-bold ${isHighDue ? "text-rose-600 text-[14px]" : "text-rose-500"}`}>
                              ৳{due.toLocaleString()}
                            </span>
                          </div>
                        </td>

                        {/* Payment Status */}
                        <td className="px-5 py-3.5">
                          <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11.5px] font-semibold whitespace-nowrap ${paymentBadge(b.payment)}`}>
                            <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${paymentDot(b.payment)}`} />
                            {b.payment}
                          </span>
                        </td>

                        {/* Override indicator */}
                        <td className="px-5 py-3.5">
                          {b.checkoutOverride?.used ? (
                            <div
                              className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-amber-700 bg-amber-50 border border-amber-200 px-2.5 py-1 rounded-lg cursor-default whitespace-nowrap"
                              title={`By: ${b.checkoutOverride.by} · ${b.checkoutOverride.reason}`}
                            >
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="w-3 h-3 flex-shrink-0">
                                <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
                                <path d="M12 9v4M12 17h.01"/>
                              </svg>
                              Admin Override
                            </div>
                          ) : (
                            <span className="text-slate-300 text-[12px]">—</span>
                          )}
                        </td>

                        {/* Add Payment — same rule as booking row: staff only when Checked In */}
                        <td className="px-5 py-3.5">
                          {(() => {
                            const checkedIn = b.status === "Checked In";
                            if (!isAdmin && !checkedIn) {
                              return (
                                <p className="text-[10.5px] text-slate-400 italic leading-tight">
                                  Payment after<br/>check-in
                                </p>
                              );
                            }
                            const warnAdmin = isAdmin && !checkedIn;
                            return (
                              <button
                                onClick={() => openPayModal(b)}
                                title={warnAdmin ? "Guest not yet checked in — verify before recording" : undefined}
                                className={`inline-flex items-center gap-1.5 text-[11.5px] font-semibold px-3 py-1.5 rounded-lg transition-colors whitespace-nowrap ${
                                  warnAdmin
                                    ? "text-amber-700 bg-amber-50 border border-amber-200 hover:bg-amber-100"
                                    : "text-emerald-700 bg-emerald-50 border border-emerald-200 hover:bg-emerald-100"
                                }`}
                              >
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="w-3 h-3">
                                  <path d="M12 5v14M5 12h14"/>
                                </svg>
                                Add Payment
                              </button>
                            );
                          })()}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Table footer */}
            <div className="px-5 py-3 border-t border-slate-100 bg-rose-50/30 flex items-center justify-between">
              <p className="text-[12px] text-slate-400">
                Showing {filteredDueBookings.length} of {dueBookings.length} bookings with outstanding dues
              </p>
              <p className="text-[12px] font-semibold text-rose-600">
                ৳{filteredDueBookings.reduce((s, b) => s + calcTrueDue(b), 0).toLocaleString()} outstanding in this view
              </p>
            </div>
          </div>

        </>
      )}

      {/* ══════════════════════════════════════════════════════
          CHECKOUT CONFIRMATION MODAL
          Shown for EVERY checkout — no checkout can happen without
          the operator reviewing the full billing summary.
          • Shows: guest info, dates, billing summary (total/paid/due)
          • Additional charge field for damage / extras
          • Final payable = original due + additional charges
          • If finalPayable = 0: "Confirm Check-out" button
          • If finalPayable > 0: warning + admin override section
      ══════════════════════════════════════════════════════ */}
      {checkoutConfirm && (() => {
        const extraChargeAmt     = parseFloat(chargeAmount) || 0;
        const moreDiscountAmtNum = parseFloat(moreDiscountAmt) || 0;
        const { earlyDays, earlyAmt: earlyDeductionAmt } = calcEarlyDeduction(
          checkoutConfirm.checkOut,
          checkoutConfirm.bookingRate,
          checkoutConfirm.totalAmount,
          checkoutConfirm.nights,
          checkoutOpenedAt ?? new Date(),
        );
        const finalTotal   = checkoutConfirm.totalAmount + extraChargeAmt;
        const finalPayable = finalTotal - earlyDeductionAmt - moreDiscountAmtNum - liveAmountPaid;
        const payStatus    = derivePaymentStatus(checkoutConfirm.totalAmount, liveAmountPaid);
        return (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
            onClick={e => { if (e.target === e.currentTarget) closeCheckoutConfirm(); }}
          >
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden max-h-[90vh] flex flex-col">

              {/* ── Modal header ───────────────────────────────── */}
              <div className={`flex items-center justify-between px-6 py-4 border-b flex-shrink-0 ${
                finalPayable > 0 ? "bg-amber-50 border-amber-200" : "bg-slate-50 border-slate-200"
              }`}>
                <div className="flex items-center gap-2.5">
                  <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${
                    finalPayable > 0 ? "bg-amber-500" : "bg-slate-700"
                  }`}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-4 h-4 text-white">
                      <path d="M19 12H5M12 5l7 7-7 7"/>
                    </svg>
                  </div>
                  <div>
                    <h2 className={`text-[14px] font-bold leading-none ${finalPayable > 0 ? "text-amber-900" : "text-slate-800"}`}>
                      Confirm Check-out
                    </h2>
                    <p className={`text-[11.5px] mt-0.5 font-mono ${finalPayable > 0 ? "text-amber-700" : "text-slate-400"}`}>
                      {checkoutConfirm.id}
                    </p>
                  </div>
                </div>
                <button onClick={closeCheckoutConfirm} className={`p-1.5 rounded-lg transition-colors ${
                  finalPayable > 0 ? "text-amber-500 hover:text-amber-800 hover:bg-amber-100" : "text-slate-400 hover:text-slate-700 hover:bg-slate-100"
                }`}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-4 h-4">
                    <path d="M18 6L6 18M6 6l12 12"/>
                  </svg>
                </button>
              </div>

              {/* ── Scrollable body ─────────────────────────────── */}
              <div className="px-6 py-5 overflow-y-auto flex-1 space-y-5">

                {/* Guest info */}
                <div className="flex items-start gap-3">
                  <div className={`w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 text-[11px] font-bold mt-0.5 ${avatarColor(checkoutConfirm.guestName)}`}>
                    {initials(checkoutConfirm.guestName)}
                  </div>
                  <div>
                    <p className="text-[13.5px] font-semibold text-slate-800">{checkoutConfirm.guestName}</p>
                    <p className="text-[12px] text-slate-500">Room {checkoutConfirm.roomNumber} · {checkoutConfirm.roomCategory} · {checkoutConfirm.nights} nt</p>
                    <p className="text-[12px] text-slate-400">{checkoutConfirm.checkIn} → {checkoutConfirm.checkOut}</p>
                  </div>
                  <span className={`ml-auto flex-shrink-0 text-[11.5px] font-semibold px-2.5 py-0.5 rounded-full ${statusBadge(checkoutConfirm.status)}`}>
                    {checkoutConfirm.status}
                  </span>
                </div>

                {/* ── STAY TIMING ──────────────────────────────────── */}
                {(() => {
                  const t = calcCheckoutTiming(checkoutConfirm.checkOut, checkoutOpenedAt ?? new Date());
                  const isEarly  = t.status === "early";
                  const isOnTime = t.status === "on_time";
                  const isLate   = t.status === "late";
                  return (
                    <div>
                      <p className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-2">Stay Timing</p>
                      <div className="bg-slate-50 border border-slate-200 rounded-xl overflow-hidden">
                        <div className="divide-y divide-slate-100">
                          <div className="flex items-center justify-between px-4 py-2">
                            <span className="text-[12.5px] text-slate-500">Check-in</span>
                            <span className="text-[12.5px] font-medium text-slate-700">{checkoutConfirm.checkIn} · 12:00 PM</span>
                          </div>
                          <div className="flex items-center justify-between px-4 py-2">
                            <span className="text-[12.5px] text-slate-500">Scheduled checkout</span>
                            <span className="text-[12.5px] font-medium text-slate-700">{checkoutConfirm.checkOut} · 11:59 AM</span>
                          </div>
                          <div className="flex items-center justify-between px-4 py-2">
                            <span className="text-[12.5px] text-slate-500">Grace period until</span>
                            <span className="text-[12.5px] text-slate-500">{fmtTime(t.graceDeadlineAt)}</span>
                          </div>
                          <div className="flex items-center justify-between px-4 py-2">
                            <span className="text-[12.5px] text-slate-500">Actual checkout</span>
                            <span className="text-[12.5px] font-semibold text-slate-800">
                              {fmtShortDate(t.actualAt)} · {fmtTime(t.actualAt)}
                            </span>
                          </div>
                        </div>
                        <div className={`flex items-center justify-between px-4 py-2.5 border-t ${
                          isEarly  ? "bg-emerald-50 border-emerald-100" :
                          isOnTime ? "bg-sky-50 border-sky-100" :
                                     "bg-amber-50 border-amber-100"
                        }`}>
                          <span className={`text-[12.5px] font-semibold flex items-center gap-1.5 ${
                            isEarly  ? "text-emerald-700" :
                            isOnTime ? "text-sky-700" :
                                       "text-amber-700"
                          }`}>
                            {isEarly  && <><span>✓</span> Early checkout</>}
                            {isOnTime && <><span>✓</span> On time <span className="font-normal text-[11.5px]">(within grace)</span></>}
                            {isLate   && <><span>⚠</span> Late checkout</>}
                          </span>
                          <span className={`text-[12px] ${
                            isEarly  ? "text-emerald-600" :
                            isOnTime ? "text-sky-600" :
                                       "text-amber-600"
                          }`}>
                            {t.minutesDiff > 0 && `+${t.minutesDiff} min past checkout`}
                            {t.minutesDiff < 0 && `${Math.abs(t.minutesDiff)} min early`}
                            {t.minutesDiff === 0 && "Exactly on time"}
                          </span>
                        </div>
                      </div>
                      <p className="mt-1.5 px-0.5 text-[11px] text-slate-400">
                        Planned: <span className="font-semibold text-slate-600">{checkoutConfirm.nights} night{checkoutConfirm.nights !== 1 ? "s" : ""}</span>
                        {" · "}Grace: <span className="font-semibold text-slate-600">30 min</span>
                        {" · "}Late-checkout fees not yet applied.
                      </p>
                    </div>
                  );
                })()}

                {/* ── BILLING SUMMARY ─────────────────────────────── */}
                <div>
                  <p className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-2">Billing Summary</p>
                  <div className="bg-slate-50 border border-slate-200 rounded-xl overflow-hidden">
                    <div className="divide-y divide-slate-100">
                      <div className="flex items-center justify-between px-4 py-2.5">
                        <span className="text-[13px] text-slate-600">Total Amount</span>
                        <span className="text-[13.5px] font-semibold text-slate-800">৳{checkoutConfirm.totalAmount.toLocaleString()}</span>
                      </div>
                      {extraChargeAmt > 0 && (
                        <div className="flex items-center justify-between px-4 py-2.5 bg-amber-50/50">
                          <span className="text-[13px] text-amber-700">Extra Charges</span>
                          <span className="text-[13.5px] font-semibold text-amber-700">+৳{extraChargeAmt.toLocaleString()}</span>
                        </div>
                      )}
                      {earlyDeductionAmt > 0 && (
                        <div className="flex items-center justify-between px-4 py-2.5 bg-emerald-50/50">
                          <span className="text-[13px] text-emerald-700">
                            Early Checkout
                            <span className="ml-1.5 text-[11.5px] font-normal text-emerald-600">
                              ({earlyDays} night{earlyDays !== 1 ? "s" : ""} deducted)
                            </span>
                          </span>
                          <span className="text-[13.5px] font-semibold text-emerald-700">−৳{earlyDeductionAmt.toLocaleString()}</span>
                        </div>
                      )}
                      {moreDiscountAmtNum > 0 && (
                        <div className="flex items-center justify-between px-4 py-2.5 bg-violet-50/50">
                          <span className="text-[13px] text-violet-700">Additional Discount</span>
                          <span className="text-[13.5px] font-semibold text-violet-700">−৳{moreDiscountAmtNum.toLocaleString()}</span>
                        </div>
                      )}
                      <div className="flex items-center justify-between px-4 py-2.5">
                        <span className="text-[13px] text-slate-600">Amount Paid</span>
                        <span className={`text-[13.5px] font-semibold ${liveAmountPaid > 0 ? "text-emerald-700" : "text-slate-400"}`}>
                          {liveAmountPaid > 0 ? `৳${liveAmountPaid.toLocaleString()}` : "—"}
                        </span>
                      </div>
                      <div className="flex items-center justify-between px-4 py-3 bg-slate-100/60">
                        <span className="text-[13px] font-bold text-slate-700">Final Payable</span>
                        <span className={`text-[16px] font-bold ${finalPayable > 0 ? "text-rose-600" : "text-emerald-600"}`}>
                          {finalPayable > 0 ? `৳${finalPayable.toLocaleString()}` : "৳0 — Settled ✓"}
                        </span>
                      </div>
                    </div>
                  </div>
                  {/* Payment status badge */}
                  <div className="flex items-center gap-1.5 mt-2 px-1">
                    <span className={`inline-flex items-center gap-1.5 text-[12px] font-semibold px-2.5 py-0.5 rounded-full ${paymentBadge(payStatus)}`}>
                      <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${paymentDot(payStatus)}`}/>
                      {payStatus}
                    </span>
                    <span className="text-[11.5px] text-slate-400">payment status</span>
                  </div>
                </div>

                {/* ── EXTRA CHARGES ───────────────────────────────── */}
                <div>
                  <p className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-2">
                    Additional Charges
                    <span className="ml-1.5 font-normal normal-case text-slate-400 text-[11px]">optional — damage, mini-bar, etc.</span>
                  </p>
                  <div className="space-y-3">
                    {/* Charge type dropdown */}
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-[11.5px] font-semibold text-slate-500 mb-1 uppercase tracking-wide">Charge Type</label>
                        <select
                          value={chargeType}
                          onChange={e => { setChargeType(e.target.value); setChargeError(""); }}
                          className="w-full px-3 py-2.5 text-[13px] text-slate-800 bg-white border border-slate-200 rounded-lg
                            focus:outline-none focus:ring-2 focus:ring-amber-400 focus:border-transparent transition appearance-none cursor-pointer"
                        >
                          <option value="">— Select type —</option>
                          {CHARGE_TYPES.map(t => (
                            <option key={t} value={t}>{t}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="block text-[11.5px] font-semibold text-slate-500 mb-1 uppercase tracking-wide">Amount (BDT)</label>
                        <div className="relative">
                          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 font-semibold pointer-events-none text-[13px]">৳</span>
                          <input
                            type="number"
                            min={0}
                            step="0.01"
                            placeholder="0.00"
                            value={chargeAmount}
                            onChange={e => { setChargeAmount(e.target.value); setChargeError(""); }}
                            onWheel={e => (e.target as HTMLInputElement).blur()}
                            disabled={!chargeType}
                            className="w-full pl-6 pr-3 py-2.5 text-[13px] text-slate-800 bg-white border border-slate-200 rounded-lg
                              placeholder:text-slate-300 focus:outline-none focus:ring-2 focus:ring-amber-400 focus:border-transparent transition
                              disabled:bg-slate-50 disabled:cursor-not-allowed
                              [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                          />
                        </div>
                      </div>
                    </div>
                    {/* Description / note */}
                    <div>
                      <label className="block text-[11.5px] font-semibold text-slate-500 mb-1 uppercase tracking-wide">
                        Description
                        {chargeType === "Other" && <span className="ml-1 text-rose-500">*</span>}
                        {chargeType && chargeType !== "Other" && <span className="ml-1 font-normal normal-case text-slate-400">(optional)</span>}
                      </label>
                      <input
                        type="text"
                        placeholder={
                          chargeType === "Mini-bar" ? "e.g. 3 soft drinks, 1 beer"
                          : chargeType === "Room damage" ? "e.g. Broken lamp"
                          : chargeType === "Other" ? "Required — describe the charge"
                          : "Optional note"
                        }
                        value={chargeNote}
                        onChange={e => { setChargeNote(e.target.value); setChargeError(""); }}
                        disabled={!chargeType}
                        className="w-full px-3.5 py-2.5 text-[13px] text-slate-800 bg-white border border-slate-200 rounded-lg
                          placeholder:text-slate-300 focus:outline-none focus:ring-2 focus:ring-amber-400 focus:border-transparent transition
                          disabled:bg-slate-50 disabled:cursor-not-allowed"
                      />
                    </div>
                    {chargeError && (
                      <p className="text-[11.5px] text-rose-600 flex items-center gap-1.5">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-3.5 h-3.5 flex-shrink-0">
                          <circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>
                        </svg>
                        {chargeError}
                      </p>
                    )}
                    {/* Formatted preview */}
                    {chargeType && parseFloat(chargeAmount) > 0 && (
                      <div className="flex items-center gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3.5 py-2.5">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-3.5 h-3.5 text-amber-600 flex-shrink-0">
                          <path d="M9 12l2 2 4-4M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
                        </svg>
                        <span className="text-[12px] text-amber-800 font-medium">
                          {formatChargeReason(chargeType, chargeNote) ?? chargeType} — ৳{parseFloat(chargeAmount).toLocaleString()}
                        </span>
                      </div>
                    )}
                  </div>
                </div>

                {/* ── MORE DISCOUNT ───────────────────────────────── */}
                <div>
                  <p className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-2">
                    More Discount
                    <span className="ml-1.5 font-normal normal-case text-slate-400 text-[11px]">optional — e.g. loyalty, manager approval</span>
                  </p>
                  <div className="space-y-3">
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-[11.5px] font-semibold text-slate-500 mb-1 uppercase tracking-wide">Amount (BDT)</label>
                        <div className="relative">
                          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 font-semibold pointer-events-none text-[13px]">৳</span>
                          <input
                            type="number"
                            min={0}
                            step="0.01"
                            placeholder="0.00"
                            value={moreDiscountAmt}
                            onChange={e => { setMoreDiscountAmt(e.target.value); setDiscountError(""); }}
                            onWheel={e => (e.target as HTMLInputElement).blur()}
                            className="w-full pl-6 pr-3 py-2.5 text-[13px] text-slate-800 bg-white border border-slate-200 rounded-lg
                              placeholder:text-slate-300 focus:outline-none focus:ring-2 focus:ring-violet-400 focus:border-transparent transition
                              [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                          />
                        </div>
                      </div>
                      <div>
                        <label className="block text-[11.5px] font-semibold text-slate-500 mb-1 uppercase tracking-wide">
                          Reason <span className="ml-1 font-normal normal-case text-slate-400">(optional)</span>
                        </label>
                        <input
                          type="text"
                          placeholder="e.g. Loyalty discount"
                          value={moreDiscountReason}
                          onChange={e => { setMoreDiscountReason(e.target.value); setDiscountError(""); }}
                          className="w-full px-3.5 py-2.5 text-[13px] text-slate-800 bg-white border border-slate-200 rounded-lg
                            placeholder:text-slate-300 focus:outline-none focus:ring-2 focus:ring-violet-400 focus:border-transparent transition"
                        />
                      </div>
                    </div>
                    {discountError && (
                      <p className="text-[11.5px] text-rose-600 flex items-center gap-1.5">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-3.5 h-3.5 flex-shrink-0">
                          <circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>
                        </svg>
                        {discountError}
                      </p>
                    )}
                    {parseFloat(moreDiscountAmt) > 0 && (
                      <div className="flex items-center gap-2 bg-violet-50 border border-violet-200 rounded-lg px-3.5 py-2.5">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-3.5 h-3.5 text-violet-600 flex-shrink-0">
                          <path d="M9 12l2 2 4-4M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
                        </svg>
                        <span className="text-[12px] text-violet-800 font-medium">
                          Discount of ৳{parseFloat(moreDiscountAmt).toLocaleString()} will be applied
                          {moreDiscountReason.trim() && ` — ${moreDiscountReason.trim()}`}
                        </span>
                      </div>
                    )}
                  </div>
                </div>

                {/* ── ADD PAYMENT ─────────────────────────────────── */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">Add Payment</p>
                    <button
                      type="button"
                      onClick={() => { setShowModalPay(v => !v); setModalPayAmt(""); setModalPayError(""); }}
                      className={`text-[12px] font-semibold px-3 py-1 rounded-lg border transition-colors ${
                        showModalPay
                          ? "bg-slate-100 text-slate-600 border-slate-200 hover:bg-slate-200"
                          : "bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100"
                      }`}
                    >
                      {showModalPay ? "Cancel" : "+ Add Payment"}
                    </button>
                  </div>
                  {showModalPay && (
                    <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-4 space-y-3">
                      <p className="text-[12px] text-emerald-700 font-medium">
                        Collect payment from guest and record it here to update the balance instantly.
                      </p>
                      <div>
                        <label
                          htmlFor="checkoutPayMethod"
                          className="block text-[11.5px] font-semibold text-slate-500 mb-1 uppercase tracking-wide"
                        >
                          Payment Method
                        </label>
                        <select
                          id="checkoutPayMethod"
                          value={checkoutPayMethod}
                          onChange={e => setCheckoutPayMethod(e.target.value as PaymentMethod)}
                          className="w-full px-3.5 py-2.5 text-[13.5px] text-slate-800 bg-white border border-emerald-200 rounded-lg
                            focus:outline-none focus:ring-2 focus:ring-emerald-400 focus:border-transparent transition"
                        >
                          {PAYMENT_METHODS.map(m => (
                            <option key={m} value={m}>{PAYMENT_METHOD_LABELS[m]}</option>
                          ))}
                        </select>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="relative flex-1">
                          <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 font-semibold pointer-events-none">৳</span>
                          <input
                            type="number"
                            min={0.01}
                            step="0.01"
                            placeholder="0.00"
                            value={modalPayAmt}
                            onChange={e => { setModalPayAmt(e.target.value); setModalPayError(""); }}
                            onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); handleModalPayment(); } }}
                            onWheel={e => (e.target as HTMLInputElement).blur()}
                            className="w-full pl-7 pr-3.5 py-2.5 text-[13.5px] text-slate-800 bg-white border border-emerald-200 rounded-lg
                              placeholder:text-slate-300 focus:outline-none focus:ring-2 focus:ring-emerald-400 focus:border-transparent transition
                              [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                            autoFocus
                          />
                        </div>
                        <button
                          type="button"
                          onClick={handleModalPayment}
                          className="flex items-center gap-1.5 px-4 py-2.5 text-[13px] font-semibold text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg transition-colors shadow-sm whitespace-nowrap"
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="w-3.5 h-3.5">
                            <path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><path d="M22 4L12 14.01l-3-3"/>
                          </svg>
                          Record
                        </button>
                      </div>
                      {modalPayError && (
                        <p className="text-[11.5px] text-rose-600">{modalPayError}</p>
                      )}
                      {finalPayable > 0 && (
                        <p className="text-[11.5px] text-emerald-700">
                          Max: <span className="font-bold">৳{finalPayable.toLocaleString()}</span> outstanding
                        </p>
                      )}
                    </div>
                  )}
                </div>

                {/* ── OUTSTANDING BALANCE WARNING + ADMIN OVERRIDE ── */}
                {finalPayable > 0 && (
                  <div>
                    <div className="bg-rose-50 border border-rose-200 rounded-lg px-4 py-3 mb-4 flex items-start gap-2">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-4 h-4 text-rose-500 flex-shrink-0 mt-0.5">
                        <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
                        <path d="M12 9v4M12 17h.01"/>
                      </svg>
                      <div>
                        <p className="text-[12.5px] font-semibold text-rose-800 leading-snug">Outstanding balance blocks checkout.</p>
                        <p className="text-[12px] text-rose-600 mt-0.5">
                          Collect <span className="font-bold">৳{finalPayable.toLocaleString()}</span> before checkout, or use Admin Override to proceed with reason.
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 mb-3">
                      <span className="text-[12px] text-slate-500">Signed in as:</span>
                      <span className={`text-[12px] font-bold px-2.5 py-0.5 rounded-full capitalize ${
                        isAdmin ? "bg-amber-100 text-amber-800 border border-amber-300" : "bg-slate-100 text-slate-600 border border-slate-200"
                      }`}>
                        {role ?? "staff"}
                      </span>
                    </div>

                    <form onSubmit={handleAdminOverride}>
                      <label className="block text-[12px] font-semibold text-slate-600 mb-1.5 uppercase tracking-wide">
                        Override Reason
                        <span className="ml-1 font-normal normal-case text-slate-400">(required for audit log)</span>
                      </label>
                      <textarea
                        rows={2}
                        placeholder={isAdmin
                          ? "e.g. Guest settling via bank transfer, confirmed by manager."
                          : "Only admins can enter a reason and override checkout."}
                        value={overrideReason}
                        onChange={e => { setOverrideReason(e.target.value); setOverrideError(""); }}
                        disabled={!isAdmin}
                        className={`w-full px-3.5 py-2.5 text-[13px] text-slate-800 bg-white border rounded-lg resize-none mb-3
                          placeholder:text-slate-300 focus:outline-none focus:ring-2 focus:ring-amber-400 focus:border-transparent transition
                          ${!isAdmin ? "bg-slate-50 cursor-not-allowed text-slate-400" : "border-slate-200"}`}
                      />
                      {overrideError && <p className="mb-3 text-[11.5px] text-rose-600">{overrideError}</p>}
                      <div className="flex items-center justify-end gap-3">
                        <button type="button" onClick={closeCheckoutConfirm}
                          className="px-4 py-2.5 text-[13px] font-medium text-slate-600 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg transition-colors">
                          Cancel
                        </button>
                        <button type="submit" disabled={!isAdmin}
                          className={`flex items-center gap-2 px-5 py-2.5 text-[13px] font-semibold rounded-lg transition-colors shadow-sm ${
                            isAdmin ? "text-white bg-amber-500 hover:bg-amber-600" : "text-slate-400 bg-slate-100 border border-slate-200 cursor-not-allowed"
                          }`}>
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-4 h-4">
                            <rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/>
                          </svg>
                          Admin Override Checkout
                        </button>
                      </div>
                    </form>
                  </div>
                )}

                {/* ── CONFIRM CHECKOUT ────────────────────────────── */}
                {finalPayable <= 0 && (
                  <div className="flex items-center justify-end gap-3 pt-1">
                    <button type="button" onClick={closeCheckoutConfirm}
                      className="px-4 py-2.5 text-[13px] font-medium text-slate-600 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg transition-colors">
                      Cancel
                    </button>
                    <button type="button" onClick={handleConfirmCheckout}
                      className="flex items-center gap-2 px-5 py-2.5 text-[13px] font-semibold text-white bg-slate-800 hover:bg-slate-900 rounded-lg transition-colors shadow-sm">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-4 h-4">
                        <path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><path d="M22 4L12 14.01l-3-3"/>
                      </svg>
                      Confirm Check-out
                    </button>
                  </div>
                )}

              </div>
            </div>
          </div>
        );
      })()}

      {/* ══════════════════════════════════════════════════════
          GUEST DOCUMENTS MODAL
          Opens from "Documents" button in every booking row.
          • Fetches documents for that booking on open.
          • Allows uploading new documents (image/PDF).
          • Admin can delete documents.
      ══════════════════════════════════════════════════════ */}
      {docsModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
          onClick={e => { if (e.target === e.currentTarget) closeDocsModal(); }}
        >
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-xl overflow-hidden max-h-[90vh] flex flex-col">

            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 bg-slate-50 flex-shrink-0">
              <div className="flex items-center gap-2.5">
                <div className="w-7 h-7 rounded-lg bg-violet-600 flex items-center justify-center flex-shrink-0">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-3.5 h-3.5 text-white">
                    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
                    <path d="M14 2v6h6"/>
                  </svg>
                </div>
                <div>
                  <h2 className="text-[14px] font-semibold text-slate-800 leading-none">Guest Documents</h2>
                  <p className="text-[11.5px] text-slate-400 mt-0.5">
                    {docsModal.guestName} · <span className="font-mono">{docsModal.id}</span>
                  </p>
                </div>
              </div>
              <button onClick={closeDocsModal} className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-200 rounded-lg transition-colors">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-4 h-4">
                  <path d="M18 6L6 18M6 6l12 12"/>
                </svg>
              </button>
            </div>

            {/* Scrollable body */}
            <div className="overflow-y-auto flex-1 px-6 py-5 space-y-6">

              {/* ── Document list ───────────────────────────────── */}
              <div>
                <p className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-3">
                  Uploaded Documents
                  {docsList.length > 0 && (
                    <span className="ml-2 text-violet-700 bg-violet-50 border border-violet-200 px-2 py-0.5 rounded-full font-bold text-[10.5px]">
                      {docsList.length}
                    </span>
                  )}
                </p>

                {docsLoading && (
                  <div className="flex items-center gap-2 py-6 justify-center">
                    <svg className="w-4 h-4 text-slate-400 animate-spin" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
                    </svg>
                    <p className="text-[13px] text-slate-400">Loading documents…</p>
                  </div>
                )}

                {!docsLoading && docsError && (
                  <div className="bg-rose-50 border border-rose-200 rounded-lg px-4 py-3 space-y-2">
                    <div className="flex items-start gap-2">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-4 h-4 text-rose-500 flex-shrink-0 mt-0.5">
                        <circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>
                      </svg>
                      <p className="text-[12.5px] text-rose-700 leading-snug">{docsError}</p>
                    </div>
                    <button
                      onClick={() => docsModal && openDocsModal(docsModal)}
                      className="text-[11.5px] font-semibold text-rose-600 hover:text-rose-800 hover:underline ml-6"
                    >
                      Retry
                    </button>
                  </div>
                )}

                {!docsLoading && !docsError && docsList.length === 0 && (
                  <div className="flex flex-col items-center py-8 text-center">
                    <div className="w-10 h-10 rounded-full bg-slate-100 flex items-center justify-center mb-2">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="w-5 h-5 text-slate-300">
                        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
                        <path d="M14 2v6h6"/>
                      </svg>
                    </div>
                    <p className="text-[13px] text-slate-400">No documents uploaded yet.</p>
                    <p className="text-[12px] text-slate-300 mt-0.5">Use the form below to add the first document.</p>
                  </div>
                )}

                {!docsLoading && docsList.length > 0 && (
                  <div className="space-y-2">
                    {docsList.map(doc => {
                      const isImage = doc.fileType.startsWith("image/");
                      return (
                        <div key={doc.id} className="flex items-start gap-3 bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 group">
                          {/* File type icon */}
                          <div className="w-8 h-8 rounded-lg bg-white border border-slate-200 flex items-center justify-center flex-shrink-0 mt-0.5">
                            {isImage ? (
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" className="w-4 h-4 text-violet-500">
                                <rect x="3" y="3" width="18" height="18" rx="2"/>
                                <circle cx="8.5" cy="8.5" r="1.5"/>
                                <path d="M21 15l-5-5L5 21"/>
                              </svg>
                            ) : (
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" className="w-4 h-4 text-rose-500">
                                <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
                                <path d="M14 2v6h6M9 13h6M9 17h6"/>
                              </svg>
                            )}
                          </div>
                          {/* Info */}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-[11px] font-bold text-violet-700 bg-violet-50 border border-violet-200 px-2 py-0.5 rounded-full">
                                {doc.documentType}
                              </span>
                              <p className="text-[12.5px] font-medium text-slate-700 truncate max-w-[200px]">
                                {doc.fileName}
                              </p>
                            </div>
                            {doc.note && (
                              <p className="text-[11.5px] text-slate-500 mt-0.5 truncate">{doc.note}</p>
                            )}
                            <p className="text-[10.5px] text-slate-400 mt-0.5">
                              {new Date(doc.createdAt).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })}
                            </p>
                          </div>
                          {/* Actions */}
                          <div className="flex items-center gap-1.5 flex-shrink-0">
                            <a
                              href={doc.fileUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-[11px] font-semibold text-violet-600 hover:text-violet-700 hover:underline"
                            >
                              View
                            </a>
                            {isAdmin && (
                              <button
                                onClick={() => handleDocDelete(doc.id, doc.storagePath)}
                                className="text-[11px] font-semibold text-rose-400 hover:text-rose-600 transition-colors px-1.5 py-0.5 rounded hover:bg-rose-50"
                                title="Delete document"
                              >
                                Delete
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* ── Upload new document ─────────────────────────── */}
              <div className="border-t border-slate-100 pt-5">
                <p className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-3">Add Document</p>

                <div className="space-y-3">
                  {/* Type + file on the same row */}
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-[11.5px] font-semibold text-slate-500 mb-1 uppercase tracking-wide">
                        Document Type <span className="text-rose-500">*</span>
                      </label>
                      <select
                        value={docType}
                        onChange={e => { setDocType(e.target.value); setDocUploadError(""); }}
                        className="w-full px-3 py-2.5 text-[13px] text-slate-800 bg-white border border-slate-200 rounded-lg
                          focus:outline-none focus:ring-2 focus:ring-violet-400 focus:border-transparent transition appearance-none cursor-pointer"
                      >
                        <option value="">— Select type —</option>
                        {DOCUMENT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="block text-[11.5px] font-semibold text-slate-500 mb-1 uppercase tracking-wide">
                        File <span className="text-rose-500">*</span>
                        <span className="ml-1 font-normal normal-case text-slate-400">({ALLOWED_EXTENSIONS_LABEL})</span>
                      </label>
                      <input
                        type="file"
                        accept={ALLOWED_MIME_TYPES.join(",")}
                        onChange={handleDocFileChange}
                        className="w-full text-[12px] text-slate-700 bg-white border border-slate-200 rounded-lg px-2.5 py-2
                          file:mr-2 file:py-1 file:px-2.5 file:rounded-md file:border-0 file:text-[11px] file:font-semibold
                          file:bg-violet-50 file:text-violet-700 hover:file:bg-violet-100 cursor-pointer"
                      />
                    </div>
                  </div>

                  {/* Optional note */}
                  <div>
                    <label className="block text-[11.5px] font-semibold text-slate-500 mb-1 uppercase tracking-wide">
                      Note <span className="font-normal normal-case text-slate-400">(optional)</span>
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. Passport valid until 2028, visibly worn"
                      value={docNote}
                      onChange={e => setDocNote(e.target.value)}
                      className="w-full px-3.5 py-2.5 text-[13px] text-slate-800 bg-white border border-slate-200 rounded-lg
                        placeholder:text-slate-300 focus:outline-none focus:ring-2 focus:ring-violet-400 focus:border-transparent transition"
                    />
                  </div>

                  {/* Selected file preview */}
                  {docFile && (
                    <div className="flex items-center gap-2 bg-violet-50 border border-violet-200 rounded-lg px-3.5 py-2.5">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-3.5 h-3.5 text-violet-600 flex-shrink-0">
                        <path d="M9 12l2 2 4-4M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
                      </svg>
                      <span className="text-[12px] text-violet-800 font-medium truncate">{docFile.name}</span>
                      <span className="text-[11px] text-violet-500 ml-auto flex-shrink-0">
                        {(docFile.size / 1024).toFixed(0)} KB
                      </span>
                    </div>
                  )}

                  {/* Error */}
                  {docUploadError && (
                    <p className="text-[11.5px] text-rose-600 flex items-center gap-1.5">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-3.5 h-3.5 flex-shrink-0">
                        <circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>
                      </svg>
                      {docUploadError}
                    </p>
                  )}

                  {/* Submit */}
                  <div className="flex items-center justify-end gap-3 pt-1">
                    <button type="button" onClick={closeDocsModal}
                      className="px-4 py-2 text-[13px] font-medium text-slate-600 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg transition-colors">
                      Close
                    </button>
                    <button
                      type="button"
                      onClick={handleDocUpload}
                      disabled={docUploading || !docType || !docFile}
                      className={`flex items-center gap-2 px-5 py-2 text-[13px] font-semibold rounded-lg transition-colors shadow-sm ${
                        docUploading || !docType || !docFile
                          ? "text-slate-400 bg-slate-100 border border-slate-200 cursor-not-allowed"
                          : "text-white bg-violet-600 hover:bg-violet-700"
                      }`}
                    >
                      {docUploading ? (
                        <>
                          <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
                          </svg>
                          Uploading…
                        </>
                      ) : (
                        <>
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-4 h-4">
                            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12"/>
                          </svg>
                          Upload Document
                        </>
                      )}
                    </button>
                  </div>
                </div>
              </div>

            </div>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════
          ADD PAYMENT MODAL
          Opens when admin clicks "Add Payment" on a booking row.
          Validates: amount > 0, amount ≤ outstanding balance.
          On confirm: calls recordPayment() in HotelContext which
          updates amountPaid and re-derives PaymentStatus.
          TODO: When billing module is added, also create a
                payment_transactions record here.
      ══════════════════════════════════════════════════════ */}
      {payModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm"
          onClick={e => { if (e.target === e.currentTarget) closePayModal(); }}
        >
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">

            {/* Modal header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 bg-slate-50">
              <div className="flex items-center gap-2.5">
                <div className="w-7 h-7 rounded-lg bg-emerald-600 flex items-center justify-center">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-3.5 h-3.5 text-white">
                    <path d="M12 5v14M5 12h14"/>
                  </svg>
                </div>
                <div>
                  <h2 className="text-[14px] font-semibold text-slate-800 leading-none">
                    Record Payment
                  </h2>
                  <p className="text-[11.5px] text-slate-400 mt-0.5 font-mono">
                    {payModal.id}
                  </p>
                </div>
              </div>
              <button
                onClick={closePayModal}
                className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-200 rounded-lg transition-colors"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-4 h-4">
                  <path d="M18 6L6 18M6 6l12 12"/>
                </svg>
              </button>
            </div>

            {/* Payment summary */}
            <div className="px-6 pt-5 pb-4">
              {/* Guest info */}
              <div className="flex items-center gap-3 mb-5">
                <div className={`w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 text-[11px] font-bold ${avatarColor(payModal.guestName)}`}>
                  {initials(payModal.guestName)}
                </div>
                <div>
                  <p className="text-[13.5px] font-semibold text-slate-800">{payModal.guestName}</p>
                  <p className="text-[12px] text-slate-400">
                    Room {payModal.roomNumber} · {payModal.roomCategory} · {payModal.nights} night{payModal.nights !== 1 ? "s" : ""}
                  </p>
                </div>
              </div>

              {/* Not-checked-in warning / block */}
              {payModal.status !== "Checked In" && (
                isAdmin ? (
                  /* Admin: show warning but allow proceeding */
                  <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3.5 py-3 mb-4">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5">
                      <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
                      <path d="M12 9v4M12 17h.01"/>
                    </svg>
                    <p className="text-[12px] text-amber-800">
                      <span className="font-semibold">This booking is not checked in yet.</span>{" "}
                      Recording a payment now is allowed for admins — confirm the guest is present before proceeding.
                    </p>
                  </div>
                ) : (
                  /* Staff: block entirely — this path shouldn't normally be reachable */
                  <div className="flex items-start gap-2 bg-rose-50 border border-rose-200 rounded-lg px-3.5 py-3 mb-4">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-4 h-4 text-rose-500 flex-shrink-0 mt-0.5">
                      <circle cx="12" cy="12" r="10"/><path d="M4.93 4.93l14.14 14.14"/>
                    </svg>
                    <p className="text-[12px] text-rose-700">
                      <span className="font-semibold">Payment unavailable.</span>{" "}
                      This booking is not checked in yet. Please complete check-in first.
                    </p>
                  </div>
                )
              )}

              {/* Amount breakdown */}
              <div className="grid grid-cols-3 gap-3 mb-5">
                <div className="bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 text-center">
                  <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1">Total</p>
                  <p className="text-[15px] font-bold text-slate-800">৳{payModal.totalAmount.toLocaleString()}</p>
                </div>
                <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2.5 text-center">
                  <p className="text-[10px] font-semibold text-emerald-600 uppercase tracking-wider mb-1">Paid</p>
                  <p className="text-[15px] font-bold text-emerald-700">৳{payModal.amountPaid.toLocaleString()}</p>
                </div>
                <div className="bg-rose-50 border border-rose-200 rounded-lg px-3 py-2.5 text-center">
                  <p className="text-[10px] font-semibold text-rose-500 uppercase tracking-wider mb-1">Due</p>
                  <p className="text-[15px] font-bold text-rose-600">
                    ৳{calcTrueDue(payModal).toLocaleString()}
                  </p>
                </div>
              </div>

              {/* Payment form — hidden for staff when not checked in */}
              {!isAdmin && payModal.status !== "Checked In" ? null : <form onSubmit={handlePaySubmit} noValidate>
                <div className="mb-4">
                  <label
                    htmlFor="payMethod"
                    className="block text-[12px] font-semibold text-slate-600 mb-1.5 uppercase tracking-wide"
                  >
                    Payment Method
                  </label>
                  <select
                    id="payMethod"
                    value={payMethod}
                    onChange={e => setPayMethod(e.target.value as PaymentMethod)}
                    className="w-full px-3.5 py-2.5 text-[14px] font-semibold text-slate-800 bg-white border border-slate-200 rounded-lg
                      focus:outline-none focus:ring-2 focus:ring-emerald-400 focus:border-transparent transition"
                  >
                    {PAYMENT_METHODS.map(m => (
                      <option key={m} value={m}>{PAYMENT_METHOD_LABELS[m]}</option>
                    ))}
                  </select>
                </div>
                <div className="mb-4">
                  <label className="block text-[12px] font-semibold text-slate-600 mb-1.5 uppercase tracking-wide">
                    Payment Amount (BDT) <span className="text-rose-500">*</span>
                  </label>
                  <div className="relative">
                    <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 font-semibold pointer-events-none">
                      ৳
                    </span>
                    <input
                      type="number"
                      min={0.01}
                      step="0.01"
                      max={calcTrueDue(payModal)}
                      placeholder="0.00"
                      value={payAmount}
                      onChange={e => {
                        setPayAmount(e.target.value);
                        if (payError) setPayError("");
                      }}
                      onWheel={e => (e.target as HTMLInputElement).blur()}
                      autoFocus
                      className={`w-full pl-7 pr-3.5 py-2.5 text-[14px] font-semibold text-slate-800 bg-white border rounded-lg
                        placeholder:text-slate-300 focus:outline-none focus:ring-2 focus:ring-emerald-400 focus:border-transparent transition
                        [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none
                        ${payError ? "border-rose-300 bg-rose-50" : "border-slate-200"}`}
                    />
                  </div>
                  {/* Validation error */}
                  {payError && (
                    <div className="mt-2 flex items-start gap-1.5">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-3.5 h-3.5 text-rose-500 flex-shrink-0 mt-0.5">
                        <circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>
                      </svg>
                      <p className="text-[11.5px] text-rose-600">{payError}</p>
                    </div>
                  )}
                  {/* Quick-fill "pay full balance" helper */}
                  {calcTrueDue(payModal) > 0 && (
                    <button
                      type="button"
                      onClick={() => {
                        setPayAmount(String(calcTrueDue(payModal)));
                        setPayError("");
                      }}
                      className="mt-2 text-[11.5px] font-medium text-emerald-600 hover:text-emerald-700 hover:underline transition-colors"
                    >
                      Pay full balance (৳{calcTrueDue(payModal).toLocaleString()})
                    </button>
                  )}
                </div>

                {/* Live preview of new status */}
                {payAmount && parseFloat(payAmount) > 0 && parseFloat(payAmount) <= calcTrueDue(payModal) && (
                  <div className="mb-4 flex items-center gap-3 bg-slate-50 border border-slate-200 rounded-lg px-4 py-2.5">
                    <p className="text-[12px] text-slate-500 flex-1">After this payment:</p>
                    <p className="text-[12px] font-semibold text-emerald-700">
                      ৳{(payModal.amountPaid + parseFloat(payAmount)).toLocaleString()} paid
                    </p>
                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold ${
                      paymentBadge(derivePaymentStatus(payModal.totalAmount, payModal.amountPaid + parseFloat(payAmount)))
                    }`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${
                        paymentDot(derivePaymentStatus(payModal.totalAmount, payModal.amountPaid + parseFloat(payAmount)))
                      }`} />
                      {derivePaymentStatus(payModal.totalAmount, payModal.amountPaid + parseFloat(payAmount))}
                    </span>
                  </div>
                )}

                {/* Modal actions */}
                <div className="flex items-center justify-end gap-3">
                  <button
                    type="button"
                    onClick={closePayModal}
                    className="px-4 py-2.5 text-[13px] font-medium text-slate-600 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="flex items-center gap-2 px-5 py-2.5 text-[13px] font-semibold text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg transition-colors shadow-sm"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-4 h-4">
                      <path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><path d="M22 4L12 14.01l-3-3"/>
                    </svg>
                    Record Payment
                  </button>
                </div>
              </form>}
            </div>
          </div>
        </div>
      )}

      {/* ── TIMELINE MODAL ─────────────────────────────────────── */}
      {timelineModal && (() => {
        const b = timelineModal;
        const due = calcTrueDue(b);
        const isCancelled = b.status === "Cancelled";

        // Node helper: filled circle when timestamp present, hollow when pending
        function Node({ color, pending }: { color: string; pending?: boolean }) {
          if (pending) {
            return (
              <div className={`w-3 h-3 rounded-full border-2 ${color} bg-white flex-shrink-0`} />
            );
          }
          return <div className={`w-3 h-3 rounded-full ${color} flex-shrink-0`} />;
        }

        return (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4"
            style={{ backgroundColor: "rgba(0,0,0,0.45)" }}
            onClick={() => setTimelineModal(null)}
          >
            <div
              className="bg-white rounded-2xl shadow-xl w-full max-w-md max-h-[90vh] overflow-y-auto"
              onClick={e => e.stopPropagation()}
            >
              {/* Header */}
              <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-slate-100">
                <div className="flex items-center gap-2">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-4 h-4 text-amber-500">
                    <circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>
                  </svg>
                  <h2 className="text-[14px] font-semibold text-slate-800">Booking Timeline</h2>
                </div>
                <button
                  onClick={() => setTimelineModal(null)}
                  className="w-7 h-7 flex items-center justify-center rounded-full text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-4 h-4">
                    <path d="M18 6L6 18M6 6l12 12"/>
                  </svg>
                </button>
              </div>

              <div className="px-6 py-5 space-y-6">

                {/* ── Guest summary ────────────────────────────── */}
                <div className="flex items-center gap-3">
                  <div className={`w-10 h-10 rounded-full flex items-center justify-center text-white text-[13px] font-bold flex-shrink-0 ${avatarColor(b.guestName)}`}>
                    {initials(b.guestName)}
                  </div>
                  <div className="min-w-0">
                    <p className="text-[13px] font-semibold text-slate-800 truncate">{b.guestName}</p>
                    <p className="text-[11.5px] text-slate-500">
                      Room {b.roomNumber} · {b.checkIn} → {b.checkOut}
                    </p>
                    {displayEmail(b.email) && (
                      <p className="text-[11px] text-slate-400 truncate">{displayEmail(b.email)}</p>
                    )}
                  </div>
                  <div className="ml-auto flex-shrink-0">
                    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold ${statusBadge(b.status)}`}>
                      {b.status}
                    </span>
                  </div>
                </div>

                {/* ── Booking ID chip ───────────────────────────── */}
                <div className="flex items-center gap-2 bg-slate-50 rounded-lg px-3 py-2">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-3.5 h-3.5 text-slate-400 flex-shrink-0">
                    <rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>
                  </svg>
                  <p className="text-[12px] text-slate-500">Booking ID</p>
                  <p className="text-[12px] font-semibold text-slate-700 ml-auto">{b.id}</p>
                </div>

                {/* ── Timeline nodes ────────────────────────────── */}
                <div>
                  <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide mb-3">Lifecycle</p>
                  <div className="space-y-0">

                    {/* Node 1 — Booking Created */}
                    <div className="flex gap-3">
                      <div className="flex flex-col items-center">
                        <Node color="bg-indigo-500" />
                        <div className="w-px flex-1 bg-slate-200 mt-1" />
                      </div>
                      <div className="pb-5 min-w-0">
                        <p className="text-[12px] font-semibold text-slate-700">Booking Created</p>
                        {b.createdAt ? (
                          <p className="text-[11.5px] text-slate-500 mt-0.5">{formatTimestamp(b.createdAt)}</p>
                        ) : (
                          <p className="text-[11.5px] text-slate-400 italic mt-0.5">Timestamp not recorded</p>
                        )}
                      </div>
                    </div>

                    {isCancelled ? (
                      /* Cancelled terminal node */
                      <div className="flex gap-3">
                        <div className="flex flex-col items-center">
                          <Node color="bg-rose-500" />
                        </div>
                        <div className="pb-1 min-w-0">
                          <p className="text-[12px] font-semibold text-rose-600">Booking Cancelled</p>
                          <p className="text-[11.5px] text-slate-400 italic mt-0.5">No further activity</p>
                        </div>
                      </div>
                    ) : (
                      <>
                        {/* Node 2 — Checked In */}
                        <div className="flex gap-3">
                          <div className="flex flex-col items-center">
                            <Node
                              color={b.checkedInAt ? "bg-emerald-500" : "border-slate-300"}
                              pending={!b.checkedInAt}
                            />
                            <div className="w-px flex-1 bg-slate-200 mt-1" />
                          </div>
                          <div className="pb-5 min-w-0">
                            <p className={`text-[12px] font-semibold ${b.checkedInAt ? "text-slate-700" : "text-slate-400"}`}>
                              Checked In
                            </p>
                            {b.checkedInAt ? (
                              <p className="text-[11.5px] text-slate-500 mt-0.5">{formatTimestamp(b.checkedInAt)}</p>
                            ) : (
                              <p className="text-[11.5px] text-slate-400 italic mt-0.5">Pending</p>
                            )}
                          </div>
                        </div>

                        {/* Node 3 — Checked Out */}
                        <div className="flex gap-3">
                          <div className="flex flex-col items-center">
                            <Node
                              color={b.checkedOutAt ? (b.checkoutOverride?.used ? "bg-amber-500" : "bg-slate-500") : "border-slate-300"}
                              pending={!b.checkedOutAt}
                            />
                          </div>
                          <div className="pb-1 min-w-0">
                            <p className={`text-[12px] font-semibold ${b.checkedOutAt ? (b.checkoutOverride?.used ? "text-amber-700" : "text-slate-700") : "text-slate-400"}`}>
                              Checked Out
                              {b.checkoutOverride?.used && (
                                <span className="ml-1.5 text-[10px] font-semibold bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-full">Override</span>
                              )}
                            </p>
                            {b.checkedOutAt ? (
                              <p className="text-[11.5px] text-slate-500 mt-0.5">{formatTimestamp(b.checkedOutAt)}</p>
                            ) : (
                              <p className="text-[11.5px] text-slate-400 italic mt-0.5">Pending</p>
                            )}
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                </div>

                {/* ── Override details ──────────────────────────── */}
                {b.checkoutOverride?.used && (
                  <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 space-y-2">
                    <div className="flex items-center gap-1.5">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-3.5 h-3.5 text-amber-600 flex-shrink-0">
                        <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
                      </svg>
                      <p className="text-[11.5px] font-semibold text-amber-700">Admin Override Used</p>
                    </div>
                    <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11.5px]">
                      <span className="text-amber-600/70">Authorized by</span>
                      <span className="font-medium text-amber-800">{b.checkoutOverride.by}</span>
                      {b.checkoutOverride.overrideUsedAt && (
                        <>
                          <span className="text-amber-600/70">At</span>
                          <span className="font-medium text-amber-800">{formatTimestamp(b.checkoutOverride.overrideUsedAt)}</span>
                        </>
                      )}
                      <span className="text-amber-600/70">Reason</span>
                      <span className="font-medium text-amber-800 break-words">{b.checkoutOverride.reason}</span>
                    </div>
                    {due === 0 && (
                      <p className="text-[11px] text-amber-600/70 italic">Balance subsequently settled.</p>
                    )}
                  </div>
                )}

                {/* ── Payment summary ───────────────────────────── */}
                <div>
                  <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide mb-3">Payment Summary</p>
                  <div className="grid grid-cols-3 gap-2 mb-3">
                    <div className="bg-slate-50 rounded-lg px-3 py-2.5 text-center">
                      <p className="text-[10.5px] text-slate-400 mb-1">Total</p>
                      <p className="text-[13px] font-bold text-slate-700">৳{b.totalAmount.toLocaleString()}</p>
                    </div>
                    <div className="bg-emerald-50 rounded-lg px-3 py-2.5 text-center">
                      <p className="text-[10.5px] text-emerald-500 mb-1">Paid</p>
                      <p className="text-[13px] font-bold text-emerald-700">৳{b.amountPaid.toLocaleString()}</p>
                    </div>
                    <div className={`rounded-lg px-3 py-2.5 text-center ${due > 0 ? "bg-rose-50" : "bg-slate-50"}`}>
                      <p className={`text-[10.5px] mb-1 ${due > 0 ? "text-rose-400" : "text-slate-400"}`}>Due</p>
                      <p className={`text-[13px] font-bold ${due > 0 ? "text-rose-600" : "text-slate-400"}`}>
                        ৳{due.toLocaleString()}
                      </p>
                    </div>
                  </div>
                  {b.lastPaymentMethod && (
                    <p className="text-[11.5px] text-slate-500 mt-1 mb-2">
                      Last payment via{" "}
                      <span className="font-medium text-slate-700">
                        {formatPaymentMethod(b.lastPaymentMethod)}
                      </span>
                    </p>
                  )}
                  <div className="flex items-center justify-between px-3 py-2 bg-slate-50 rounded-lg">
                    <p className="text-[11.5px] text-slate-500">Payment status</p>
                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold ${paymentBadge(b.payment)}`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${paymentDot(b.payment)}`} />
                      {b.payment}
                    </span>
                  </div>
                </div>

              </div>

              {/* Footer */}
              <div className="px-6 pb-5">
                {(b.status === "Confirmed" || b.status === "Checked In") ? (
                  <div className="flex gap-3">
                    <button
                      onClick={() => setTimelineModal(null)}
                      className="flex-1 py-2.5 text-[13px] font-medium text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-xl transition-colors"
                    >
                      Close
                    </button>
                    <button
                      onClick={() => { setTimelineModal(null); setEditTarget(b); }}
                      className="flex-1 py-2.5 text-[13px] font-semibold text-white bg-violet-600 hover:bg-violet-700 rounded-xl transition-colors"
                    >
                      Edit Booking
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setTimelineModal(null)}
                    className="w-full py-2.5 text-[13px] font-medium text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-xl transition-colors"
                  >
                    Close
                  </button>
                )}
              </div>
            </div>
          </div>
        );
      })()}

      {/* ══════════════════════════════════════════════════════
          RISKY-EDIT CONFIRMATION MODAL
          ══════════════════════════════════════════════════════ */}
      {confirmDiffs !== null && editTarget && (
        <div
          className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center px-4"
          onClick={handleConfirmCancel}
        >
          <div
            className="bg-white rounded-2xl shadow-2xl w-full max-w-sm"
            onClick={e => e.stopPropagation()}
          >
            {/* Header */}
            <div className="px-6 pt-5 pb-4 border-b border-rose-100 bg-rose-50 rounded-t-2xl">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-full bg-rose-100 flex items-center justify-center shrink-0">
                  <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4 text-rose-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                </div>
                <div>
                  <h3 className="text-[14px] font-semibold text-slate-800">Confirm changes</h3>
                  <p className="text-[11.5px] text-slate-500 mt-0.5">Review before saving {editTarget.id}</p>
                </div>
              </div>
            </div>

            {/* Diff table */}
            <div className="px-6 py-4">
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="border-b border-slate-100">
                    <th className="text-left pb-2 text-[11px] font-semibold text-slate-400 uppercase tracking-wide w-1/3">Field</th>
                    <th className="text-left pb-2 text-[11px] font-semibold text-slate-400 uppercase tracking-wide w-1/3">From</th>
                    <th className="text-left pb-2 text-[11px] font-semibold text-slate-400 uppercase tracking-wide w-1/3">To</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {confirmDiffs.map(row => (
                    <tr key={row.field}>
                      <td className="py-2 font-medium text-slate-600">{row.field}</td>
                      <td className="py-2 text-slate-400 line-through">{row.from}</td>
                      <td className="py-2 font-semibold text-slate-800">{row.to}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Footer */}
            <div className="flex items-center justify-end gap-3 px-6 pb-5 pt-2">
              <button
                type="button"
                onClick={handleConfirmCancel}
                className="px-4 py-2 text-[13px] font-medium text-slate-600 hover:text-slate-800 hover:bg-slate-100 rounded-xl transition-colors"
              >
                Go back
              </button>
              <button
                type="button"
                onClick={handleConfirmSubmit}
                className="px-5 py-2 text-[13px] font-semibold text-white bg-rose-600 hover:bg-rose-700 rounded-xl transition-colors"
              >
                Confirm &amp; Save
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════
          EDIT BOOKING MODAL (fixed overlay)
          ══════════════════════════════════════════════════════ */}
      {editTarget && (() => {
        const isCheckedIn = editTarget.status === "Checked In";
        return (
          <div
            className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-sm flex items-start justify-center overflow-y-auto py-8 px-4"
            onClick={handleEditCancel}
          >
            <div
              className="bg-white rounded-2xl shadow-2xl w-full max-w-lg my-auto"
              onClick={e => e.stopPropagation()}
            >
              {/* Header */}
              <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-slate-100">
                <div>
                  <h2 className="text-[15px] font-semibold text-slate-800">Edit Booking</h2>
                  <p className="text-[12px] text-slate-400 mt-0.5 flex items-center gap-1.5">
                    {editTarget.id}
                    <span className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-[10.5px] font-semibold ${statusBadge(editTarget.status)}`}>
                      {editTarget.status}
                    </span>
                  </p>
                </div>
                <button
                  onClick={handleEditCancel}
                  className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>

              {/* Checked-In warning banner */}
              {isCheckedIn && (
                <div className="mx-6 mt-4 px-4 py-2.5 bg-amber-50 border border-amber-200 rounded-xl flex items-start gap-2">
                  <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                  <p className="text-[12px] text-amber-700 leading-snug">
                    <span className="font-semibold">Guest is checked in.</span>{" "}
                    Contact and guest info can be updated. Room, dates, and rates are locked.
                  </p>
                </div>
              )}

              <div className="px-6 py-4 space-y-5">

                {/* ── Guest Info ─────────────────────────────── */}
                <div>
                  <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide mb-3">Guest Info</p>
                  <div className="space-y-3">
                    <div>
                      <label className="block text-[12px] font-medium text-slate-600 mb-1">Guest Name *</label>
                      <input
                        type="text"
                        value={editForm.guestName}
                        onChange={e => { setEditForm(p => ({ ...p, guestName: e.target.value })); setEditErrors(p => ({ ...p, guestName: undefined })); }}
                        className={`w-full px-3 py-2 text-[13px] rounded-xl border ${editErrors.guestName ? "border-red-400 bg-red-50" : "border-slate-200"} focus:outline-none focus:ring-2 focus:ring-violet-400/40 focus:border-violet-400`}
                        placeholder="Full name"
                      />
                      {editErrors.guestName && <p className="mt-1 text-[11.5px] text-red-500">{editErrors.guestName}</p>}
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-[12px] font-medium text-slate-600 mb-1">Phone</label>
                        <input
                          type="text"
                          value={editForm.phone}
                          onChange={e => setEditForm(p => ({ ...p, phone: e.target.value }))}
                          className="w-full px-3 py-2 text-[13px] rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-violet-400/40 focus:border-violet-400"
                          placeholder="+880 1xxx xxxx"
                        />
                      </div>
                      <div>
                        <label className="block text-[12px] font-medium text-slate-600 mb-1">Email</label>
                        <input
                          type="email"
                          value={editForm.email}
                          onChange={e => { setEditForm(p => ({ ...p, email: e.target.value })); setEditErrors(p => ({ ...p, email: undefined })); }}
                          className={`w-full px-3 py-2 text-[13px] rounded-xl border ${editErrors.email ? "border-red-400 bg-red-50" : "border-slate-200"} focus:outline-none focus:ring-2 focus:ring-violet-400/40 focus:border-violet-400`}
                          placeholder="guest@email.com"
                        />
                        {editErrors.email && <p className="mt-1 text-[11.5px] text-red-500">{editErrors.email}</p>}
                      </div>
                    </div>
                  </div>
                </div>

                {/* ── Stay Details ───────────────────────────── */}
                <div>
                  <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide mb-3">Stay Details</p>
                  <div className="space-y-3">
                    <div>
                      <label className="block text-[12px] font-medium text-slate-600 mb-1">Room Number *</label>
                      <input
                        type="text"
                        value={editForm.room}
                        onChange={e => { setEditForm(p => ({ ...p, room: e.target.value })); setEditErrors(p => ({ ...p, room: undefined })); }}
                        disabled={isCheckedIn}
                        className={`w-full px-3 py-2 text-[13px] rounded-xl border ${editErrors.room ? "border-red-400 bg-red-50" : "border-slate-200"} focus:outline-none focus:ring-2 focus:ring-violet-400/40 focus:border-violet-400 disabled:bg-slate-50 disabled:text-slate-400 disabled:cursor-not-allowed`}
                        placeholder="204"
                      />
                      {editErrors.room && <p className="mt-1 text-[11.5px] text-red-500">{editErrors.room}</p>}
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-[12px] font-medium text-slate-600 mb-1">Check-in *</label>
                        <input
                          type="date"
                          value={editForm.checkIn}
                          onChange={e => { setEditForm(p => ({ ...p, checkIn: e.target.value })); setEditErrors(p => ({ ...p, checkIn: undefined })); }}
                          disabled={isCheckedIn}
                          className={`w-full px-3 py-2 text-[13px] rounded-xl border ${editErrors.checkIn ? "border-red-400 bg-red-50" : "border-slate-200"} focus:outline-none focus:ring-2 focus:ring-violet-400/40 focus:border-violet-400 disabled:bg-slate-50 disabled:text-slate-400 disabled:cursor-not-allowed`}
                        />
                        {editErrors.checkIn && <p className="mt-1 text-[11.5px] text-red-500">{editErrors.checkIn}</p>}
                      </div>
                      <div>
                        <label className="block text-[12px] font-medium text-slate-600 mb-1">Check-out *</label>
                        <input
                          type="date"
                          value={editForm.checkOut}
                          onChange={e => { setEditForm(p => ({ ...p, checkOut: e.target.value })); setEditErrors(p => ({ ...p, checkOut: undefined })); }}
                          disabled={isCheckedIn}
                          className={`w-full px-3 py-2 text-[13px] rounded-xl border ${editErrors.checkOut ? "border-red-400 bg-red-50" : "border-slate-200"} focus:outline-none focus:ring-2 focus:ring-violet-400/40 focus:border-violet-400 disabled:bg-slate-50 disabled:text-slate-400 disabled:cursor-not-allowed`}
                        />
                        {editErrors.checkOut && <p className="mt-1 text-[11.5px] text-red-500">{editErrors.checkOut}</p>}
                      </div>
                    </div>
                    {editNights > 0 && (
                      <p className="text-[12px] text-slate-500">
                        <span className="font-medium text-slate-700">{editNights}</span>{" "}
                        night{editNights !== 1 ? "s" : ""}
                      </p>
                    )}
                    {editRoomConflict && (
                      <div className="px-3 py-2 bg-red-50 border border-red-200 rounded-xl text-[12px] text-red-600">
                        ⚠️ Room conflict with booking {editRoomConflict.id} ({editRoomConflict.checkIn} – {editRoomConflict.checkOut}).
                      </div>
                    )}
                  </div>
                </div>

                {/* ── Guests ─────────────────────────────────── */}
                <div>
                  <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide mb-3">Guests</p>
                  <div className="space-y-3">
                    <div className="flex items-center gap-3">
                      <label className="text-[12px] font-medium text-slate-600 whitespace-nowrap">Total Guests</label>
                      <input
                        type="number"
                        min={1}
                        value={editForm.totalGuests}
                        onChange={e => setEditForm(p => ({ ...p, totalGuests: Math.max(1, parseInt(e.target.value) || 1) }))}
                        className="w-20 px-3 py-2 text-[13px] rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-violet-400/40 focus:border-violet-400"
                      />
                    </div>
                    {editForm.additionalGuests.map((g, i) => (
                      <div key={i} className="grid grid-cols-[1fr_1fr_auto] gap-2 items-end">
                        <div>
                          {i === 0 && <label className="block text-[11.5px] text-slate-500 mb-1">Name</label>}
                          <input
                            type="text"
                            value={g.name}
                            onChange={e => updateEditGuest(i, "name", e.target.value)}
                            placeholder="Guest name"
                            className="w-full px-3 py-2 text-[13px] rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-violet-400/40 focus:border-violet-400"
                          />
                        </div>
                        <div>
                          {i === 0 && <label className="block text-[11.5px] text-slate-500 mb-1">Nationality</label>}
                          <input
                            type="text"
                            value={g.nationality}
                            onChange={e => updateEditGuest(i, "nationality", e.target.value)}
                            placeholder="Nationality"
                            className="w-full px-3 py-2 text-[13px] rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-violet-400/40 focus:border-violet-400"
                          />
                        </div>
                        <button
                          type="button"
                          onClick={() => removeEditGuest(i)}
                          className="p-2 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      </div>
                    ))}
                    <button
                      type="button"
                      onClick={addEditGuest}
                      className="text-[12px] text-violet-600 hover:text-violet-700 font-medium flex items-center gap-1"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                      </svg>
                      Add guest
                    </button>
                  </div>
                </div>

                {/* ── Rates & Payment ────────────────────────── */}
                <div>
                  <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide mb-3">Rates & Payment</p>
                  <div className="space-y-3">
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-[12px] font-medium text-slate-600 mb-1">Published Rate / night</label>
                        <div className="relative">
                          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[12px] text-slate-400">৳</span>
                          <input
                            type="number" min={0}
                            value={editForm.fixedRate}
                            onChange={e => setEditForm(p => ({ ...p, fixedRate: e.target.value }))}
                            disabled={isCheckedIn}
                            className="w-full pl-6 pr-3 py-2 text-[13px] rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-violet-400/40 focus:border-violet-400 disabled:bg-slate-50 disabled:text-slate-400 disabled:cursor-not-allowed"
                            placeholder="0"
                          />
                        </div>
                      </div>
                      <div>
                        <label className="block text-[12px] font-medium text-slate-600 mb-1">Booking Rate / night</label>
                        <div className="relative">
                          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[12px] text-slate-400">৳</span>
                          <input
                            type="number" min={0}
                            value={editForm.bookingRate}
                            onChange={e => setEditForm(p => ({ ...p, bookingRate: e.target.value }))}
                            disabled={isCheckedIn}
                            className="w-full pl-6 pr-3 py-2 text-[13px] rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-violet-400/40 focus:border-violet-400 disabled:bg-slate-50 disabled:text-slate-400 disabled:cursor-not-allowed"
                            placeholder="0"
                          />
                        </div>
                      </div>
                    </div>
                    {editDiscountPct > 0 && (
                      <p className="text-[11.5px] text-emerald-600">
                        {editDiscountPct}% discount — saving ৳{editTotalSaving.toLocaleString()} total
                        {editNights > 0 ? ` (৳${editDiscountPerNight.toLocaleString()}/night × ${editNights} nights)` : ""}
                      </p>
                    )}
                    <div>
                      <label className="block text-[12px] font-medium text-slate-600 mb-1">Total Amount</label>
                      <div className="relative">
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[12px] text-slate-400">৳</span>
                        <input
                          type="number" min={0}
                          value={editForm.totalAmount}
                          onChange={e => setEditForm(p => ({ ...p, totalAmount: e.target.value }))}
                          disabled={isCheckedIn}
                          className="w-full pl-6 pr-3 py-2 text-[13px] rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-violet-400/40 focus:border-violet-400 disabled:bg-slate-50 disabled:text-slate-400 disabled:cursor-not-allowed"
                          placeholder="0"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="block text-[12px] font-medium text-slate-600 mb-1">Amount Paid at Booking</label>
                      <div className="relative">
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[12px] text-slate-400">৳</span>
                        <input
                          type="number" min={0}
                          max={parseFloat(editForm.totalAmount) || undefined}
                          value={editForm.amountPaid}
                          onChange={e => { setEditForm(p => ({ ...p, amountPaid: e.target.value })); setEditErrors(p => ({ ...p, amountPaid: undefined })); }}
                          className={`w-full pl-6 pr-3 py-2 text-[13px] rounded-xl border ${editErrors.amountPaid ? "border-red-400 bg-red-50" : "border-slate-200"} focus:outline-none focus:ring-2 focus:ring-violet-400/40 focus:border-violet-400`}
                          placeholder="0"
                        />
                      </div>
                      {editErrors.amountPaid
                        ? <p className="mt-1 text-[11.5px] text-red-500">{editErrors.amountPaid}</p>
                        : <p className="mt-1 text-[11px] text-slate-400">Adjust via Record Payment for post-booking payments.</p>
                      }
                    </div>
                  </div>
                </div>

              </div>

              {/* Footer */}
              <div className="flex items-center justify-end gap-3 px-6 pb-5 pt-3 border-t border-slate-100">
                <button
                  type="button"
                  onClick={handleEditCancel}
                  className="px-4 py-2 text-[13px] font-medium text-slate-600 hover:text-slate-800 hover:bg-slate-100 rounded-xl transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleEditSubmit}
                  disabled={!editHasChanges || editSaving || !!editRoomConflict}
                  className="px-5 py-2 text-[13px] font-semibold text-white bg-violet-600 hover:bg-violet-700 rounded-xl transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {editSaving ? "Saving…" : "Save Changes"}
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

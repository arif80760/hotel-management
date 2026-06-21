"use client";

// app/front-desk/FrontDeskClient.tsx
//
// Daily operations panel for front-desk staff.
// Three live sections, all derived from shared HotelContext:
//
//   A. Today's Arrivals  — Confirmed bookings whose checkIn === today
//   B. In-House Guests   — All bookings with status "Checked In"
//   C. Today's Departures— bookings whose checkOut === today and not yet done
//
// Check-in:  calls changeBookingStatus → "Checked In" (room becomes Occupied)
// Check-out: same gate as BookingsClient —
//            due > 0  → blocked for Staff; Admin can override with reason
//            due = 0  → passes straight through
//
// Role simulation: same Staff/Admin local state pattern as BookingsClient.
// TODO: Replace with real session role once auth is wired in.

import { useState, useEffect, useMemo } from "react";
import { useHotel } from "@/contexts/HotelContext";
import { useAuth } from "@/contexts/AuthContext";
import {
  type BookingStatus,
  type PaymentStatus,
  type PaymentMethod,
  type MockBooking as Booking,
  HOTEL_POLICY,
  PAYMENT_METHODS,
  PAYMENT_METHOD_LABELS,
} from "@/lib/mockData";
import { calcTrueDue, derivePaymentStatus } from "@/lib/invoiceUtils";
import { calcBookingLevelDeductions } from "@/lib/checkoutUtils";
import ConfirmDialog from "@/components/ConfirmDialog";

// ─────────────────────────────────────────────────────────────
// LOCAL TYPES
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// HELPERS  (mirrors BookingsClient — kept local to avoid coupling)
// ─────────────────────────────────────────────────────────────
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
    "No Show":     "bg-orange-50 text-orange-700 ring-1 ring-orange-200",
  };
  return m[s];
}

function paymentBadge(p: PaymentStatus): string {
  const m: Record<PaymentStatus, string> = {
    Paid:      "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200",
    Partial:   "bg-blue-50 text-blue-700 ring-1 ring-blue-200",
    Unpaid:    "bg-red-50 text-red-600 ring-1 ring-red-200",
    Cancelled: "bg-slate-100 text-slate-500 ring-1 ring-slate-200",
  };
  return m[p];
}

function paymentDot(p: PaymentStatus): string {
  const m: Record<PaymentStatus, string> = {
    Paid: "bg-emerald-500", Partial: "bg-blue-500", Unpaid: "bg-red-400", Cancelled: "bg-slate-400",
  };
  return m[p];
}

/** Returns true if the booking's check-in date is today or in the past. */
function canCheckInToday(checkInISO: string | undefined): boolean {
  if (!checkInISO) return true;   // no ISO date → don't block (safe fallback)
  const today = new Date().toISOString().slice(0, 10);
  return checkInISO <= today;
}

// Format today's date in exactly the same format used in MockBooking.checkIn/checkOut:
//   "Apr 22, 2026"
// This allows direct string comparison — no date parsing needed.
const TODAY_FMT = new Date().toLocaleDateString("en-US", {
  month: "short", day: "numeric", year: "numeric",
});

// ─────────────────────────────────────────────────────────────
// EMPTY STATE  (reusable within panels)
// ─────────────────────────────────────────────────────────────
function EmptyState({ message }: { message: string }) {
  return (
    <div className="px-5 py-10 text-center">
      <div className="w-9 h-9 rounded-full bg-slate-100 flex items-center justify-center mx-auto mb-3">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="w-4.5 h-4.5 text-slate-300">
          <path d="M9 12l2 2 4-4M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
        </svg>
      </div>
      <p className="text-[13px] text-slate-400">{message}</p>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// CHARGE TYPES  (mirrors BookingsClient)
// ─────────────────────────────────────────────────────────────
const CHARGE_TYPES = [
  "Room damage", "Mini-bar", "Laundry", "Extra bed",
  "Late checkout", "Missing item", "Restaurant/Food", "Transport", "Other",
] as const;

function formatChargeReason(type: string, note: string): string | null {
  if (!type) return null;
  return note.trim() ? `${type} - ${note.trim()}` : type;
}

// ─────────────────────────────────────────────────────────────
// CHECKOUT TIMING HELPERS  (mirrors BookingsClient)
// ─────────────────────────────────────────────────────────────

type CheckoutTiming = {
  scheduledAt:      Date;
  graceDeadlineAt:  Date;
  actualAt:         Date;
  minutesDiff:      number;  // positive = late, negative = early
  minutesPastGrace: number;  // positive = past grace window
  status:           "early" | "on_time" | "late";
};

function calcCheckoutTiming(checkOutDisplay: string, actualAt: Date): CheckoutTiming {
  const base = new Date(`${checkOutDisplay} 12:00:00`);
  const scheduledAt = new Date(base);
  scheduledAt.setHours(HOTEL_POLICY.checkoutHour, HOTEL_POLICY.checkoutMinute, 0, 0);
  const graceDeadlineAt  = new Date(scheduledAt.getTime() + HOTEL_POLICY.graceMinutes * 60_000);
  const minutesDiff      = Math.round((actualAt.getTime() - scheduledAt.getTime())    / 60_000);
  const minutesPastGrace = Math.round((actualAt.getTime() - graceDeadlineAt.getTime()) / 60_000);
  let status: CheckoutTiming["status"];
  if      (minutesDiff <= 0)      status = "early";
  else if (minutesPastGrace <= 0) status = "on_time";
  else                            status = "late";
  return { scheduledAt, graceDeadlineAt, actualAt, minutesDiff, minutesPastGrace, status };
}

function fmtTime(d: Date): string {
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
}

function fmtShortDate(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
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

// ─────────────────────────────────────────────────────────────
// COMPONENT
// ─────────────────────────────────────────────────────────────
export default function FrontDeskClient() {
  // ── Shared context ─────────────────────────────────────────
  const {
    bookings,
    changeBookingStatus,
    checkoutNormal,
    checkoutWithOverride,
    recordPayment,
    categoryName,
  } = useHotel();

  // Real role from authenticated session
  const { role: authRole } = useAuth();
  const isAdmin = authRole === "admin";


  // ── Feedback ────────────────────────────────────────────────
  const [successMsg, setSuccessMsg] = useState<string>("");

  // ── Checkout confirmation modal ─────────────────────────────
  // Always shown when "Check Out" is clicked — full billing summary.
  const [checkoutConfirm, setCheckoutConfirm] = useState<Booking | null>(null);

  // Generic confirm dialog (check-in / check-out gates).
  const [confirm, setConfirm] = useState<
    { title: string; message: string; confirmLabel: string; tone: "normal" | "warning" | "danger"; onConfirm: () => void | Promise<void> } | null
  >(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  // Extra charge fields
  const [chargeType,   setChargeType]   = useState<string>("");
  const [chargeAmount, setChargeAmount] = useState<string>("");
  const [chargeNote,   setChargeNote]   = useState<string>("");
  const [chargeError,  setChargeError]  = useState<string>("");
  // In-modal payment
  const [showModalPay,  setShowModalPay]  = useState<boolean>(false);
  const [modalPayAmt,   setModalPayAmt]   = useState<string>("");
  const [modalPayError, setModalPayError] = useState<string>("");
  // Override
  const [overrideReason, setOverrideReason] = useState<string>("");
  const [overrideError,  setOverrideError]  = useState<string>("");
  // More Discount (ad-hoc checkout discount)
  const [moreDiscountAmt,    setMoreDiscountAmt]    = useState<string>("");
  const [moreDiscountReason, setMoreDiscountReason] = useState<string>("");
  const [discountError,      setDiscountError]      = useState<string>("");

  // ── Checkout timing — time captured when modal opens ────────
  const [checkoutOpenedAt, setCheckoutOpenedAt] = useState<Date | null>(null);

  // ── Add-payment modal ────────────────────────────────────────
  const [payModal,  setPayModal]  = useState<Booking | null>(null);
  const [payAmount, setPayAmount] = useState<string>("");
  const [payError,  setPayError]  = useState<string>("");

  // ── Payment method selectors ─────────────────────────────────
  const [payMethod,         setPayMethod]         = useState<PaymentMethod>("cash");
  const [checkoutPayMethod, setCheckoutPayMethod] = useState<PaymentMethod>("cash");

  // ── Live amount paid for the booking being checked out ───────
  // Reads from live bookings state so recording a payment inside
  // the modal instantly re-calculates the Final Payable.
  const liveAmountPaid = useMemo(() => {
    if (!checkoutConfirm) return 0;
    return bookings.find(b => b.id === checkoutConfirm.id)?.amountPaid
      ?? checkoutConfirm.amountPaid;
  }, [bookings, checkoutConfirm?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Derived sections ─────────────────────────────────────────

  /** Section A: Confirmed bookings arriving today. */
  const todaysArrivals = useMemo(
    () => bookings.filter(b => b.checkIn === TODAY_FMT && b.status === "Confirmed"),
    [bookings]
  );

  /** Section B: All currently checked-in guests. */
  const inHouseGuests = useMemo(
    () => bookings.filter(b => b.status === "Checked In"),
    [bookings]
  );

  /**
   * Section C: Guests whose check-out date is today, still on-premise.
   * Excludes Cancelled and already Checked Out — nothing to action there.
   */
  const todaysDepartures = useMemo(
    () => bookings.filter(
      b => b.checkOut === TODAY_FMT
        && b.status !== "Cancelled"
        && b.status !== "Checked Out"
    ),
    [bookings]
  );

  // ── Effects ─────────────────────────────────────────────────
  useEffect(() => {
    if (!successMsg) return;
    const t = setTimeout(() => setSuccessMsg(""), 4500);
    return () => clearTimeout(t);
  }, [successMsg]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") closeCheckoutConfirm(); }
    if (checkoutConfirm) document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [checkoutConfirm]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") closePayModal(); }
    if (payModal) document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [payModal]);

  // ── Handlers ─────────────────────────────────────────────────

  /** Check In: Confirmed → Checked In (room becomes Occupied via context). */
  function handleCheckIn(booking: Booking, confirmed = false) {
    if (!confirmed) {
      setConfirm({
        title: "Check in",
        message: `Check in ${booking.id}? Room ${booking.roomNumber} will be marked Occupied.`,
        confirmLabel: "Check in",
        tone: "normal",
        onConfirm: () => handleCheckIn(booking, true),
      });
      return;
    }
    changeBookingStatus(booking.id, "Checked In");
    setSuccessMsg(
      `${booking.guestName} checked in · Room ${booking.roomNumber} is now Occupied.`
    );
  }

  /**
   * Check Out gate — always opens the checkout confirmation modal.
   * No checkout can happen without the operator reviewing the billing summary.
   */
  function handleCheckOut(booking: Booking) {
    setCheckoutConfirm(booking);
    setCheckoutOpenedAt(new Date());   // stamp "actual checkout time" for timing panel
    setChargeType(""); setChargeAmount(""); setChargeNote(""); setChargeError("");
    setShowModalPay(false); setModalPayAmt(""); setModalPayError("");
    setOverrideReason(""); setOverrideError("");
    setMoreDiscountAmt(""); setMoreDiscountReason(""); setDiscountError("");
    setCheckoutPayMethod("cash");
  }

  function closeCheckoutConfirm() {
    setCheckoutConfirm(null);
    setCheckoutOpenedAt(null);
    setChargeType(""); setChargeAmount(""); setChargeNote(""); setChargeError("");
    setShowModalPay(false); setModalPayAmt(""); setModalPayError("");
    setOverrideReason(""); setOverrideError("");
    setMoreDiscountAmt(""); setMoreDiscountReason(""); setDiscountError("");
    setCheckoutPayMethod("cash");
  }

  /**
   * Validates extra charge fields; returns formatted charge or undefined on error.
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

  async function handleConfirmCheckout(confirmed = false) {
    if (!checkoutConfirm) return;
    const charge = validateAndBuildCharge();
    if (charge === undefined) return;
    const { totalDays: earlyDays, totalAmt: earlyDeductionAmt } =
      calcBookingLevelDeductions(checkoutConfirm.rooms ?? [], checkoutOpenedAt ?? new Date());
    const actualDateISO = new Date().toISOString().split("T")[0];
    const remainingAfterPayment =
      checkoutConfirm.totalAmount + charge.amount - earlyDeductionAmt - liveAmountPaid;
    const discount = validateAndBuildDiscount(remainingAfterPayment);
    if (discount === undefined) return;
    const finalPayableBeforeCapture = remainingAfterPayment - discount.amount;

    // Capture modal state before closeCheckoutConfirm() wipes it.
    const bookingId      = checkoutConfirm.id;
    const guestName      = checkoutConfirm.guestName;
    const roomNumber     = checkoutConfirm.roomNumber;
    const capturedPayAmt = parseFloat(modalPayAmt) || 0;
    const capturedMethod = checkoutPayMethod;

    // Defensive guard — JSX disabled={isOverpayment} should block this, but hard-stop here too.
    if (capturedPayAmt > Math.max(0, finalPayableBeforeCapture)) {
      setModalPayError(
        `Payment amount exceeds outstanding balance of ৳${finalPayableBeforeCapture.toLocaleString()}. Adjust amount or increase discount.`
      );
      return;
    }

    const finalPayable = finalPayableBeforeCapture - capturedPayAmt;

    if (finalPayable > 0) {
      setOverrideError("There is an outstanding balance. Admin override is required to proceed.");
      return;
    }
    if (!confirmed) {
      setConfirm({
        title: "Confirm check-out",
        message: `Check out ${checkoutConfirm.id}?`,
        confirmLabel: "Check out",
        tone: "normal",
        onConfirm: () => handleConfirmCheckout(true),
      });
      return;
    }
    await checkoutNormal(
      bookingId,
      charge.amount,
      charge.reason,
      actualDateISO,
      discount.amount,
      moreDiscountReason.trim() || null,
      capturedMethod,
    );
    // Soft-fail payment step — DB scalar committed by checkoutNormal, trueDue guard passes.
    // callerRole="admin" bypasses the "Checked In" status guard (optimistic state is "Checked Out").
    if (capturedPayAmt > 0) {
      try {
        recordPayment(bookingId, capturedPayAmt, capturedMethod, "admin");
      } catch (err) {
        console.error("[FrontDesk handleConfirmCheckout] recordPayment soft-fail:", err instanceof Error ? err.message : err);
      }
    }
    setSuccessMsg(
      `${guestName} checked out · Room ${roomNumber} is now Available.`
    );
    closeCheckoutConfirm();
  }

  async function handleAdminOverride(confirmed = false) {
    if (!checkoutConfirm) return;
    // Use real auth role; fall back to the demo role toggle for now
    if (!isAdmin) {
      setOverrideError("Admin access is required to override checkout.");
      return;
    }
    const charge = validateAndBuildCharge();
    if (charge === undefined) return;
    const { totalDays: earlyDays, totalAmt: earlyDeductionAmt } =
      calcBookingLevelDeductions(checkoutConfirm.rooms ?? [], checkoutOpenedAt ?? new Date());
    const actualDateISO = new Date().toISOString().split("T")[0];
    const remainingAfterPayment =
      checkoutConfirm.totalAmount + charge.amount - earlyDeductionAmt - liveAmountPaid;
    const discount = validateAndBuildDiscount(remainingAfterPayment);
    if (discount === undefined) return;
    const finalPayableBeforeCapture = remainingAfterPayment - discount.amount;

    // Capture modal state before closeCheckoutConfirm() wipes it.
    const bookingId      = checkoutConfirm.id;
    const guestName      = checkoutConfirm.guestName;
    const capturedPayAmt = parseFloat(modalPayAmt) || 0;
    const capturedMethod = checkoutPayMethod;

    // Defensive guard — JSX disabled={!canOverride || isOverpayment} should block this, but hard-stop here too.
    if (capturedPayAmt > Math.max(0, finalPayableBeforeCapture)) {
      setModalPayError(
        `Payment amount exceeds outstanding balance of ৳${finalPayableBeforeCapture.toLocaleString()}. Adjust amount or increase discount.`
      );
      return;
    }

    const finalPayable = finalPayableBeforeCapture - capturedPayAmt;

    if (!confirmed) {
      setConfirm({
        title: "Confirm check-out",
        message: `Check out with ৳${finalPayable.toLocaleString()} still due?`,
        confirmLabel: "Check out",
        tone: "warning",
        onConfirm: () => handleAdminOverride(true),
      });
      return;
    }

    await checkoutWithOverride(
      bookingId,
      overrideReason,
      charge.amount,
      charge.reason,
      actualDateISO,
      discount.amount,
      moreDiscountReason.trim() || null,
      capturedMethod,
    );

    // Soft-fail payment step — same rationale as BookingsClient.handleAdminOverride.
    if (capturedPayAmt > 0) {
      try {
        recordPayment(bookingId, capturedPayAmt, capturedMethod, "admin");
      } catch (err) {
        console.error("[FrontDesk handleAdminOverride] recordPayment soft-fail:", err instanceof Error ? err.message : err);
      }
    }

    setSuccessMsg(
      `Admin override: ${guestName} checked out with ৳${finalPayable.toLocaleString()} still outstanding.`
    );
    closeCheckoutConfirm();
  }

  function openPayModal(booking: Booking) {
    // Guard: read live status + current role before opening
    const liveStatus    = bookings.find(b => b.id === booking.id)?.status ?? booking.status;
    const currentRole   = authRole;
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

  function handlePaySubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!payModal) return;

    // ── Hard payment guard ────────────────────────────────────────
    const liveBooking   = bookings.find(b => b.id === payModal.id);
    const liveStatus    = liveBooking?.status ?? payModal.status;
    const currentRole   = authRole;
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
      setPayError("Enter a valid amount greater than ৳0.");
      return;
    }
    if (amount > due) {
      setPayError(`Cannot exceed outstanding balance of ৳${due.toLocaleString()}.`);
      return;
    }
    recordPayment(payModal.id, amount, payMethod, currentRole ?? "staff");
    setSuccessMsg(
      `৳${amount.toLocaleString()} recorded for ${payModal.guestName} · ${payModal.id}.`
    );
    closePayModal();
  }

  // ── Render ───────────────────────────────────────────────────
  return (
    <div className="p-7 max-w-[1400px] space-y-6">

      {/* ══════════════════════════════════════════════════════
          PAGE HEADER
      ══════════════════════════════════════════════════════ */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-[22px] font-semibold text-slate-900 tracking-tight leading-none">
            Front Desk
          </h1>
          <p className="text-[13px] text-slate-500 mt-1">
            {TODAY_FMT} · Daily operations
          </p>
        </div>

      </div>

      {/* ══════════════════════════════════════════════════════
          SUCCESS BANNER
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
          SUMMARY STAT CARDS
      ══════════════════════════════════════════════════════ */}
      <div className="grid grid-cols-3 gap-4">

        <div className="bg-white border border-blue-200 rounded-xl px-5 py-4 flex items-center gap-3 shadow-sm">
          <div className="w-10 h-10 rounded-lg bg-blue-100 flex items-center justify-center flex-shrink-0">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" className="w-5 h-5 text-blue-600">
              <path d="M5 12h14M12 5l7 7-7 7"/>
            </svg>
          </div>
          <div>
            <p className="text-[11px] font-semibold text-blue-400 uppercase tracking-wider">Arrivals Today</p>
            <p className="text-[26px] font-bold text-blue-700 leading-none">{todaysArrivals.length}</p>
          </div>
        </div>

        <div className="bg-white border border-emerald-200 rounded-xl px-5 py-4 flex items-center gap-3 shadow-sm">
          <div className="w-10 h-10 rounded-lg bg-emerald-100 flex items-center justify-center flex-shrink-0">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" className="w-5 h-5 text-emerald-600">
              <path d="M2 20V9a2 2 0 012-2h16a2 2 0 012 2v11"/><path d="M2 20h20"/>
              <path d="M12 7V4"/><path d="M9 20v-5h6v5"/>
            </svg>
          </div>
          <div>
            <p className="text-[11px] font-semibold text-emerald-500 uppercase tracking-wider">In-House</p>
            <p className="text-[26px] font-bold text-emerald-700 leading-none">{inHouseGuests.length}</p>
          </div>
        </div>

        <div className="bg-white border border-amber-200 rounded-xl px-5 py-4 flex items-center gap-3 shadow-sm">
          <div className="w-10 h-10 rounded-lg bg-amber-100 flex items-center justify-center flex-shrink-0">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" className="w-5 h-5 text-amber-600">
              <path d="M19 12H5M12 5l7 7-7 7"/>
            </svg>
          </div>
          <div>
            <p className="text-[11px] font-semibold text-amber-500 uppercase tracking-wider">Departures Today</p>
            <p className="text-[26px] font-bold text-amber-700 leading-none">{todaysDepartures.length}</p>
          </div>
        </div>
      </div>

      {/* ══════════════════════════════════════════════════════
          THREE OPERATION PANELS
      ══════════════════════════════════════════════════════ */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">

        {/* ─────────────────────────────────────────────────────
            PANEL A — TODAY'S ARRIVALS
            Confirmed bookings with checkIn = today.
            Action: Check In → status "Checked In", room → Occupied.
        ───────────────────────────────────────────────────── */}
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">

          {/* Panel header */}
          <div className="flex items-center justify-between px-5 py-3.5 bg-blue-50 border-b border-blue-100">
            <div className="flex items-center gap-2.5">
              <div className="w-7 h-7 rounded-lg bg-blue-600 flex items-center justify-center flex-shrink-0">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-3.5 h-3.5 text-white">
                  <path d="M5 12h14M12 5l7 7-7 7"/>
                </svg>
              </div>
              <div>
                <h2 className="text-[13.5px] font-semibold text-blue-900 leading-none">
                  Today's Arrivals
                </h2>
                <p className="text-[11px] text-blue-500 mt-0.5">Confirmed · checking in today</p>
              </div>
            </div>
            <span className="text-[12px] font-bold text-blue-700 bg-blue-100 border border-blue-200 px-2.5 py-1 rounded-full">
              {todaysArrivals.length}
            </span>
          </div>

          {/* Cards */}
          <div className="divide-y divide-slate-100">
            {todaysArrivals.length === 0 ? (
              <EmptyState message="No arrivals scheduled for today." />
            ) : todaysArrivals.map(b => {
              const due = calcTrueDue(b);
              return (
                <div key={b.id} className="px-5 py-4">
                  <div className="flex items-start gap-3">

                    {/* Avatar */}
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 text-[10px] font-bold mt-0.5 ${avatarColor(b.guestName)}`}>
                      {initials(b.guestName)}
                    </div>

                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-slate-800 text-[13.5px] leading-snug">
                        {b.guestName}
                      </p>
                      <p className="text-[12px] text-slate-400 mt-0.5">
                        Room {b.roomNumber} · {categoryName(b.roomCategory)} · {b.nights} nt
                      </p>
                      {/* Payment indicator */}
                      <div className="flex items-center gap-1.5 mt-1.5">
                        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${paymentDot(b.payment)}`} />
                        {due > 0 ? (
                          <span className="text-[11.5px] font-semibold text-rose-600">
                            ৳{due.toLocaleString()} due at check-in
                          </span>
                        ) : (
                          <span className="text-[11.5px] font-medium text-emerald-600">
                            Fully paid
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Actions */}
                    <div className="flex flex-col gap-1.5 items-end flex-shrink-0">
                      {(() => {
                        const gated = !canCheckInToday(b.checkInISO);
                        return (
                          <button
                            onClick={gated ? undefined : () => handleCheckIn(b)}
                            disabled={gated}
                            title={gated ? `Check-in available on ${b.checkIn}` : undefined}
                            className={`flex items-center gap-1.5 text-[12px] font-semibold text-white px-3 py-1.5 rounded-lg whitespace-nowrap shadow-sm
                              ${gated ? "bg-blue-300 cursor-not-allowed opacity-60" : "bg-blue-600 hover:bg-blue-700 transition-colors"}`}
                          >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="w-3 h-3">
                              <path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><path d="M22 4L12 14.01l-3-3"/>
                            </svg>
                            Check In
                          </button>
                        );
                      })()}
                      {/* Collect Payment — admin only before check-in; staff must check in first */}
                      {due > 0 && (
                        isAdmin ? (
                          <button
                            onClick={() => openPayModal(b)}
                            title="Guest not yet checked in — verify before recording payment"
                            className="text-[11px] font-semibold text-amber-700 bg-amber-50 border border-amber-200 hover:bg-amber-100 px-2.5 py-1 rounded-lg transition-colors whitespace-nowrap"
                          >
                            + Collect Payment
                          </button>
                        ) : (
                          <p className="text-[10px] text-slate-400 italic text-right leading-tight">
                            Payment after<br/>check-in
                          </p>
                        )
                      )}
                    </div>
                  </div>

                  {/* Booking ID strip */}
                  <p className="text-[10.5px] text-slate-300 font-mono mt-2.5">{b.id}</p>
                </div>
              );
            })}
          </div>
        </div>

        {/* ─────────────────────────────────────────────────────
            PANEL B — IN-HOUSE GUESTS
            All bookings with status "Checked In".
            Action: Check Out (uses full payment gate).
                    Add Payment if due > 0.
        ───────────────────────────────────────────────────── */}
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">

          {/* Panel header */}
          <div className="flex items-center justify-between px-5 py-3.5 bg-emerald-50 border-b border-emerald-100">
            <div className="flex items-center gap-2.5">
              <div className="w-7 h-7 rounded-lg bg-emerald-600 flex items-center justify-center flex-shrink-0">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-3.5 h-3.5 text-white">
                  <path d="M2 20V9a2 2 0 012-2h16a2 2 0 012 2v11"/><path d="M2 20h20"/>
                  <path d="M12 7V4"/><path d="M9 20v-5h6v5"/>
                </svg>
              </div>
              <div>
                <h2 className="text-[13.5px] font-semibold text-emerald-900 leading-none">
                  In-House Guests
                </h2>
                <p className="text-[11px] text-emerald-600 mt-0.5">Currently checked in</p>
              </div>
            </div>
            <span className="text-[12px] font-bold text-emerald-700 bg-emerald-100 border border-emerald-200 px-2.5 py-1 rounded-full">
              {inHouseGuests.length}
            </span>
          </div>

          {/* Cards */}
          <div className="divide-y divide-slate-100">
            {inHouseGuests.length === 0 ? (
              <EmptyState message="No guests currently checked in." />
            ) : inHouseGuests.map(b => {
              const due = calcTrueDue(b);
              const isDepartingToday = b.checkOut === TODAY_FMT;
              return (
                <div
                  key={b.id}
                  className={`px-5 py-4 ${isDepartingToday ? "bg-amber-50/40" : ""}`}
                >
                  <div className="flex items-start gap-3">

                    {/* Avatar */}
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 text-[10px] font-bold mt-0.5 ${avatarColor(b.guestName)}`}>
                      {initials(b.guestName)}
                    </div>

                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="font-semibold text-slate-800 text-[13.5px] leading-snug">
                          {b.guestName}
                        </p>
                        {isDepartingToday && (
                          <span className="text-[10px] font-bold text-amber-700 bg-amber-100 border border-amber-300 px-1.5 py-0.5 rounded-full uppercase tracking-wide">
                            Departs today
                          </span>
                        )}
                      </div>
                      <p className="text-[12px] text-slate-400 mt-0.5">
                        Room {b.roomNumber} · {categoryName(b.roomCategory)} · {b.nights} nt
                      </p>
                      <p className="text-[11.5px] text-slate-400 mt-0.5">
                        In {b.checkIn} · Out {b.checkOut}
                      </p>
                      {/* Balance indicator */}
                      <div className="flex items-center gap-1.5 mt-1.5">
                        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${paymentDot(b.payment)}`} />
                        {due > 0 ? (
                          <span className="text-[11.5px] font-semibold text-rose-600">
                            Balance due: ৳{due.toLocaleString()}
                          </span>
                        ) : (
                          <span className="text-[11.5px] font-medium text-emerald-600">
                            Fully paid
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Actions */}
                    <div className="flex flex-col gap-1.5 items-end flex-shrink-0">
                      <button
                        onClick={() => handleCheckOut(b)}
                        className="flex items-center gap-1.5 text-[12px] font-semibold px-3 py-1.5 rounded-lg transition-colors whitespace-nowrap text-slate-700 bg-slate-100 border border-slate-200 hover:bg-slate-200"
                      >
                        Check Out
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="w-3 h-3">
                          <path d="M19 12H5M12 5l7 7-7 7"/>
                        </svg>
                      </button>
                      {/* Add Payment — Panel B is In-House (Checked In), so staff can always pay here */}
                      {due > 0 && (
                        <button
                          onClick={() => openPayModal(b)}
                          className="text-[11px] font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 hover:bg-emerald-100 px-2.5 py-1 rounded-lg transition-colors whitespace-nowrap"
                        >
                          + Add Payment
                        </button>
                      )}
                    </div>
                  </div>

                  <p className="text-[10.5px] text-slate-300 font-mono mt-2.5">{b.id}</p>
                </div>
              );
            })}
          </div>
        </div>

        {/* ─────────────────────────────────────────────────────
            PANEL C — TODAY'S DEPARTURES
            Bookings with checkOut = today, not yet done.
            Cards tinted rose when balance is still due — staff
            know they must collect before releasing the guest.
        ───────────────────────────────────────────────────── */}
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">

          {/* Panel header */}
          <div className="flex items-center justify-between px-5 py-3.5 bg-amber-50 border-b border-amber-100">
            <div className="flex items-center gap-2.5">
              <div className="w-7 h-7 rounded-lg bg-amber-500 flex items-center justify-center flex-shrink-0">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-3.5 h-3.5 text-white">
                  <path d="M19 12H5M12 5l7 7-7 7"/>
                </svg>
              </div>
              <div>
                <h2 className="text-[13.5px] font-semibold text-amber-900 leading-none">
                  Today's Departures
                </h2>
                <p className="text-[11px] text-amber-600 mt-0.5">Check-out date is today</p>
              </div>
            </div>
            <span className="text-[12px] font-bold text-amber-700 bg-amber-100 border border-amber-200 px-2.5 py-1 rounded-full">
              {todaysDepartures.length}
            </span>
          </div>

          {/* Cards */}
          <div className="divide-y divide-slate-100">
            {todaysDepartures.length === 0 ? (
              <EmptyState message="No departures scheduled for today." />
            ) : todaysDepartures.map(b => {
              const due = calcTrueDue(b);
              return (
                <div
                  key={b.id}
                  className={`px-5 py-4 ${due > 0 ? "bg-rose-50/40" : ""}`}
                >
                  <div className="flex items-start gap-3">

                    {/* Avatar */}
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 text-[10px] font-bold mt-0.5 ${avatarColor(b.guestName)}`}>
                      {initials(b.guestName)}
                    </div>

                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-slate-800 text-[13.5px] leading-snug">
                        {b.guestName}
                      </p>
                      <p className="text-[12px] text-slate-400 mt-0.5">
                        Room {b.roomNumber} · {categoryName(b.roomCategory)} · {b.nights} nt
                      </p>
                      {/* Status + balance */}
                      <div className="flex items-center gap-2 flex-wrap mt-1.5">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold ${statusBadge(b.status)}`}>
                          {b.status}
                        </span>
                        {due > 0 ? (
                          <span className="text-[11.5px] font-bold text-rose-600">
                            Due: ৳{due.toLocaleString()}
                          </span>
                        ) : (
                          <span className="text-[11.5px] font-medium text-emerald-600">
                            ✓ Settled
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Actions */}
                    <div className="flex flex-col gap-1.5 items-end flex-shrink-0">
                      {b.status === "Checked In" && (
                        <button
                          onClick={() => handleCheckOut(b)}
                          className="flex items-center gap-1.5 text-[12px] font-semibold px-3 py-1.5 rounded-lg transition-colors whitespace-nowrap text-slate-700 bg-slate-100 border border-slate-200 hover:bg-slate-200"
                        >
                          Check Out
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="w-3 h-3">
                            <path d="M19 12H5M12 5l7 7-7 7"/>
                          </svg>
                        </button>
                      )}
                      {/* Settle Balance — apply same role/status rule as elsewhere */}
                      {due > 0 && (() => {
                        const checkedIn = b.status === "Checked In";
                        if (!isAdmin && !checkedIn) {
                          return (
                            <p className="text-[10px] text-slate-400 italic text-right leading-tight">
                              Payment after<br/>check-in
                            </p>
                          );
                        }
                        const warnAdmin = isAdmin && !checkedIn;
                        return (
                          <button
                            onClick={() => openPayModal(b)}
                            title={warnAdmin ? "Guest not yet checked in — verify before recording payment" : undefined}
                            className={`text-[11px] font-semibold px-2.5 py-1 rounded-lg transition-colors whitespace-nowrap ${
                              warnAdmin
                                ? "text-amber-700 bg-amber-50 border border-amber-200 hover:bg-amber-100"
                                : "text-emerald-700 bg-emerald-50 border border-emerald-200 hover:bg-emerald-100"
                            }`}
                          >
                            + Settle Balance
                          </button>
                        );
                      })()}
                    </div>
                  </div>

                  <p className="text-[10.5px] text-slate-300 font-mono mt-2.5">{b.id}</p>
                </div>
              );
            })}
          </div>
        </div>

      </div>{/* end grid */}

      {/* ══════════════════════════════════════════════════════
          CHECKOUT CONFIRMATION MODAL
          Shown for EVERY checkout — full billing summary with
          charge type/amount/note fields, inline payment, and
          admin override when finalPayable > 0.
      ══════════════════════════════════════════════════════ */}
      {checkoutConfirm && (() => {
        const extraChargeAmt     = parseFloat(chargeAmount) || 0;
        const moreDiscountAmtNum = parseFloat(moreDiscountAmt) || 0;
        const { totalDays: earlyDays, totalAmt: earlyDeductionAmt } =
          calcBookingLevelDeductions(checkoutConfirm.rooms ?? [], checkoutOpenedAt ?? new Date());
        const finalTotal                = checkoutConfirm.totalAmount + extraChargeAmt;
        const finalPayableBeforeModalPay = finalTotal - earlyDeductionAmt - moreDiscountAmtNum - liveAmountPaid;
        const modalPayAmtNum            = parseFloat(modalPayAmt) || 0;
        const finalPayable              = finalPayableBeforeModalPay - modalPayAmtNum;
        const isOverpayment             = modalPayAmtNum > Math.max(0, finalPayableBeforeModalPay);
        const canOverride               = isAdmin;
        const payStatus                 = derivePaymentStatus(checkoutConfirm.totalAmount, liveAmountPaid, checkoutConfirm.status);
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
                    <p className="text-[12px] text-slate-500">Room {checkoutConfirm.roomNumber} · {categoryName(checkoutConfirm.roomCategory)} · {checkoutConfirm.nights} nt</p>
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
                    {/* Charge type + amount */}
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
                        Enter the payment amount to collect from the guest. It will be recorded when you confirm checkout.
                      </p>
                      <div>
                        <label htmlFor="checkoutPayMethod" className="block text-[11.5px] font-semibold text-slate-500 mb-1 uppercase tracking-wide">
                          Payment Method
                        </label>
                        <select
                          id="checkoutPayMethod"
                          value={checkoutPayMethod}
                          onChange={e => setCheckoutPayMethod(e.target.value as PaymentMethod)}
                          className="w-full px-3 py-2.5 text-[13.5px] text-slate-800 bg-white border border-emerald-200 rounded-lg
                            focus:outline-none focus:ring-2 focus:ring-emerald-400 focus:border-transparent transition appearance-none cursor-pointer"
                        >
                          {PAYMENT_METHODS.map(m => (
                            <option key={m} value={m}>{PAYMENT_METHOD_LABELS[m]}</option>
                          ))}
                        </select>
                      </div>
                      <div className="relative">
                        <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 font-semibold pointer-events-none">৳</span>
                        <input
                          type="number"
                          min={0.01}
                          step="0.01"
                          max={Math.max(0, finalPayableBeforeModalPay)}
                          placeholder="0.00"
                          value={modalPayAmt}
                          onChange={e => { setModalPayAmt(e.target.value); setModalPayError(""); }}
                          onWheel={e => (e.target as HTMLInputElement).blur()}
                          className="w-full pl-7 pr-3.5 py-2.5 text-[13.5px] text-slate-800 bg-white border border-emerald-200 rounded-lg
                            placeholder:text-slate-300 focus:outline-none focus:ring-2 focus:ring-emerald-400 focus:border-transparent transition
                            [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                          autoFocus
                        />
                      </div>
                      {(isOverpayment || modalPayError) && (
                        <p className="text-[11.5px] text-rose-600">
                          {isOverpayment
                            ? `Cannot exceed outstanding balance of ৳${finalPayableBeforeModalPay.toLocaleString()}.`
                            : modalPayError}
                        </p>
                      )}
                      {!isOverpayment && finalPayableBeforeModalPay > 0 && (
                        <p className="text-[11.5px] text-emerald-700">
                          Max: <span className="font-bold">৳{finalPayableBeforeModalPay.toLocaleString()}</span> outstanding
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
                        {isAdmin ? "Admin" : "Staff"}
                      </span>
                      {!isAdmin && (
                        <span className="text-[11.5px] text-slate-400 italic">Admin access required</span>
                      )}
                    </div>

                    <form onSubmit={e => { e.preventDefault(); handleAdminOverride(); }}>
                      <label className="block text-[12px] font-semibold text-slate-600 mb-1.5 uppercase tracking-wide">
                        Override Reason
                        <span className="ml-1 font-normal normal-case text-slate-400">(required for audit log)</span>
                      </label>
                      <textarea
                        rows={2}
                        placeholder={canOverride
                          ? "e.g. Guest settling via bank transfer, confirmed by manager."
                          : "Admin access is required to override."}
                        value={overrideReason}
                        onChange={e => { setOverrideReason(e.target.value); setOverrideError(""); }}
                        disabled={!canOverride}
                        className={`w-full px-3.5 py-2.5 text-[13px] text-slate-800 bg-white border rounded-lg resize-none mb-3
                          placeholder:text-slate-300 focus:outline-none focus:ring-2 focus:ring-amber-400 focus:border-transparent transition
                          ${!canOverride ? "bg-slate-50 cursor-not-allowed text-slate-400" : "border-slate-200"}`}
                      />
                      {overrideError && <p className="mb-3 text-[11.5px] text-rose-600">{overrideError}</p>}
                      <div className="flex items-center justify-end gap-3">
                        <button type="button" onClick={closeCheckoutConfirm}
                          className="px-4 py-2.5 text-[13px] font-medium text-slate-600 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg transition-colors">
                          Cancel
                        </button>
                        <button type="submit" disabled={!canOverride || isOverpayment}
                          className={`flex items-center gap-2 px-5 py-2.5 text-[13px] font-semibold rounded-lg transition-colors shadow-sm ${
                            canOverride && !isOverpayment
                              ? "text-white bg-amber-500 hover:bg-amber-600"
                              : "text-slate-400 bg-slate-100 border border-slate-200 cursor-not-allowed"
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
                  <div>
                    {isOverpayment && (
                      <p className="mb-3 text-[11.5px] text-rose-600">
                        Payment amount exceeds outstanding balance of ৳{finalPayableBeforeModalPay.toLocaleString()}. Reduce the payment amount.
                      </p>
                    )}
                    <div className="flex items-center justify-end gap-3 pt-1">
                      <button type="button" onClick={closeCheckoutConfirm}
                        className="px-4 py-2.5 text-[13px] font-medium text-slate-600 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg transition-colors">
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={() => handleConfirmCheckout()}
                        disabled={isOverpayment}
                        className={`flex items-center gap-2 px-5 py-2.5 text-[13px] font-semibold rounded-lg transition-colors shadow-sm ${
                          isOverpayment
                            ? "text-slate-400 bg-slate-100 border border-slate-200 cursor-not-allowed"
                            : "text-white bg-slate-800 hover:bg-slate-900"
                        }`}
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-4 h-4">
                          <path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><path d="M22 4L12 14.01l-3-3"/>
                        </svg>
                        Confirm Check-out
                      </button>
                    </div>
                  </div>
                )}

              </div>
            </div>
          </div>
        );
      })()}

      {/* ══════════════════════════════════════════════════════
          ADD PAYMENT MODAL
          Same as BookingsClient — validates amount, calls
          recordPayment() in HotelContext.
      ══════════════════════════════════════════════════════ */}
      {payModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm"
          onClick={e => { if (e.target === e.currentTarget) closePayModal(); }}
        >
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">

            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 bg-slate-50">
              <div className="flex items-center gap-2.5">
                <div className="w-7 h-7 rounded-lg bg-emerald-600 flex items-center justify-center">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-3.5 h-3.5 text-white">
                    <path d="M12 5v14M5 12h14"/>
                  </svg>
                </div>
                <div>
                  <h2 className="text-[14px] font-semibold text-slate-800 leading-none">Record Payment</h2>
                  <p className="text-[11.5px] text-slate-400 mt-0.5 font-mono">{payModal.id}</p>
                </div>
              </div>
              <button onClick={closePayModal} className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-200 rounded-lg transition-colors">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-4 h-4">
                  <path d="M18 6L6 18M6 6l12 12"/>
                </svg>
              </button>
            </div>

            <div className="px-6 pt-5 pb-4">

              {/* Guest info */}
              <div className="flex items-center gap-3 mb-5">
                <div className={`w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 text-[11px] font-bold ${avatarColor(payModal.guestName)}`}>
                  {initials(payModal.guestName)}
                </div>
                <div>
                  <p className="text-[13.5px] font-semibold text-slate-800">{payModal.guestName}</p>
                  <p className="text-[12px] text-slate-400">
                    Room {payModal.roomNumber} · {categoryName(payModal.roomCategory)}
                  </p>
                </div>
              </div>

              {/* Not-checked-in banner — warning for admin, block for staff */}
              {payModal.status !== "Checked In" && (
                isAdmin ? (
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
                  <label htmlFor="payMethod" className="block text-[12px] font-semibold text-slate-600 mb-1.5 uppercase tracking-wide">
                    Payment Method
                  </label>
                  <select
                    id="payMethod"
                    value={payMethod}
                    onChange={e => setPayMethod(e.target.value as PaymentMethod)}
                    className="w-full px-3 py-2.5 text-[14px] font-semibold text-slate-800 bg-white border border-slate-200 rounded-lg
                      focus:outline-none focus:ring-2 focus:ring-emerald-400 focus:border-transparent transition appearance-none cursor-pointer"
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
                    <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 font-semibold pointer-events-none">৳</span>
                    <input
                      type="number"
                      min={0.01}
                      step="0.01"
                      max={calcTrueDue(payModal)}
                      placeholder="0.00"
                      value={payAmount}
                      onChange={e => { setPayAmount(e.target.value); if (payError) setPayError(""); }}
                      autoFocus
                      className={`w-full pl-7 pr-3.5 py-2.5 text-[14px] font-semibold text-slate-800 bg-white border rounded-lg
                        placeholder:text-slate-300 focus:outline-none focus:ring-2 focus:ring-emerald-400 focus:border-transparent transition
                        ${payError ? "border-rose-300 bg-rose-50" : "border-slate-200"}`}
                    />
                  </div>
                  {payError && <p className="mt-1.5 text-[11.5px] text-rose-600">{payError}</p>}
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
                </div>

                {/* Live preview */}
                {payAmount && parseFloat(payAmount) > 0 && parseFloat(payAmount) <= calcTrueDue(payModal) && (
                  <div className="mb-4 flex items-center gap-3 bg-slate-50 border border-slate-200 rounded-lg px-4 py-2.5">
                    <p className="text-[12px] text-slate-500 flex-1">After this payment:</p>
                    <p className="text-[12px] font-semibold text-emerald-700">
                      ৳{(payModal.amountPaid + parseFloat(payAmount)).toLocaleString()} paid
                    </p>
                    <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${
                      derivePaymentStatus(payModal.totalAmount, payModal.amountPaid + parseFloat(payAmount), payModal.status) === "Paid"
                        ? "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200"
                        : "bg-blue-50 text-blue-700 ring-1 ring-blue-200"
                    }`}>
                      {derivePaymentStatus(payModal.totalAmount, payModal.amountPaid + parseFloat(payAmount), payModal.status)}
                    </span>
                  </div>
                )}

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

      <ConfirmDialog
        open={!!confirm}
        title={confirm?.title ?? ""}
        message={confirm?.message ?? ""}
        confirmLabel={confirm?.confirmLabel ?? "Confirm"}
        tone={confirm?.tone ?? "normal"}
        busy={confirmBusy}
        onCancel={() => { if (!confirmBusy) setConfirm(null); }}
        onConfirm={async () => {
          if (!confirm) return;
          setConfirmBusy(true);
          try { await confirm.onConfirm(); } finally { setConfirmBusy(false); setConfirm(null); }
        }}
      />

    </div>
  );
}

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
  type MockBooking as Booking,
  type AdditionalGuest,
} from "@/lib/mockData";

// ─────────────────────────────────────────────────────────────
// LOCAL TYPES
// ─────────────────────────────────────────────────────────────
type FormData = {
  guest:            string;
  phone:            string;
  room:             string;
  checkIn:          string;
  checkOut:         string;
  status:           BookingStatus;
  totalGuests:      number;
  additionalGuests: AdditionalGuest[];
  // Payment fields — stored as strings so <input> bindings are simple
  totalAmount:      string;   // total charge; auto-filled from room×nights, editable
  amountPaid:       string;   // deposit/payment collected at booking time
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

const EMPTY_FORM: FormData = {
  guest: "", phone: "", room: "", checkIn: "", checkOut: "",
  status: "Confirmed", totalGuests: 1, additionalGuests: [],
  totalAmount: "", amountPaid: "0",
};

// Next workflow action per booking status
type ActionDef = { label: string; next: BookingStatus; style: string } | null;
function nextAction(status: BookingStatus): ActionDef {
  if (status === "Confirmed")  return { label: "Check In",  next: "Checked In",  style: "bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100" };
  if (status === "Checked In") return { label: "Check Out", next: "Checked Out", style: "bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100" };
  return null;
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
    createBooking, changeBookingStatus, checkoutWithOverride, recordPayment,
  } = useHotel();

  // Real role from authenticated session
  const { role } = useAuth();
  const isAdmin = role === "admin";

  // ── Local UI state ─────────────────────────────────────────
  const [formOpen,     setFormOpen]     = useState<boolean>(!!initialRoom);
  const [form,         setForm]         = useState<FormData>({ ...EMPTY_FORM, room: initialRoom ?? "" });
  const [errors,       setErrors]       = useState<Partial<Record<keyof FormData, string>>>({});
  const [successMsg,   setSuccessMsg]   = useState<string>("");
  const [activeFilter, setActiveFilter] = useState<string>("All");

  // ── Payment modal state ─────────────────────────────────────
  // payModal holds the booking being paid against; null = modal closed.
  const [payModal,     setPayModal]     = useState<Booking | null>(null);
  const [payAmount,    setPayAmount]    = useState<string>("");
  const [payError,     setPayError]     = useState<string>("");

  // ── Blocked-checkout modal state ────────────────────────────
  // Set to the booking when a checkout is attempted with an outstanding balance.
  const [checkoutBlock,   setCheckoutBlock]   = useState<Booking | null>(null);
  const [overrideReason,  setOverrideReason]  = useState<string>("");
  const [overrideError,   setOverrideError]   = useState<string>("");

  // ── Timeline modal ───────────────────────────────────────────
  // null = closed; set to a booking to show that booking's full timeline.
  const [timelineModal, setTimelineModal] = useState<Booking | null>(null);

  // ── Page view ───────────────────────────────────────────────
  // "bookings" = full booking list (existing)
  // "dues"     = outstanding-dues monitor (new)
  const [pageView,  setPageView]  = useState<"bookings" | "dues">("bookings");
  const [dueFilter, setDueFilter] = useState<"all" | "inhouse" | "checkedout">("all");

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

  // Payment derived values (updated live as the user types)
  const totalAmountNum  = parseFloat(form.totalAmount) || 0;
  const amountPaidNum   = parseFloat(form.amountPaid)  || 0;
  const dueAmount       = Math.max(0, totalAmountNum - amountPaidNum);
  const formPayStatus   = derivePaymentStatus(totalAmountNum, amountPaidNum);

  const filteredBookings =
    activeFilter === "All" ? bookings : bookings.filter(b => b.status === activeFilter);

  const counts: Record<string, number> = {
    All:           bookings.length,
    Confirmed:     bookings.filter(b => b.status === "Confirmed").length,
    "Checked In":  bookings.filter(b => b.status === "Checked In").length,
    "Checked Out": bookings.filter(b => b.status === "Checked Out").length,
    Cancelled:     bookings.filter(b => b.status === "Cancelled").length,
  };

  // ── Dues view derived values ────────────────────────────────
  // All bookings with any outstanding balance, regardless of status.
  const dueBookings = useMemo(
    () => bookings.filter(b => b.totalAmount - b.amountPaid > 0),
    [bookings]
  );

  const filteredDueBookings = useMemo(() => {
    if (dueFilter === "inhouse")    return dueBookings.filter(b => b.status === "Confirmed" || b.status === "Checked In");
    if (dueFilter === "checkedout") return dueBookings.filter(b => b.status === "Checked Out");
    return dueBookings;
  }, [dueBookings, dueFilter]);

  const totalOutstanding = useMemo(
    () => dueBookings.reduce((sum, b) => sum + (b.totalAmount - b.amountPaid), 0),
    [dueBookings]
  );
  const dueInHouseCount     = dueBookings.filter(b => b.status === "Confirmed" || b.status === "Checked In").length;
  const dueCheckedOutCount  = dueBookings.filter(b => b.status === "Checked Out").length;
  const dueOverrideCount    = dueBookings.filter(b => b.checkoutOverride?.used).length;

  // Threshold above which a due amount is flagged as "high" with an extra icon
  const HIGH_DUE_THRESHOLD = 500;

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

  // Close blocked-checkout modal on Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") closeCheckoutBlock();
    }
    if (checkoutBlock) document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [checkoutBlock]);

  // Close timeline modal on Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setTimelineModal(null);
    }
    if (timelineModal) document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [timelineModal]);

  // Auto-fill totalAmount from room rate × nights whenever either changes.
  // Staff can always type over it for special/corporate rates.
  useEffect(() => {
    if (roomInfo && nights > 0) {
      setForm(prev => ({ ...prev, totalAmount: String(roomInfo.price * nights) }));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomInfo?.price, nights]);

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
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  // ── Submit ─────────────────────────────────────────────────
  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validate()) return;

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

    const newBooking: Booking = {
      id:               `BK-${nextBookingId}`,
      guestName:        form.guest.trim(),
      phone:            form.phone.trim() || "—",
      roomNumber:       form.room.trim(),
      roomCategory:     info?.category ?? "Unknown",
      checkIn:          formatDate(form.checkIn),
      checkOut:         formatDate(form.checkOut),
      nights:           n,
      status:           form.status,
      payment:          derivePaymentStatus(resolvedTotal, resolvedPaid),
      totalAmount:      resolvedTotal,
      amountPaid:       resolvedPaid,
      // Ensure count is never less than actual named guests + primary
      totalGuests:      Math.max(form.totalGuests, cleanedExtras.length + 1),
      additionalGuests: cleanedExtras,
      createdAt:        new Date().toISOString(),
      isNew:            true,
    };

    createBooking(newBooking);

    const guestSummary = cleanedExtras.length > 0
      ? ` · ${newBooking.totalGuests} guests total`
      : "";
    const paymentSummary = resolvedPaid > 0
      ? ` · $${resolvedPaid.toLocaleString()} paid`
      : " · payment pending";
    setSuccessMsg(
      `Booking ${newBooking.id} created for ${newBooking.guestName}${guestSummary}${paymentSummary} · Room ${newBooking.roomNumber} is now Reserved`
    );
    setForm(EMPTY_FORM);
    setFormOpen(false);
    setActiveFilter("All");
  }

  function handleCancel() {
    setForm({ ...EMPTY_FORM, room: initialRoom ?? "" });
    setErrors({});
    setFormOpen(false);
  }

  // ── Payment modal handlers ──────────────────────────────────

  function openPayModal(booking: Booking) {
    setPayModal(booking);
    setPayAmount("");
    setPayError("");
  }

  function closePayModal() {
    setPayModal(null);
    setPayAmount("");
    setPayError("");
  }

  // ── Workflow action handler ─────────────────────────────────
  /**
   * Called whenever the "Check In" or "Check Out" button is clicked.
   * For "Check Out" with an outstanding balance → intercept and show the
   * blocked-checkout modal instead of proceeding directly.
   * All other workflow transitions pass through unchanged.
   */
  function handleWorkflowAction(booking: Booking, nextStatus: BookingStatus) {
    const due = booking.totalAmount - booking.amountPaid;
    if (nextStatus === "Checked Out" && due > 0) {
      setCheckoutBlock(booking);
      setOverrideReason("");
      setOverrideError("");
    } else {
      changeBookingStatus(booking.id, nextStatus);
    }
  }

  // ── Blocked-checkout modal handlers ────────────────────────
  function closeCheckoutBlock() {
    setCheckoutBlock(null);
    setOverrideReason("");
    setOverrideError("");
  }

  function handleAdminOverride(e: React.FormEvent) {
    e.preventDefault();
    if (!checkoutBlock) return;
    if (!isAdmin) {
      setOverrideError("Only admins can use this override.");
      return;
    }
    checkoutWithOverride(checkoutBlock.id, overrideReason);
    const due = checkoutBlock.totalAmount - checkoutBlock.amountPaid;
    setSuccessMsg(
      `Admin override: Booking ${checkoutBlock.id} checked out with $${due.toLocaleString()} still outstanding.`
    );
    closeCheckoutBlock();
  }

  function handlePaySubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!payModal) return;

    const amount = parseFloat(payAmount);
    const due    = payModal.totalAmount - payModal.amountPaid;

    if (!payAmount.trim() || isNaN(amount) || amount <= 0) {
      setPayError("Please enter a valid payment amount greater than $0.");
      return;
    }
    if (amount > due) {
      setPayError(
        `Amount cannot exceed the outstanding balance of $${due.toLocaleString()}. ` +
        `Enter $${due.toLocaleString()} or less.`
      );
      return;
    }

    recordPayment(payModal.id, amount);
    setSuccessMsg(
      `Payment of $${amount.toLocaleString()} recorded for booking ${payModal.id} · ` +
      `$${(payModal.amountPaid + amount).toLocaleString()} now paid of $${payModal.totalAmount.toLocaleString()}`
    );
    closePayModal();
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
                  min={TODAY}
                  value={form.checkIn}
                  onChange={e => setField("checkIn", e.target.value)}
                  className={`w-full px-3.5 py-2.5 text-[13.5px] text-slate-800 bg-white border rounded-lg
                    focus:outline-none focus:ring-2 focus:ring-amber-400 focus:border-transparent transition
                    ${errors.checkIn ? "border-rose-300 bg-rose-50" : "border-slate-200"}`}
                />
                {errors.checkIn && <p className="mt-1 text-[11.5px] text-rose-600">{errors.checkIn}</p>}
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

            {/* ── Section 3: Payment ── */}
            <div className="px-6 pb-5">

              {/* Section separator */}
              <div className="flex items-center gap-3 mb-5">
                <span className="text-[11px] font-bold text-slate-400 uppercase tracking-widest whitespace-nowrap">
                  Payment
                </span>
                <div className="flex-1 h-px bg-slate-100" />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">

                {/* Total Amount */}
                <div>
                  <label className="block text-[12px] font-semibold text-slate-600 mb-1.5 uppercase tracking-wide">
                    Total Amount (USD)
                  </label>
                  <div className="relative">
                    <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 font-semibold pointer-events-none">
                      $
                    </span>
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      placeholder="0.00"
                      value={form.totalAmount}
                      onChange={e => setField("totalAmount", e.target.value)}
                      className="w-full pl-7 pr-3.5 py-2.5 text-[13.5px] text-slate-800 bg-white border border-slate-200 rounded-lg
                        placeholder:text-slate-300 focus:outline-none focus:ring-2 focus:ring-amber-400 focus:border-transparent transition"
                    />
                  </div>
                  <p className="mt-1 text-[11.5px] text-slate-400">
                    Auto-filled from room rate × nights. Adjust for packages or discounts.
                  </p>
                </div>

                {/* Amount Paid */}
                <div>
                  <label className="block text-[12px] font-semibold text-slate-600 mb-1.5 uppercase tracking-wide">
                    Amount Paid at Booking
                  </label>
                  <div className="relative">
                    <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 font-semibold pointer-events-none">
                      $
                    </span>
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      placeholder="0.00"
                      value={form.amountPaid}
                      onChange={e => setField("amountPaid", e.target.value)}
                      className="w-full pl-7 pr-3.5 py-2.5 text-[13.5px] text-slate-800 bg-white border border-slate-200 rounded-lg
                        placeholder:text-slate-300 focus:outline-none focus:ring-2 focus:ring-amber-400 focus:border-transparent transition"
                    />
                  </div>
                  <p className="mt-1 text-[11.5px] text-slate-400">
                    Deposit or full payment collected now. Leave 0 if nothing paid yet.
                  </p>
                </div>

                {/* Due Amount + Payment Status — read-only, auto-computed */}
                <div className="sm:col-span-2 flex flex-wrap items-center gap-6 bg-slate-50 border border-slate-200 rounded-lg px-5 py-3.5">

                  {/* Due */}
                  <div>
                    <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-0.5">
                      Due Amount
                    </p>
                    <p className={`text-[18px] font-bold ${dueAmount > 0 ? "text-rose-600" : "text-emerald-600"}`}>
                      ${dueAmount.toLocaleString()}
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
                      <p className="text-[18px] font-bold text-slate-800">${roomInfo.price}</p>
                    </div>
                  </>
                )}
                {estimatedTotal != null && (
                  <>
                    <div className="h-8 w-px bg-slate-200" />
                    <div className="text-center">
                      <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Total</p>
                      <p className="text-[18px] font-bold text-slate-800">${totalAmountNum > 0 ? totalAmountNum.toLocaleString() : estimatedTotal.toLocaleString()}</p>
                    </div>
                    <div className="h-8 w-px bg-slate-200" />
                    <div className="text-center">
                      <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Paid</p>
                      <p className="text-[18px] font-bold text-emerald-600">${amountPaidNum.toLocaleString()}</p>
                    </div>
                    <div className="h-8 w-px bg-slate-200" />
                    <div className="text-center">
                      <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Due</p>
                      <p className={`text-[18px] font-bold ${dueAmount > 0 ? "text-rose-600" : "text-emerald-600"}`}>
                        ${dueAmount.toLocaleString()}
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
                    No bookings match this filter.
                  </td>
                </tr>
              ) : filteredBookings.map((b) => {
                const action  = nextAction(b.status);
                const due     = b.totalAmount - b.amountPaid;
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
                      ${b.totalAmount.toLocaleString()}
                    </td>

                    {/* Amount Paid */}
                    <td className="px-5 py-3.5 whitespace-nowrap">
                      <span className={`font-semibold ${b.amountPaid > 0 ? "text-emerald-700" : "text-slate-400"}`}>
                        {b.amountPaid > 0 ? `$${b.amountPaid.toLocaleString()}` : "—"}
                      </span>
                    </td>

                    {/* Due Amount */}
                    <td className="px-5 py-3.5 whitespace-nowrap">
                      {due > 0 ? (
                        <span className="font-semibold text-rose-600">${due.toLocaleString()}</span>
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

                    {/* Action — workflow step + payment collection */}
                    <td className="px-5 py-3.5">
                      <div className="flex flex-col gap-1.5 items-start">
                        {/* Booking workflow: Check In → Check Out
                            Check Out is intercepted by handleWorkflowAction
                            when there is an outstanding balance. */}
                        {action && (
                          <button
                            onClick={() => handleWorkflowAction(b, action.next)}
                            className={`text-[11.5px] font-semibold border px-3 py-1.5 rounded-lg transition-colors whitespace-nowrap ${action.style}`}
                          >
                            {action.label}
                          </button>
                        )}
                        {/* Payment collection — visible whenever there is an outstanding balance */}
                        {due > 0 && (
                          <button
                            onClick={() => openPayModal(b)}
                            className="inline-flex items-center gap-1.5 text-[11.5px] font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 hover:bg-emerald-100 px-3 py-1.5 rounded-lg transition-colors whitespace-nowrap"
                          >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="w-3 h-3">
                              <path d="M12 5v14M5 12h14"/>
                            </svg>
                            Add Payment
                          </button>
                        )}
                        {/* Timeline — always available for every booking */}
                        <button
                          onClick={() => setTimelineModal(b)}
                          className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-400 hover:text-amber-600 transition-colors mt-0.5"
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-3 h-3 flex-shrink-0">
                            <circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>
                          </svg>
                          Timeline
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="px-5 py-3 border-t border-slate-100 bg-slate-50 flex items-center justify-between">
          <p className="text-[12px] text-slate-400">
            Showing {filteredBookings.length} of {bookings.length} bookings
          </p>
          <p className="text-[12px] font-semibold text-slate-600">
            {activeFilter === "All" ? `${bookings.length} total` : `${filteredBookings.length} ${activeFilter}`}
          </p>
        </div>
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
                <span className="font-bold">${totalOutstanding.toLocaleString()}</span>. Use "Add Payment" on each row to record payments received.
              </p>
            </div>
          )}

          {/* ── Summary stat cards ─────────────────────────────── */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">

            {/* Total Outstanding */}
            <div className="bg-white border border-rose-200 rounded-xl px-5 py-4 shadow-sm">
              <p className="text-[11px] font-semibold text-rose-400 uppercase tracking-wider mb-1.5">Total Outstanding</p>
              <p className="text-[26px] font-bold text-rose-600 leading-none">${totalOutstanding.toLocaleString()}</p>
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
                    {["ID", "Primary Guest", "Room", "Check-in", "Check-out", "Booking Status", "Total", "Paid", "Due", "Payment", "Override", "Action"].map(h => (
                      <th key={h} className="text-left px-5 py-3 text-[11px] font-semibold text-rose-400 uppercase tracking-wider whitespace-nowrap">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredDueBookings.length === 0 ? (
                    <tr>
                      <td colSpan={12} className="px-5 py-14 text-center">
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
                    const due       = b.totalAmount - b.amountPaid;
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
                          ${b.totalAmount.toLocaleString()}
                        </td>

                        {/* Paid */}
                        <td className="px-5 py-3.5 whitespace-nowrap">
                          <span className={`font-semibold ${b.amountPaid > 0 ? "text-emerald-700" : "text-slate-400"}`}>
                            {b.amountPaid > 0 ? `$${b.amountPaid.toLocaleString()}` : "—"}
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
                              ${due.toLocaleString()}
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

                        {/* Add Payment */}
                        <td className="px-5 py-3.5">
                          <button
                            onClick={() => openPayModal(b)}
                            className="inline-flex items-center gap-1.5 text-[11.5px] font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 hover:bg-emerald-100 px-3 py-1.5 rounded-lg transition-colors whitespace-nowrap"
                          >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="w-3 h-3">
                              <path d="M12 5v14M5 12h14"/>
                            </svg>
                            Add Payment
                          </button>
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
                ${filteredDueBookings.reduce((s, b) => s + (b.totalAmount - b.amountPaid), 0).toLocaleString()} outstanding in this view
              </p>
            </div>
          </div>

        </>
      )}

      {/* ══════════════════════════════════════════════════════
          BLOCKED CHECKOUT MODAL
          Fires when "Check Out" is clicked on a booking that still
          has an outstanding balance (due > 0).
          Staff → see the warning and can only cancel.
          Admin → can enter a reason and force the checkout through
                  via checkoutWithOverride() in HotelContext.
          TODO: Replace the role check here with a real permission
                guard once auth/RBAC is implemented.
      ══════════════════════════════════════════════════════ */}
      {checkoutBlock && (() => {
        const due = checkoutBlock.totalAmount - checkoutBlock.amountPaid;
        return (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
            onClick={e => { if (e.target === e.currentTarget) closeCheckoutBlock(); }}
          >
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">

              {/* Modal header — amber warning tone */}
              <div className="flex items-center justify-between px-6 py-4 border-b border-amber-200 bg-amber-50">
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-lg bg-amber-500 flex items-center justify-center flex-shrink-0">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-4 h-4 text-white">
                      <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
                      <path d="M12 9v4M12 17h.01"/>
                    </svg>
                  </div>
                  <div>
                    <h2 className="text-[14px] font-bold text-amber-900 leading-none">
                      Checkout Blocked
                    </h2>
                    <p className="text-[11.5px] text-amber-700 mt-0.5 font-mono">
                      {checkoutBlock.id}
                    </p>
                  </div>
                </div>
                <button
                  onClick={closeCheckoutBlock}
                  className="p-1.5 text-amber-500 hover:text-amber-800 hover:bg-amber-100 rounded-lg transition-colors"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-4 h-4">
                    <path d="M18 6L6 18M6 6l12 12"/>
                  </svg>
                </button>
              </div>

              <div className="px-6 py-5">

                {/* Guest summary */}
                <div className="flex items-center gap-3 mb-5">
                  <div className={`w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 text-[11px] font-bold ${avatarColor(checkoutBlock.guestName)}`}>
                    {initials(checkoutBlock.guestName)}
                  </div>
                  <div>
                    <p className="text-[13.5px] font-semibold text-slate-800">{checkoutBlock.guestName}</p>
                    <p className="text-[12px] text-slate-400">
                      Room {checkoutBlock.roomNumber} · {checkoutBlock.roomCategory} · {checkoutBlock.nights} night{checkoutBlock.nights !== 1 ? "s" : ""}
                    </p>
                  </div>
                </div>

                {/* Outstanding balance tile */}
                <div className="flex items-center gap-4 bg-rose-50 border border-rose-200 rounded-xl px-5 py-4 mb-5">
                  <div className="flex-shrink-0 w-9 h-9 rounded-full bg-rose-100 flex items-center justify-center">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-4 h-4 text-rose-600">
                      <path d="M12 5v14M5 12h14"/>
                    </svg>
                  </div>
                  <div className="flex-1">
                    <p className="text-[12px] font-semibold text-rose-700 uppercase tracking-wide">Outstanding Balance</p>
                    <p className="text-[22px] font-bold text-rose-600 leading-none mt-0.5">${due.toLocaleString()}</p>
                    <p className="text-[11.5px] text-rose-500 mt-0.5">
                      ${checkoutBlock.amountPaid.toLocaleString()} paid of ${checkoutBlock.totalAmount.toLocaleString()} total
                    </p>
                  </div>
                </div>

                {/* Policy explanation */}
                <div className="bg-slate-50 border border-slate-200 rounded-lg px-4 py-3.5 mb-5 space-y-2">
                  <div className="flex items-start gap-2">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-4 h-4 text-slate-500 flex-shrink-0 mt-0.5">
                      <circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>
                    </svg>
                    <p className="text-[12.5px] text-slate-700 font-medium leading-relaxed">
                      This guest has an unpaid balance. Checkout cannot be completed until the account is settled.
                    </p>
                  </div>
                  <div className="flex items-start gap-2">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-4 h-4 text-slate-400 flex-shrink-0 mt-0.5">
                      <rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/>
                    </svg>
                    <p className="text-[12px] text-slate-500 leading-relaxed">
                      <span className="font-semibold text-slate-700">Staff</span> cannot bypass this block.
                      {" "}<span className="font-semibold text-slate-700">Admin</span> can override with a stated reason — the override will be logged on the booking.
                    </p>
                  </div>
                </div>

                {/* Role indicator — real role from auth */}
                <div className="flex items-center gap-2 mb-5">
                  <span className="text-[12px] text-slate-500">You are signed in as:</span>
                  <span className={`text-[12px] font-bold px-2.5 py-0.5 rounded-full capitalize ${
                    isAdmin
                      ? "bg-amber-100 text-amber-800 border border-amber-300"
                      : "bg-slate-100 text-slate-600 border border-slate-200"
                  }`}>
                    {role ?? "staff"}
                  </span>
                </div>

                {/* Override form — only active for admin */}
                <form onSubmit={handleAdminOverride}>
                  <div className="mb-4">
                    <label className="block text-[12px] font-semibold text-slate-600 mb-1.5 uppercase tracking-wide">
                      Override Reason
                      <span className="ml-1 font-normal normal-case text-slate-400">(recommended)</span>
                    </label>
                    <textarea
                      rows={2}
                      placeholder={
                        isAdmin
                          ? "e.g. Guest settling balance via bank transfer on arrival, confirmed by manager."
                          : "Only admins can use this override."
                      }
                      value={overrideReason}
                      onChange={e => { setOverrideReason(e.target.value); setOverrideError(""); }}
                      disabled={!isAdmin}
                      className={`w-full px-3.5 py-2.5 text-[13px] text-slate-800 bg-white border rounded-lg resize-none
                        placeholder:text-slate-300 focus:outline-none focus:ring-2 focus:ring-amber-400 focus:border-transparent transition
                        ${!isAdmin ? "bg-slate-50 cursor-not-allowed text-slate-400" : "border-slate-200"}
                      `}
                    />
                    {overrideError && (
                      <div className="mt-1.5 flex items-start gap-1.5">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-3.5 h-3.5 text-rose-500 flex-shrink-0 mt-0.5">
                          <circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>
                        </svg>
                        <p className="text-[11.5px] text-rose-600">{overrideError}</p>
                      </div>
                    )}
                  </div>

                  {/* Actions */}
                  <div className="flex items-center justify-end gap-3">
                    <button
                      type="button"
                      onClick={closeCheckoutBlock}
                      className="px-4 py-2.5 text-[13px] font-medium text-slate-600 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg transition-colors"
                    >
                      Cancel
                    </button>

                    <button
                      type="submit"
                      disabled={!isAdmin}
                      title={!isAdmin ? "Only admins can use this override" : undefined}
                      className={`flex items-center gap-2 px-5 py-2.5 text-[13px] font-semibold rounded-lg transition-colors shadow-sm ${
                        isAdmin
                          ? "text-white bg-amber-500 hover:bg-amber-600"
                          : "text-slate-400 bg-slate-100 border border-slate-200 cursor-not-allowed"
                      }`}
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-4 h-4">
                        <rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/>
                      </svg>
                      Admin Override Checkout
                    </button>
                  </div>
                </form>
              </div>
            </div>
          </div>
        );
      })()}

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

              {/* Amount breakdown */}
              <div className="grid grid-cols-3 gap-3 mb-5">
                <div className="bg-slate-50 border border-slate-200 rounded-lg px-3 py-2.5 text-center">
                  <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1">Total</p>
                  <p className="text-[15px] font-bold text-slate-800">${payModal.totalAmount.toLocaleString()}</p>
                </div>
                <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2.5 text-center">
                  <p className="text-[10px] font-semibold text-emerald-600 uppercase tracking-wider mb-1">Paid</p>
                  <p className="text-[15px] font-bold text-emerald-700">${payModal.amountPaid.toLocaleString()}</p>
                </div>
                <div className="bg-rose-50 border border-rose-200 rounded-lg px-3 py-2.5 text-center">
                  <p className="text-[10px] font-semibold text-rose-500 uppercase tracking-wider mb-1">Due</p>
                  <p className="text-[15px] font-bold text-rose-600">
                    ${(payModal.totalAmount - payModal.amountPaid).toLocaleString()}
                  </p>
                </div>
              </div>

              {/* Payment form */}
              <form onSubmit={handlePaySubmit} noValidate>
                <div className="mb-4">
                  <label className="block text-[12px] font-semibold text-slate-600 mb-1.5 uppercase tracking-wide">
                    Payment Amount (USD) <span className="text-rose-500">*</span>
                  </label>
                  <div className="relative">
                    <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 font-semibold pointer-events-none">
                      $
                    </span>
                    <input
                      type="number"
                      min={0.01}
                      step="0.01"
                      max={payModal.totalAmount - payModal.amountPaid}
                      placeholder="0.00"
                      value={payAmount}
                      onChange={e => {
                        setPayAmount(e.target.value);
                        if (payError) setPayError("");
                      }}
                      autoFocus
                      className={`w-full pl-7 pr-3.5 py-2.5 text-[14px] font-semibold text-slate-800 bg-white border rounded-lg
                        placeholder:text-slate-300 focus:outline-none focus:ring-2 focus:ring-emerald-400 focus:border-transparent transition
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
                  {payModal.totalAmount - payModal.amountPaid > 0 && (
                    <button
                      type="button"
                      onClick={() => {
                        setPayAmount(String(payModal.totalAmount - payModal.amountPaid));
                        setPayError("");
                      }}
                      className="mt-2 text-[11.5px] font-medium text-emerald-600 hover:text-emerald-700 hover:underline transition-colors"
                    >
                      Pay full balance (${(payModal.totalAmount - payModal.amountPaid).toLocaleString()})
                    </button>
                  )}
                </div>

                {/* Live preview of new status */}
                {payAmount && parseFloat(payAmount) > 0 && parseFloat(payAmount) <= (payModal.totalAmount - payModal.amountPaid) && (
                  <div className="mb-4 flex items-center gap-3 bg-slate-50 border border-slate-200 rounded-lg px-4 py-2.5">
                    <p className="text-[12px] text-slate-500 flex-1">After this payment:</p>
                    <p className="text-[12px] font-semibold text-emerald-700">
                      ${(payModal.amountPaid + parseFloat(payAmount)).toLocaleString()} paid
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
              </form>
            </div>
          </div>
        </div>
      )}

      {/* ── TIMELINE MODAL ─────────────────────────────────────── */}
      {timelineModal && (() => {
        const b = timelineModal;
        const due = b.totalAmount - b.amountPaid;
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
                      <p className="text-[13px] font-bold text-slate-700">${b.totalAmount.toLocaleString()}</p>
                    </div>
                    <div className="bg-emerald-50 rounded-lg px-3 py-2.5 text-center">
                      <p className="text-[10.5px] text-emerald-500 mb-1">Paid</p>
                      <p className="text-[13px] font-bold text-emerald-700">${b.amountPaid.toLocaleString()}</p>
                    </div>
                    <div className={`rounded-lg px-3 py-2.5 text-center ${due > 0 ? "bg-rose-50" : "bg-slate-50"}`}>
                      <p className={`text-[10.5px] mb-1 ${due > 0 ? "text-rose-400" : "text-slate-400"}`}>Due</p>
                      <p className={`text-[13px] font-bold ${due > 0 ? "text-rose-600" : "text-slate-400"}`}>
                        ${due.toLocaleString()}
                      </p>
                    </div>
                  </div>
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
                <button
                  onClick={() => setTimelineModal(null)}
                  className="w-full py-2.5 text-[13px] font-medium text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-xl transition-colors"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

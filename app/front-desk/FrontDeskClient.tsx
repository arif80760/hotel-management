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
import {
  type BookingStatus,
  type PaymentStatus,
  type MockBooking as Booking,
} from "@/lib/mockData";

// ─────────────────────────────────────────────────────────────
// LOCAL TYPES
// ─────────────────────────────────────────────────────────────
type AppRole = "Staff" | "Admin";

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
  };
  return m[s];
}

function paymentDot(p: PaymentStatus): string {
  const m: Record<PaymentStatus, string> = {
    Paid: "bg-emerald-500", Partial: "bg-blue-500", Unpaid: "bg-red-400",
  };
  return m[p];
}

function derivePaymentStatus(total: number, paid: number): PaymentStatus {
  if (paid <= 0)        return "Unpaid";
  if (paid >= total)    return "Paid";
  return "Partial";
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
// COMPONENT
// ─────────────────────────────────────────────────────────────
export default function FrontDeskClient() {
  // ── Shared context ─────────────────────────────────────────
  const {
    bookings,
    changeBookingStatus,
    checkoutWithOverride,
    recordPayment,
  } = useHotel();

  // ── Role simulation ─────────────────────────────────────────
  const [role, setRole] = useState<AppRole>("Staff");

  // ── Feedback ────────────────────────────────────────────────
  const [successMsg, setSuccessMsg] = useState<string>("");

  // ── Blocked-checkout modal ───────────────────────────────────
  const [checkoutBlock,  setCheckoutBlock]  = useState<Booking | null>(null);
  const [overrideReason, setOverrideReason] = useState<string>("");
  const [overrideError,  setOverrideError]  = useState<string>("");

  // ── Add-payment modal ────────────────────────────────────────
  const [payModal,  setPayModal]  = useState<Booking | null>(null);
  const [payAmount, setPayAmount] = useState<string>("");
  const [payError,  setPayError]  = useState<string>("");

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
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") closeCheckoutBlock(); }
    if (checkoutBlock) document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [checkoutBlock]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") closePayModal(); }
    if (payModal) document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [payModal]);

  // ── Handlers ─────────────────────────────────────────────────

  /** Check In: Confirmed → Checked In (room becomes Occupied via context). */
  function handleCheckIn(booking: Booking) {
    changeBookingStatus(booking.id, "Checked In");
    setSuccessMsg(
      `${booking.guestName} checked in · Room ${booking.roomNumber} is now Occupied.`
    );
  }

  /**
   * Check Out gate — identical logic to BookingsClient.handleWorkflowAction.
   * due > 0  → open blocked-checkout modal (Staff sees it locked; Admin can override)
   * due = 0  → direct checkout, room moves to Cleaning
   */
  function handleCheckOut(booking: Booking) {
    const due = booking.totalAmount - booking.amountPaid;
    if (due > 0) {
      setCheckoutBlock(booking);
      setOverrideReason("");
      setOverrideError("");
    } else {
      changeBookingStatus(booking.id, "Checked Out");
      setSuccessMsg(
        `${booking.guestName} checked out · Room ${booking.roomNumber} is now Cleaning.`
      );
    }
  }

  function closeCheckoutBlock() {
    setCheckoutBlock(null);
    setOverrideReason("");
    setOverrideError("");
  }

  function handleAdminOverride(e: React.FormEvent) {
    e.preventDefault();
    if (!checkoutBlock) return;
    if (role !== "Admin") {
      setOverrideError("Switch to Admin role to use this override.");
      return;
    }
    checkoutWithOverride(checkoutBlock.id, overrideReason);
    const due = checkoutBlock.totalAmount - checkoutBlock.amountPaid;
    setSuccessMsg(
      `Admin override: ${checkoutBlock.guestName} checked out with $${due.toLocaleString()} still outstanding.`
    );
    closeCheckoutBlock();
  }

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

  function handlePaySubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!payModal) return;
    const amount = parseFloat(payAmount);
    const due    = payModal.totalAmount - payModal.amountPaid;
    if (!payAmount.trim() || isNaN(amount) || amount <= 0) {
      setPayError("Enter a valid amount greater than $0.");
      return;
    }
    if (amount > due) {
      setPayError(`Cannot exceed outstanding balance of $${due.toLocaleString()}.`);
      return;
    }
    recordPayment(payModal.id, amount);
    setSuccessMsg(
      `$${amount.toLocaleString()} recorded for ${payModal.guestName} · ${payModal.id}.`
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

        {/* Role simulator — same as Bookings page */}
        <div className="flex items-center gap-2 bg-white border border-slate-200 rounded-lg px-3 py-1.5 shadow-sm">
          <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Role</span>
          {(["Staff", "Admin"] as AppRole[]).map(r => (
            <button
              key={r}
              onClick={() => setRole(r)}
              className={`px-2.5 py-1 rounded-md text-[12px] font-semibold transition-colors ${
                role === r
                  ? r === "Admin"
                    ? "bg-amber-500 text-white shadow-sm"
                    : "bg-slate-800 text-white shadow-sm"
                  : "text-slate-400 hover:text-slate-600"
              }`}
            >
              {r}
            </button>
          ))}
          <span className="text-[10.5px] text-slate-300 italic">demo</span>
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
              const due = b.totalAmount - b.amountPaid;
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
                        Room {b.roomNumber} · {b.roomCategory} · {b.nights} nt
                      </p>
                      {/* Payment indicator */}
                      <div className="flex items-center gap-1.5 mt-1.5">
                        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${paymentDot(b.payment)}`} />
                        {due > 0 ? (
                          <span className="text-[11.5px] font-semibold text-rose-600">
                            ${due.toLocaleString()} due at check-in
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
                        onClick={() => handleCheckIn(b)}
                        className="flex items-center gap-1.5 text-[12px] font-semibold text-white bg-blue-600 hover:bg-blue-700 px-3 py-1.5 rounded-lg transition-colors whitespace-nowrap shadow-sm"
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="w-3 h-3">
                          <path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><path d="M22 4L12 14.01l-3-3"/>
                        </svg>
                        Check In
                      </button>
                      {due > 0 && (
                        <button
                          onClick={() => openPayModal(b)}
                          className="text-[11px] font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 hover:bg-emerald-100 px-2.5 py-1 rounded-lg transition-colors whitespace-nowrap"
                        >
                          + Collect Payment
                        </button>
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
              const due = b.totalAmount - b.amountPaid;
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
                        Room {b.roomNumber} · {b.roomCategory} · {b.nights} nt
                      </p>
                      <p className="text-[11.5px] text-slate-400 mt-0.5">
                        In {b.checkIn} · Out {b.checkOut}
                      </p>
                      {/* Balance indicator */}
                      <div className="flex items-center gap-1.5 mt-1.5">
                        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${paymentDot(b.payment)}`} />
                        {due > 0 ? (
                          <span className="text-[11.5px] font-semibold text-rose-600">
                            Balance due: ${due.toLocaleString()}
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
                        className={`flex items-center gap-1.5 text-[12px] font-semibold px-3 py-1.5 rounded-lg transition-colors whitespace-nowrap shadow-sm ${
                          due > 0
                            ? "text-amber-800 bg-amber-50 border border-amber-300 hover:bg-amber-100"
                            : "text-white bg-slate-700 hover:bg-slate-800"
                        }`}
                      >
                        Check Out
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="w-3 h-3">
                          <path d="M19 12H5M12 5l7 7-7 7"/>
                        </svg>
                      </button>
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
              const due = b.totalAmount - b.amountPaid;
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
                        Room {b.roomNumber} · {b.roomCategory} · {b.nights} nt
                      </p>
                      {/* Status + balance */}
                      <div className="flex items-center gap-2 flex-wrap mt-1.5">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold ${statusBadge(b.status)}`}>
                          {b.status}
                        </span>
                        {due > 0 ? (
                          <span className="text-[11.5px] font-bold text-rose-600">
                            Due: ${due.toLocaleString()}
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
                          className={`flex items-center gap-1.5 text-[12px] font-semibold px-3 py-1.5 rounded-lg transition-colors whitespace-nowrap shadow-sm ${
                            due > 0
                              ? "text-amber-800 bg-amber-50 border border-amber-300 hover:bg-amber-100"
                              : "text-white bg-slate-700 hover:bg-slate-800"
                          }`}
                        >
                          Check Out
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="w-3 h-3">
                            <path d="M19 12H5M12 5l7 7-7 7"/>
                          </svg>
                        </button>
                      )}
                      {due > 0 && (
                        <button
                          onClick={() => openPayModal(b)}
                          className="text-[11px] font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 hover:bg-emerald-100 px-2.5 py-1 rounded-lg transition-colors whitespace-nowrap"
                        >
                          + Settle Balance
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

      </div>{/* end grid */}

      {/* ══════════════════════════════════════════════════════
          BLOCKED CHECKOUT MODAL
          Identical logic to BookingsClient — due > 0 at checkout
          blocks Staff; Admin can override with a logged reason.
          TODO: Replace role check with real permission guard.
      ══════════════════════════════════════════════════════ */}
      {checkoutBlock && (() => {
        const due = checkoutBlock.totalAmount - checkoutBlock.amountPaid;
        return (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
            onClick={e => { if (e.target === e.currentTarget) closeCheckoutBlock(); }}
          >
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">

              {/* Header */}
              <div className="flex items-center justify-between px-6 py-4 border-b border-amber-200 bg-amber-50">
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-lg bg-amber-500 flex items-center justify-center flex-shrink-0">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-4 h-4 text-white">
                      <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
                      <path d="M12 9v4M12 17h.01"/>
                    </svg>
                  </div>
                  <div>
                    <h2 className="text-[14px] font-bold text-amber-900 leading-none">Checkout Blocked</h2>
                    <p className="text-[11.5px] text-amber-700 mt-0.5 font-mono">{checkoutBlock.id}</p>
                  </div>
                </div>
                <button onClick={closeCheckoutBlock} className="p-1.5 text-amber-500 hover:text-amber-800 hover:bg-amber-100 rounded-lg transition-colors">
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
                  <div>
                    <p className="text-[12px] font-semibold text-rose-700 uppercase tracking-wide">Outstanding Balance</p>
                    <p className="text-[22px] font-bold text-rose-600 leading-none mt-0.5">${due.toLocaleString()}</p>
                    <p className="text-[11.5px] text-rose-500 mt-0.5">
                      ${checkoutBlock.amountPaid.toLocaleString()} paid of ${checkoutBlock.totalAmount.toLocaleString()} total
                    </p>
                  </div>
                </div>

                {/* Policy */}
                <div className="bg-slate-50 border border-slate-200 rounded-lg px-4 py-3.5 mb-5 space-y-2">
                  <div className="flex items-start gap-2">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-4 h-4 text-slate-500 flex-shrink-0 mt-0.5">
                      <circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>
                    </svg>
                    <p className="text-[12.5px] text-slate-700 font-medium leading-relaxed">
                      Outstanding balance must be settled before checkout.
                    </p>
                  </div>
                  <div className="flex items-start gap-2">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-4 h-4 text-slate-400 flex-shrink-0 mt-0.5">
                      <rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/>
                    </svg>
                    <p className="text-[12px] text-slate-500 leading-relaxed">
                      <span className="font-semibold text-slate-700">Admin</span> can override with a stated reason — logged on the booking.
                    </p>
                  </div>
                </div>

                {/* Role indicator */}
                <div className="flex items-center gap-2 mb-5">
                  <span className="text-[12px] text-slate-500">Signed in as:</span>
                  <span className={`text-[12px] font-bold px-2.5 py-0.5 rounded-full ${
                    role === "Admin"
                      ? "bg-amber-100 text-amber-800 border border-amber-300"
                      : "bg-slate-100 text-slate-600 border border-slate-200"
                  }`}>
                    {role}
                  </span>
                  {role !== "Admin" && (
                    <button
                      onClick={() => setRole("Admin")}
                      className="text-[11.5px] text-amber-600 hover:text-amber-700 hover:underline font-medium"
                    >
                      Switch to Admin
                    </button>
                  )}
                </div>

                {/* Override form */}
                <form onSubmit={handleAdminOverride}>
                  <div className="mb-4">
                    <label className="block text-[12px] font-semibold text-slate-600 mb-1.5 uppercase tracking-wide">
                      Override Reason
                      <span className="ml-1 font-normal normal-case text-slate-400">(recommended)</span>
                    </label>
                    <textarea
                      rows={2}
                      placeholder={
                        role === "Admin"
                          ? "e.g. Guest settling via bank transfer, confirmed by manager."
                          : "Switch to Admin role to enter a reason."
                      }
                      value={overrideReason}
                      onChange={e => { setOverrideReason(e.target.value); setOverrideError(""); }}
                      disabled={role !== "Admin"}
                      className={`w-full px-3.5 py-2.5 text-[13px] text-slate-800 bg-white border rounded-lg resize-none
                        placeholder:text-slate-300 focus:outline-none focus:ring-2 focus:ring-amber-400 focus:border-transparent transition
                        ${role !== "Admin" ? "bg-slate-50 cursor-not-allowed text-slate-400" : "border-slate-200"}`}
                    />
                    {overrideError && (
                      <p className="mt-1.5 text-[11.5px] text-rose-600">{overrideError}</p>
                    )}
                  </div>
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
                      disabled={role !== "Admin"}
                      className={`flex items-center gap-2 px-5 py-2.5 text-[13px] font-semibold rounded-lg transition-colors shadow-sm ${
                        role === "Admin"
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
                    Room {payModal.roomNumber} · {payModal.roomCategory}
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

              {/* Payment input */}
              <form onSubmit={handlePaySubmit} noValidate>
                <div className="mb-4">
                  <label className="block text-[12px] font-semibold text-slate-600 mb-1.5 uppercase tracking-wide">
                    Payment Amount (USD) <span className="text-rose-500">*</span>
                  </label>
                  <div className="relative">
                    <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 font-semibold pointer-events-none">$</span>
                    <input
                      type="number"
                      min={0.01}
                      step="0.01"
                      max={payModal.totalAmount - payModal.amountPaid}
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
                      setPayAmount(String(payModal.totalAmount - payModal.amountPaid));
                      setPayError("");
                    }}
                    className="mt-2 text-[11.5px] font-medium text-emerald-600 hover:text-emerald-700 hover:underline transition-colors"
                  >
                    Pay full balance (${(payModal.totalAmount - payModal.amountPaid).toLocaleString()})
                  </button>
                </div>

                {/* Live preview */}
                {payAmount && parseFloat(payAmount) > 0 && parseFloat(payAmount) <= (payModal.totalAmount - payModal.amountPaid) && (
                  <div className="mb-4 flex items-center gap-3 bg-slate-50 border border-slate-200 rounded-lg px-4 py-2.5">
                    <p className="text-[12px] text-slate-500 flex-1">After this payment:</p>
                    <p className="text-[12px] font-semibold text-emerald-700">
                      ${(payModal.amountPaid + parseFloat(payAmount)).toLocaleString()} paid
                    </p>
                    <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${
                      derivePaymentStatus(payModal.totalAmount, payModal.amountPaid + parseFloat(payAmount)) === "Paid"
                        ? "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200"
                        : "bg-blue-50 text-blue-700 ring-1 ring-blue-200"
                    }`}>
                      {derivePaymentStatus(payModal.totalAmount, payModal.amountPaid + parseFloat(payAmount))}
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
              </form>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

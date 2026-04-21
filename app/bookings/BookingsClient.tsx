"use client";

// app/bookings/BookingsClient.tsx
//
// This is a CLIENT component — it runs in the browser and can
// use React state (useState). The server-side page.tsx reads
// the ?room= URL param and passes it here as `initialRoom`.
//
// What this component does:
//  1. Shows an amber banner if a room was pre-selected from the Room Board
//  2. Opens the New Booking form automatically in that case
//  3. Pre-fills the Room Number field with the selected room
//  4. Lets staff fill in guest details and submit
//  5. Adds the new booking to the live list on screen (frontend only)
//  6. Shows all bookings (demo + newly created) in a filterable table

import { useState, useEffect } from "react";
import Link from "next/link";

// ─────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────
type BookingStatus  = "Confirmed" | "Checked In" | "Checked Out" | "Cancelled";
type PaymentStatus  = "Paid" | "Pending" | "Partial";

type Booking = {
  id:       string;
  guest:    string;
  phone:    string;
  room:     string;
  type:     string;
  checkIn:  string;
  checkOut: string;
  nights:   number;
  status:   BookingStatus;
  payment:  PaymentStatus;
  amount:   string;
  isNew?:   boolean; // flag bookings added during this session
};

type FormData = {
  guest:    string;
  phone:    string;
  room:     string;
  checkIn:  string;
  checkOut: string;
  status:   BookingStatus;
};

// ─────────────────────────────────────────────────────────────
// ROOM LOOKUP TABLE
// Maps every room number from the Room Board to its type and
// nightly price. Used to auto-fill the room type and calculate
// the estimated total when the form is submitted.
// ─────────────────────────────────────────────────────────────
const ROOM_INFO: Record<string, { type: string; price: number }> = {
  "101": { type: "Single",  price: 89  }, "102": { type: "Single",  price: 89  },
  "103": { type: "Double",  price: 129 }, "104": { type: "Double",  price: 129 },
  "105": { type: "Double",  price: 129 }, "106": { type: "Double",  price: 129 },
  "107": { type: "Family",  price: 199 }, "108": { type: "Family",  price: 199 },
  "109": { type: "Double",  price: 129 }, "110": { type: "Double",  price: 129 },
  "111": { type: "Single",  price: 89  }, "112": { type: "Single",  price: 89  },
  "113": { type: "Double",  price: 129 }, "114": { type: "Double",  price: 129 },
  "201": { type: "Deluxe",  price: 179 }, "202": { type: "Deluxe",  price: 179 },
  "203": { type: "Suite",   price: 299 }, "204": { type: "Deluxe",  price: 179 },
  "205": { type: "Deluxe",  price: 179 }, "206": { type: "Suite",   price: 299 },
  "207": { type: "Double",  price: 129 }, "208": { type: "Double",  price: 129 },
  "209": { type: "Deluxe",  price: 179 }, "210": { type: "Deluxe",  price: 179 },
  "211": { type: "Suite",   price: 299 }, "212": { type: "Double",  price: 129 },
  "301": { type: "Suite",   price: 299 }, "302": { type: "Double",  price: 129 },
  "303": { type: "Deluxe",  price: 179 }, "304": { type: "Deluxe",  price: 179 },
  "305": { type: "Deluxe",  price: 179 }, "306": { type: "Suite",   price: 299 },
  "307": { type: "Double",  price: 129 }, "308": { type: "Double",  price: 129 },
  "309": { type: "Deluxe",  price: 179 }, "310": { type: "Double",  price: 129 },
  "311": { type: "Double",  price: 129 }, "312": { type: "Suite",   price: 299 },
  "401": { type: "Suite",   price: 549 }, "402": { type: "Suite",   price: 549 },
  "403": { type: "Suite",   price: 549 }, "404": { type: "Suite",   price: 549 },
  "405": { type: "Suite",   price: 549 }, "406": { type: "Suite",   price: 549 },
  "407": { type: "Suite",   price: 549 }, "408": { type: "Suite",   price: 549 },
  "409": { type: "Suite",   price: 549 }, "410": { type: "Suite",   price: 549 },
};

// ─────────────────────────────────────────────────────────────
// DEMO BOOKINGS — initial data shown before any form submission
// ─────────────────────────────────────────────────────────────
const DEMO_BOOKINGS: Booking[] = [
  { id: "BK-1041", guest: "James Whitfield", phone: "+1 617 555 0101", room: "204", type: "Deluxe",  checkIn: "Apr 21, 2025", checkOut: "Apr 24, 2025", nights: 3, status: "Confirmed",   payment: "Pending", amount: "$537"   },
  { id: "BK-1040", guest: "Priya Nair",      phone: "+91 98 5550 102", room: "312", type: "Suite",   checkIn: "Apr 21, 2025", checkOut: "Apr 26, 2025", nights: 5, status: "Confirmed",   payment: "Paid",    amount: "$1,245" },
  { id: "BK-1039", guest: "Carlos Mendez",   phone: "+52 55 5550 103", room: "115", type: "Double",  checkIn: "Apr 21, 2025", checkOut: "Apr 23, 2025", nights: 2, status: "Checked In",  payment: "Partial", amount: "$258"   },
  { id: "BK-1038", guest: "Sophie Laurent",  phone: "+33 6 5550 0104", room: "408", type: "Suite",   checkIn: "Apr 21, 2025", checkOut: "Apr 28, 2025", nights: 7, status: "Checked In",  payment: "Paid",    amount: "$2,093" },
  { id: "BK-1037", guest: "Robert Kim",      phone: "+82 10 5550 105", room: "101", type: "Single",  checkIn: "Apr 19, 2025", checkOut: "Apr 21, 2025", nights: 2, status: "Checked Out", payment: "Paid",    amount: "$178"   },
  { id: "BK-1036", guest: "Amina Hassan",    phone: "+971 50 555 0106",room: "230", type: "Double",  checkIn: "Apr 17, 2025", checkOut: "Apr 21, 2025", nights: 4, status: "Checked Out", payment: "Paid",    amount: "$516"   },
  { id: "BK-1035", guest: "David Okoye",     phone: "+234 80 5550 107",room: "305", type: "Deluxe",  checkIn: "Apr 22, 2025", checkOut: "Apr 25, 2025", nights: 3, status: "Confirmed",   payment: "Pending", amount: "$537"   },
  { id: "BK-1034", guest: "Yuki Tanaka",     phone: "+81 90 5550 108", room: "412", type: "Suite",   checkIn: "Apr 15, 2025", checkOut: "Apr 20, 2025", nights: 5, status: "Cancelled",   payment: "Paid",    amount: "$1,745" },
];

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

// Number of nights between two ISO date strings ("2025-04-21")
function calcNights(checkIn: string, checkOut: string): number {
  if (!checkIn || !checkOut) return 0;
  const diff = new Date(checkOut).getTime() - new Date(checkIn).getTime();
  return Math.max(0, Math.floor(diff / 86_400_000)); // 86400000ms = 1 day
}

// Format a date string like "2025-04-21" → "Apr 21, 2025"
function formatDate(iso: string): string {
  if (!iso) return "";
  return new Date(iso + "T00:00:00").toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric",
  });
}

// Initials from a full name ("James Whitfield" → "JW")
function initials(name: string): string {
  return name.trim().split(/\s+/).map(n => n[0]).join("").slice(0, 2).toUpperCase();
}

// Consistent avatar background per name
const AVATAR_COLORS = [
  "bg-violet-100 text-violet-700", "bg-blue-100 text-blue-700",
  "bg-emerald-100 text-emerald-700", "bg-rose-100 text-rose-700",
  "bg-amber-100 text-amber-700", "bg-teal-100 text-teal-700",
  "bg-indigo-100 text-indigo-700", "bg-pink-100 text-pink-700",
];
function avatarColor(name: string): string {
  return AVATAR_COLORS[(name.charCodeAt(0) || 0) % AVATAR_COLORS.length];
}

// Status badge style
function statusBadge(s: BookingStatus): string {
  const m: Record<BookingStatus, string> = {
    "Confirmed":   "bg-blue-50 text-blue-700 ring-1 ring-blue-200",
    "Checked In":  "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200",
    "Checked Out": "bg-slate-100 text-slate-500 ring-1 ring-slate-200",
    "Cancelled":   "bg-red-50 text-red-600 ring-1 ring-red-200",
  };
  return m[s];
}

// Payment dot colour
function paymentDot(p: PaymentStatus): string {
  return { Paid: "bg-emerald-500", Pending: "bg-amber-500", Partial: "bg-blue-500" }[p];
}
function paymentText(p: PaymentStatus): string {
  return { Paid: "text-emerald-600", Pending: "text-amber-600", Partial: "text-blue-600" }[p];
}

// Today's date as an ISO string for the date input min attribute
const TODAY = new Date().toISOString().split("T")[0];

// ─────────────────────────────────────────────────────────────
// EMPTY FORM STATE
// ─────────────────────────────────────────────────────────────
const EMPTY_FORM: FormData = {
  guest: "", phone: "", room: "", checkIn: "", checkOut: "", status: "Confirmed",
};

// ─────────────────────────────────────────────────────────────
// COMPONENT
// ─────────────────────────────────────────────────────────────
interface Props {
  // The room number passed from the URL (?room=101), or null
  initialRoom: string | null;
}

export default function BookingsClient({ initialRoom }: Props) {
  // ── State ──────────────────────────────────────────────────

  // The live list of bookings (demo data + anything the user adds)
  const [bookings, setBookings] = useState<Booking[]>(DEMO_BOOKINGS);

  // Is the New Booking form currently open?
  // Auto-open when arriving from the Room Board
  const [formOpen, setFormOpen] = useState<boolean>(!!initialRoom);

  // The form field values
  const [form, setForm] = useState<FormData>({
    ...EMPTY_FORM,
    room: initialRoom ?? "", // pre-fill room number if coming from Room Board
  });

  // Validation error messages (keyed by field name)
  const [errors, setErrors] = useState<Partial<Record<keyof FormData, string>>>({});

  // Success banner after a booking is created
  const [successMsg, setSuccessMsg] = useState<string>("");

  // Which status filter tab is active ("All", "Confirmed", etc.)
  const [activeFilter, setActiveFilter] = useState<string>("All");

  // Auto-increment ID counter (starts after the last demo booking)
  const [nextId, setNextId] = useState<number>(1042);

  // ── Derived values ─────────────────────────────────────────

  // Look up room info for the currently typed room number
  const roomInfo = ROOM_INFO[form.room.trim()] ?? null;

  // Night count from the date inputs
  const nights = calcNights(form.checkIn, form.checkOut);

  // Estimated total: nightly rate × nights
  const estimatedTotal =
    roomInfo && nights > 0
      ? `$${(roomInfo.price * nights).toLocaleString()}`
      : null;

  // Filtered bookings for the table
  const filteredBookings =
    activeFilter === "All"
      ? bookings
      : bookings.filter(b => b.status === activeFilter);

  // Tab counts
  const counts: Record<string, number> = {
    All:          bookings.length,
    Confirmed:    bookings.filter(b => b.status === "Confirmed").length,
    "Checked In": bookings.filter(b => b.status === "Checked In").length,
    "Checked Out":bookings.filter(b => b.status === "Checked Out").length,
    Cancelled:    bookings.filter(b => b.status === "Cancelled").length,
  };

  // ── Effects ────────────────────────────────────────────────

  // If the URL param changes (e.g. browser back/forward), re-sync
  useEffect(() => {
    if (initialRoom) {
      setForm(f => ({ ...f, room: initialRoom }));
      setFormOpen(true);
    }
  }, [initialRoom]);

  // Clear success message after 4 seconds
  useEffect(() => {
    if (!successMsg) return;
    const t = setTimeout(() => setSuccessMsg(""), 4000);
    return () => clearTimeout(t);
  }, [successMsg]);

  // ── Handlers ───────────────────────────────────────────────

  // Update a single form field
  function setField<K extends keyof FormData>(key: K, value: FormData[K]) {
    setForm(prev => ({ ...prev, [key]: value }));
    // Clear the error for this field as soon as the user starts typing
    if (errors[key]) setErrors(prev => ({ ...prev, [key]: undefined }));
  }

  // Validate required fields; return true if the form is valid
  function validate(): boolean {
    const e: Partial<Record<keyof FormData, string>> = {};
    if (!form.guest.trim())   e.guest   = "Guest name is required.";
    if (!form.room.trim())    e.room    = "Room number is required.";
    if (!form.checkIn)        e.checkIn = "Check-in date is required.";
    if (!form.checkOut)       e.checkOut = "Check-out date is required.";
    if (form.checkIn && form.checkOut && calcNights(form.checkIn, form.checkOut) <= 0) {
      e.checkOut = "Check-out must be after check-in.";
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  // Submit the form — create a new booking and add to the list
  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validate()) return;

    const n = calcNights(form.checkIn, form.checkOut);
    const info = ROOM_INFO[form.room.trim()];

    const newBooking: Booking = {
      id:       `BK-${nextId}`,
      guest:    form.guest.trim(),
      phone:    form.phone.trim() || "—",
      room:     form.room.trim(),
      type:     info?.type ?? "Unknown",
      checkIn:  formatDate(form.checkIn),
      checkOut: formatDate(form.checkOut),
      nights:   n,
      status:   form.status,
      payment:  "Pending",   // all new bookings start as pending payment
      amount:   info ? `$${(info.price * n).toLocaleString()}` : "—",
      isNew:    true,
    };

    // Prepend to the list so it appears at the top
    setBookings(prev => [newBooking, ...prev]);
    setNextId(id => id + 1);
    setSuccessMsg(`Booking ${newBooking.id} created for ${newBooking.guest} · Room ${newBooking.room}`);
    setForm(EMPTY_FORM);
    setFormOpen(false);
    setActiveFilter("All"); // switch to All tab so the new booking is visible
  }

  // Reset and close the form
  function handleCancel() {
    setForm({ ...EMPTY_FORM, room: initialRoom ?? "" });
    setErrors({});
    setFormOpen(false);
  }

  // ── Render ─────────────────────────────────────────────────
  return (
    <div className="p-7 max-w-[1400px] space-y-5">

      {/* ══════════════════════════════════════════════════════
          PAGE HEADER
      ══════════════════════════════════════════════════════ */}
      <div className="flex items-start justify-between">
        <div>
          {/* Back link — only shown when arriving from the Room Board */}
          {initialRoom && (
            <Link
              href="/"
              className="inline-flex items-center gap-1.5 text-[12px] font-medium text-slate-400 hover:text-slate-700 transition-colors mb-2 group"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-3.5 h-3.5 group-hover:-translate-x-0.5 transition-transform">
                <path d="M19 12H5M12 5l-7 7 7 7"/>
              </svg>
              Back to Room Board
            </Link>
          )}
          <h1 className="text-[22px] font-semibold text-slate-900 tracking-tight leading-none">
            Bookings
          </h1>
          <p className="text-[13px] text-slate-500 mt-1">
            {bookings.length} reservations total
          </p>
        </div>

        {/* "New Booking" button — only visible when form is closed */}
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

      {/* ══════════════════════════════════════════════════════
          ROOM PRE-SELECTION BANNER
          Only shown when arriving from the Room Board (?room=X)
      ══════════════════════════════════════════════════════ */}
      {initialRoom && (
        <div className="flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-xl px-5 py-4">
          {/* Icon */}
          <div className="mt-0.5 flex-shrink-0 w-8 h-8 rounded-lg bg-amber-100 flex items-center justify-center">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" className="w-4 h-4 text-amber-600">
              <rect x="3" y="4" width="18" height="17" rx="2"/>
              <path d="M3 10h18M8 2v4M16 2v4M8 14h2M8 18h2M14 14h2M14 18h2"/>
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[13.5px] font-semibold text-amber-900">
              Creating booking for Room {initialRoom}
            </p>
            <p className="text-[12.5px] text-amber-700 mt-0.5">
              {roomInfo
                ? `${roomInfo.type} · $${roomInfo.price}/night — fill in the guest details below to confirm.`
                : "Fill in the guest details below to confirm the reservation."}
            </p>
          </div>
          {/* Room type badge */}
          {roomInfo && (
            <span className="flex-shrink-0 text-[12px] font-bold text-amber-700 bg-amber-100 border border-amber-300 px-3 py-1.5 rounded-lg whitespace-nowrap">
              {roomInfo.type}
            </span>
          )}
        </div>
      )}

      {/* ══════════════════════════════════════════════════════
          SUCCESS BANNER
          Appears for 4 seconds after a booking is created
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
          NEW BOOKING FORM
          Shown when formOpen is true — either because the user
          clicked "New Booking" or arrived from the Room Board.
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
                <p className="text-[11.5px] text-slate-400 mt-0.5">All fields marked * are required</p>
              </div>
            </div>
            {/* Close button */}
            <button
              onClick={handleCancel}
              className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-200 rounded-lg transition-colors"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-4 h-4">
                <path d="M18 6L6 18M6 6l12 12"/>
              </svg>
            </button>
          </div>

          {/* Form body */}
          <form onSubmit={handleSubmit} noValidate>
            <div className="p-6 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">

              {/* Guest Name */}
              <div className="lg:col-span-1">
                <label className="block text-[12px] font-semibold text-slate-600 mb-1.5 uppercase tracking-wide">
                  Guest Name <span className="text-rose-500">*</span>
                </label>
                <input
                  type="text"
                  placeholder="e.g. James Whitfield"
                  value={form.guest}
                  onChange={e => setField("guest", e.target.value)}
                  className={`w-full px-3.5 py-2.5 text-[13.5px] text-slate-800 bg-white border rounded-lg
                    placeholder:text-slate-300 focus:outline-none focus:ring-2 focus:ring-amber-400 focus:border-transparent transition
                    ${errors.guest ? "border-rose-300 bg-rose-50" : "border-slate-200"}`}
                />
                {errors.guest && (
                  <p className="mt-1 text-[11.5px] text-rose-600">{errors.guest}</p>
                )}
              </div>

              {/* Phone Number */}
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
                  {/* Inline room type hint when room is recognised */}
                  {roomInfo && (
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[11px] font-semibold text-amber-600 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded pointer-events-none">
                      {roomInfo.type}
                    </span>
                  )}
                </div>
                {errors.room && (
                  <p className="mt-1 text-[11.5px] text-rose-600">{errors.room}</p>
                )}
              </div>

              {/* Check-in Date */}
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
                {errors.checkIn && (
                  <p className="mt-1 text-[11.5px] text-rose-600">{errors.checkIn}</p>
                )}
              </div>

              {/* Check-out Date */}
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
                {errors.checkOut && (
                  <p className="mt-1 text-[11.5px] text-rose-600">{errors.checkOut}</p>
                )}
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

            {/* ── Booking summary strip ── */}
            {nights > 0 && (
              <div className="mx-6 mb-4 bg-slate-50 border border-slate-200 rounded-lg px-4 py-3 flex items-center gap-6">
                <div className="text-center">
                  <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Nights</p>
                  <p className="text-[18px] font-bold text-slate-800">{nights}</p>
                </div>
                <div className="h-8 w-px bg-slate-200" />
                {roomInfo && (
                  <div className="text-center">
                    <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Rate / Night</p>
                    <p className="text-[18px] font-bold text-slate-800">${roomInfo.price}</p>
                  </div>
                )}
                {roomInfo && <div className="h-8 w-px bg-slate-200" />}
                {estimatedTotal && (
                  <div className="text-center">
                    <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Est. Total</p>
                    <p className="text-[18px] font-bold text-emerald-700">{estimatedTotal}</p>
                  </div>
                )}
                <div className="flex-1" />
                <p className="text-[11.5px] text-slate-400 italic">Payment status starts as Pending</p>
              </div>
            )}

            {/* ── Form actions ── */}
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
                {["ID", "Guest", "Room", "Check-in", "Check-out", "Nights", "Status", "Payment", "Amount"].map((h) => (
                  <th key={h} className="text-left px-5 py-3 text-[11px] font-semibold text-slate-400 uppercase tracking-wider whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredBookings.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-5 py-10 text-center text-[13px] text-slate-400">
                    No bookings match this filter.
                  </td>
                </tr>
              ) : filteredBookings.map((b) => (
                <tr
                  key={b.id}
                  className={`transition-colors ${
                    b.isNew
                      ? "bg-emerald-50/60 hover:bg-emerald-50"   // highlight newly added rows
                      : "hover:bg-slate-50/70"
                  }`}
                >
                  {/* ID */}
                  <td className="px-5 py-3.5">
                    <div className="flex items-center gap-1.5">
                      <span className="font-mono text-[11.5px] text-slate-400">{b.id}</span>
                      {/* "New" badge for freshly created bookings */}
                      {b.isNew && (
                        <span className="text-[10px] font-bold text-emerald-700 bg-emerald-100 px-1.5 py-0.5 rounded-full uppercase tracking-wide">
                          New
                        </span>
                      )}
                    </div>
                  </td>

                  {/* Guest — avatar + name + phone */}
                  <td className="px-5 py-3.5">
                    <div className="flex items-center gap-2.5">
                      <div className={`w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 text-[10px] font-bold ${avatarColor(b.guest)}`}>
                        {initials(b.guest)}
                      </div>
                      <div>
                        <p className="font-semibold text-slate-800 whitespace-nowrap">{b.guest}</p>
                        {b.phone && b.phone !== "—" && (
                          <p className="text-[11px] text-slate-400">{b.phone}</p>
                        )}
                      </div>
                    </div>
                  </td>

                  {/* Room + type */}
                  <td className="px-5 py-3.5">
                    <p className="font-semibold text-slate-800">Room {b.room}</p>
                    <p className="text-[11px] text-slate-400">{b.type}</p>
                  </td>

                  {/* Dates */}
                  <td className="px-5 py-3.5 text-slate-600 whitespace-nowrap">{b.checkIn}</td>
                  <td className="px-5 py-3.5 text-slate-600 whitespace-nowrap">{b.checkOut}</td>

                  {/* Nights */}
                  <td className="px-5 py-3.5 whitespace-nowrap">
                    <span className="font-semibold text-slate-700">{b.nights}</span>
                    <span className="text-slate-400 text-[12px]"> nt</span>
                  </td>

                  {/* Status badge */}
                  <td className="px-5 py-3.5">
                    <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-[11.5px] font-semibold whitespace-nowrap ${statusBadge(b.status)}`}>
                      {b.status}
                    </span>
                  </td>

                  {/* Payment */}
                  <td className="px-5 py-3.5">
                    <span className={`inline-flex items-center gap-1.5 text-[12px] font-semibold whitespace-nowrap ${paymentText(b.payment)}`}>
                      <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${paymentDot(b.payment)}`} />
                      {b.payment}
                    </span>
                  </td>

                  {/* Amount */}
                  <td className="px-5 py-3.5 font-bold text-slate-800 whitespace-nowrap">{b.amount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Table footer */}
        <div className="px-5 py-3 border-t border-slate-100 bg-slate-50 flex items-center justify-between">
          <p className="text-[12px] text-slate-400">
            Showing {filteredBookings.length} of {bookings.length} bookings
          </p>
          <p className="text-[12px] font-semibold text-slate-600">
            {activeFilter === "All"
              ? `${bookings.length} total`
              : `${filteredBookings.length} ${activeFilter}`}
          </p>
        </div>
      </div>
    </div>
  );
}

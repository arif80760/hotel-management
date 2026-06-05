"use client";

// app/page.tsx — Dashboard
//
// Previously a server component with hardcoded demo arrays.
// Now a client component that derives every displayed value from
// the live rooms + bookings loaded from Supabase via HotelContext.
//
// Sections that changed:
//   • Arrivals / Departures  — derived from today's bookings
//   • Occupancy by Floor     — derived from rooms grouped by floor
//   • Recent Bookings table  — first 5 rows from live bookings state
//   • Overall occupancy %    — computed from live room statuses
//
// Sections unchanged:
//   • DashboardStats (already live)
//   • RoomBoard (already live)
//   • Page heading / layout

import { useMemo } from "react";
import Link from "next/link";
import { useHotel }        from "@/contexts/HotelContext";
import type { BookingStatus } from "@/contexts/HotelContext";
import DashboardStats      from "@/components/DashboardStats";
import RoomBoard           from "@/components/RoomBoard";

// Matches the format stored in booking.checkIn / booking.checkOut
// so we can compare with a plain string equality check.
const TODAY_FMT = new Date().toLocaleDateString("en-US", {
  month: "short", day: "numeric", year: "numeric",
});

// ─────────────────────────────────────────────────────────────
// INLINE SVG ICONS  (unchanged)
// ─────────────────────────────────────────────────────────────
const Icons = {
  trend: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="w-[18px] h-[18px]">
      <path d="M3 17l4-4 4 4 4-5 4-4"/><path d="M21 7v6h-6"/>
    </svg>
  ),
  arrowRight: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
      <path d="M5 12h14M12 5l7 7-7 7"/>
    </svg>
  ),
  loginArrow: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
      <path d="M15 3h4a2 2 0 012 2v14a2 2 0 01-2 2h-4"/><path d="M10 17l5-5-5-5"/><path d="M15 12H3"/>
    </svg>
  ),
  logoutArrow: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
      <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>
    </svg>
  ),
};

// ─────────────────────────────────────────────────────────────
// HELPERS  (unchanged)
// ─────────────────────────────────────────────────────────────
function bookingBadge(s: BookingStatus) {
  const m: Record<BookingStatus, string> = {
    "Confirmed":   "bg-blue-50 text-blue-700 ring-1 ring-blue-200",
    "Checked In":  "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200",
    "Checked Out": "bg-slate-100 text-slate-500 ring-1 ring-slate-200",
    "Cancelled":   "bg-red-50 text-red-600 ring-1 ring-red-200",
  };
  return m[s];
}

function initials(name: string) {
  return name.split(" ").map(n => n[0]).join("").slice(0, 2).toUpperCase();
}

// ─────────────────────────────────────────────────────────────
// PAGE
// ─────────────────────────────────────────────────────────────
export default function DashboardPage() {
  const { rooms, bookings, loading } = useHotel();

  // ── Derived: today's arrivals ───────────────────────────────
  // Confirmed bookings whose check-in date is today.
  const todaysArrivals = useMemo(
    () => bookings.filter(
      b => b.checkIn === TODAY_FMT && b.status === "Confirmed"
    ),
    [bookings]
  );

  // ── Derived: today's departures ─────────────────────────────
  // Bookings whose check-out date is today and are not yet done.
  const todaysDepartures = useMemo(
    () => bookings.filter(
      b => b.checkOut === TODAY_FMT
        && b.status !== "Cancelled"
        && b.status !== "Checked Out"
    ),
    [bookings]
  );

  // ── Derived: 5 most-recent bookings ────────────────────────
  // Bookings arrive from Supabase ordered by created_at DESC,
  // so the first 5 are already the most recent.
  const recentBookings = useMemo(() => bookings.slice(0, 5), [bookings]);

  // ── Derived: occupancy per floor ───────────────────────────
  const floorStats = useMemo(() => {
    const floorOrder = ["Floor 1", "Floor 2", "Floor 3", "Floor 4"];
    return floorOrder
      .map(label => {
        const fr = rooms.filter(r => r.floor === label);
        return {
          label,
          occupied: fr.filter(r => r.status === "Occupied").length,
          total:    fr.length,
        };
      })
      .filter(f => f.total > 0); // omit floors with no rooms in DB
  }, [rooms]);

  // ── Derived: overall occupancy % ───────────────────────────
  const overallOccupancy = useMemo(() => {
    if (rooms.length === 0) return null;
    const occ = rooms.filter(r => r.status === "Occupied").length;
    return ((occ / rooms.length) * 100).toFixed(1);
  }, [rooms]);

  return (
    <div className="p-7 space-y-6 max-w-[1440px]">

      {/* ══════════════════════════════════════════════════════
          SECTION 1 — Page heading  (unchanged)
      ══════════════════════════════════════════════════════ */}
      <div className="flex items-end justify-between">
        <div>
          <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-widest mb-1">
            Operations Overview
          </p>
          <h1 className="text-2xl font-semibold text-slate-900 tracking-tight leading-none">
            Good morning ☀️
          </h1>
          <p className="text-[13.5px] text-slate-500 mt-1.5">
            Hotel Albatross Resort &mdash; current live status
          </p>
        </div>
        <div className="flex items-center gap-2 text-[12px] text-slate-400 font-medium">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
          </span>
          Live
        </div>
      </div>

      {/* ══════════════════════════════════════════════════════
          SECTION 2 — KPI stat cards  (live — reads HotelContext)
      ══════════════════════════════════════════════════════ */}
      <DashboardStats />

      {/* ══════════════════════════════════════════════════════
          SECTION 3 — Arrivals / Departures  +  Occupancy by Floor
      ══════════════════════════════════════════════════════ */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-5">

        {/* ── Arrivals & Departures (3/5) ─────────────────── */}
        <div className="lg:col-span-3 bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="flex border-b border-slate-200">
            {/* Arrivals tab — always active (departures tab is a count indicator) */}
            <div className="flex items-center gap-2 px-5 py-3.5 border-b-2 border-amber-500 cursor-default select-none">
              <span className="text-amber-500">{Icons.loginArrow}</span>
              <span className="text-[13px] font-semibold text-slate-800">Arrivals</span>
              <span className="bg-amber-100 text-amber-700 text-[11px] font-bold px-1.5 py-0.5 rounded-full leading-none">
                {todaysArrivals.length}
              </span>
            </div>
            <div className="flex items-center gap-2 px-5 py-3.5 cursor-default select-none">
              <span className="text-slate-400">{Icons.logoutArrow}</span>
              <span className="text-[13px] font-medium text-slate-400">Departures</span>
              <span className="bg-slate-100 text-slate-500 text-[11px] font-bold px-1.5 py-0.5 rounded-full leading-none">
                {todaysDepartures.length}
              </span>
            </div>
          </div>

          <ul className="divide-y divide-slate-100">
            {todaysArrivals.length === 0 ? (
              <li className="px-5 py-10 text-center">
                <p className="text-[13px] text-slate-400">
                  {loading ? "Loading…" : "No arrivals scheduled for today."}
                </p>
              </li>
            ) : (
              todaysArrivals.map(b => (
                <li key={b.id} className="flex items-center justify-between px-5 py-3 hover:bg-slate-50/80 transition-colors">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-8 h-8 rounded-full bg-slate-100 flex items-center justify-center flex-shrink-0">
                      <span className="text-[11px] font-bold text-slate-500">{initials(b.guestName)}</span>
                    </div>
                    <div className="min-w-0">
                      <p className="text-[13px] font-semibold text-slate-800 truncate">{b.guestName}</p>
                      <p className="text-[12px] text-slate-400">
                        Room {b.roomNumber}&nbsp;·&nbsp;{b.roomCategory}&nbsp;·&nbsp;{b.nights} night{b.nights !== 1 ? "s" : ""}
                      </p>
                    </div>
                  </div>
                  <div className="flex-shrink-0 ml-4">
                    <span className="text-[11px] font-semibold text-blue-700 bg-blue-50 ring-1 ring-blue-200 px-2.5 py-1 rounded-full">
                      {b.roomCategory}
                    </span>
                  </div>
                </li>
              ))
            )}
          </ul>

          <div className="px-5 py-3 border-t border-slate-100 bg-slate-50">
            <Link href="/bookings" className="inline-flex items-center gap-1.5 text-[12px] font-medium text-amber-600 hover:text-amber-700 transition-colors">
              View all bookings {Icons.arrowRight}
            </Link>
          </div>
        </div>

        {/* ── Occupancy by Floor (2/5) ────────────────────── */}
        <div className="lg:col-span-2 bg-white rounded-xl border border-slate-200 shadow-sm p-5 flex flex-col">
          <div className="flex items-center gap-2.5 mb-1">
            <span className="text-slate-600">{Icons.trend}</span>
            <h2 className="text-[13.5px] font-semibold text-slate-800">Occupancy by Floor</h2>
          </div>
          <p className="text-[12px] text-slate-400 mb-5">Current room usage per floor</p>

          <div className="space-y-4 flex-1">
            {loading && floorStats.length === 0 ? (
              <p className="text-[12px] text-slate-400">Loading room data…</p>
            ) : floorStats.length === 0 ? (
              <p className="text-[12px] text-slate-400">No room data available.</p>
            ) : (
              floorStats.map(f => {
                const pct      = f.total > 0 ? Math.round((f.occupied / f.total) * 100) : 0;
                const barColor = pct >= 80 ? "bg-rose-400" : pct >= 60 ? "bg-amber-400" : "bg-emerald-400";
                return (
                  <div key={f.label}>
                    <div className="flex justify-between items-baseline mb-1.5">
                      <span className="text-[12.5px] font-semibold text-slate-700">{f.label}</span>
                      <div className="flex items-baseline gap-1.5">
                        <span className="text-[13px] font-bold text-slate-800">{pct}%</span>
                        <span className="text-[11px] text-slate-400">{f.occupied}/{f.total}</span>
                      </div>
                    </div>
                    <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
                      <div className={`h-full ${barColor} rounded-full`} style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })
            )}
          </div>

          <div className="mt-5 pt-4 border-t border-slate-100 flex items-center justify-between">
            <span className="text-[12px] text-slate-500">Overall occupancy</span>
            <span className="text-[14px] font-bold text-slate-900">
              {overallOccupancy !== null ? `${overallOccupancy}%` : "—"}
            </span>
          </div>
        </div>
      </div>

      {/* ══════════════════════════════════════════════════════
          SECTION 4 — ROOM BOARD  (live — reads HotelContext)
      ══════════════════════════════════════════════════════ */}
      <RoomBoard />

      {/* ══════════════════════════════════════════════════════
          SECTION 5 — Recent Bookings  (live — first 5 from context)
      ══════════════════════════════════════════════════════ */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
          <div>
            <h2 className="text-[14px] font-semibold text-slate-800 leading-none">Recent Bookings</h2>
            <p className="text-[12px] text-slate-400 mt-0.5">Latest reservations across all rooms</p>
          </div>
          <Link href="/bookings" className="inline-flex items-center gap-1.5 text-[12px] font-medium text-amber-600 hover:text-amber-700 transition-colors">
            View all {Icons.arrowRight}
          </Link>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200">
                {["ID", "Guest", "Room", "Check-in", "Check-out", "Nights", "Status", "Amount"].map(h => (
                  <th key={h} className="text-left px-6 py-3 text-[11px] font-semibold text-slate-400 uppercase tracking-wider whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {recentBookings.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-6 py-12 text-center text-[13px] text-slate-400">
                    {loading ? "Loading bookings…" : "No bookings yet."}
                  </td>
                </tr>
              ) : (
                recentBookings.map(b => (
                  <tr key={b.id} className="hover:bg-slate-50/70 transition-colors">
                    <td className="px-6 py-3.5 font-mono text-[11.5px] text-slate-400 whitespace-nowrap">{b.id}</td>
                    <td className="px-6 py-3.5">
                      <div className="flex items-center gap-2.5">
                        <div className="w-6 h-6 rounded-full bg-slate-100 flex items-center justify-center flex-shrink-0">
                          <span className="text-[9px] font-bold text-slate-500">{initials(b.guestName)}</span>
                        </div>
                        <span className="font-semibold text-slate-800 whitespace-nowrap">{b.guestName}</span>
                      </div>
                    </td>
                    <td className="px-6 py-3.5 font-medium text-slate-600 whitespace-nowrap">Rm {b.roomNumber}</td>
                    <td className="px-6 py-3.5 text-slate-500 whitespace-nowrap">{b.checkIn}</td>
                    <td className="px-6 py-3.5 text-slate-500 whitespace-nowrap">{b.checkOut}</td>
                    <td className="px-6 py-3.5 text-slate-600 whitespace-nowrap">
                      <span className="font-semibold">{b.nights}</span>
                      <span className="text-slate-400"> nt</span>
                    </td>
                    <td className="px-6 py-3.5">
                      <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-[11px] font-semibold whitespace-nowrap ${bookingBadge(b.status)}`}>
                        {b.status}
                      </span>
                    </td>
                    <td className="px-6 py-3.5 font-bold text-slate-800 whitespace-nowrap">৳{b.totalAmount.toLocaleString()}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="px-6 py-3 border-t border-slate-100 bg-slate-50">
          <p className="text-[12px] text-slate-400">
            {recentBookings.length > 0
              ? <>Showing {recentBookings.length} most recent &mdash; <Link href="/bookings" className="text-amber-600 hover:underline font-medium">see all bookings</Link></>
              : <Link href="/bookings" className="text-amber-600 hover:underline font-medium">Go to bookings</Link>
            }
          </p>
        </div>
      </div>

    </div>
  );
}

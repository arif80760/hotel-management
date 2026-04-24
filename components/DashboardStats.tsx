"use client";

// components/DashboardStats.tsx
//
// The four KPI stat cards on the Dashboard.
// Reads live room counts from HotelContext so the numbers update
// instantly whenever a booking changes a room's status.

import { useMemo } from "react";
import { useHotel } from "@/contexts/HotelContext";

// ── Inline SVG icons (same as page.tsx) ─────────────────────
const Icons = {
  bed: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="w-[18px] h-[18px]">
      <path d="M2 20V9a2 2 0 012-2h16a2 2 0 012 2v11"/><path d="M2 20h20"/>
      <path d="M9 20v-5h6v5"/><path d="M6 13h2"/><path d="M16 13h2"/>
    </svg>
  ),
  lock: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="w-[18px] h-[18px]">
      <rect x="3" y="11" width="18" height="11" rx="2"/>
      <path d="M7 11V7a5 5 0 0110 0v4"/>
    </svg>
  ),
  unlock: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="w-[18px] h-[18px]">
      <rect x="3" y="11" width="18" height="11" rx="2"/>
      <path d="M7 11V7a5 5 0 019.9-1"/>
    </svg>
  ),
  cal: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="w-[18px] h-[18px]">
      <rect x="3" y="4" width="18" height="17" rx="2"/>
      <path d="M3 10h18M8 2v4M16 2v4"/>
    </svg>
  ),
};

export default function DashboardStats() {
  const { rooms, bookings } = useHotel();

  // ── Today's date string (same format as booking.checkIn / checkOut) ──
  const TODAY_FMT = new Date().toLocaleDateString("en-US", {
    month: "short",
    day:   "numeric",
    year:  "numeric",
  });

  // ── Live counts derived from shared room state ─────────────
  const total        = rooms.length;
  const occupied     = rooms.filter(r => r.status === "Occupied").length;
  const available    = rooms.filter(r => r.status === "Available").length;
  const occupancyPct = total > 0 ? ((occupied / total) * 100).toFixed(1) : "0.0";

  // ── Today's arrivals / departures ──────────────────────────
  const todaysArrivals = useMemo(
    () => bookings.filter(b => b.checkIn === TODAY_FMT && b.status === "Confirmed").length,
    [bookings, TODAY_FMT]
  );
  const todaysDepartures = useMemo(
    () => bookings.filter(
      b => b.checkOut === TODAY_FMT && b.status !== "Cancelled" && b.status !== "Checked Out"
    ).length,
    [bookings, TODAY_FMT]
  );

  const stats = [
    {
      label:  "Total Rooms",
      value:  String(total),
      sub:    "Across 4 floors",
      icon:   Icons.bed,
      accent: "bg-slate-800",
      border: "border-l-slate-700",
    },
    {
      label:  "Occupied",
      value:  String(occupied),
      sub:    `${occupancyPct}% occupancy rate`,
      icon:   Icons.lock,
      accent: "bg-rose-500",
      border: "border-l-rose-400",
    },
    {
      label:  "Available",
      value:  String(available),
      sub:    "Ready for check-in",
      icon:   Icons.unlock,
      accent: "bg-emerald-500",
      border: "border-l-emerald-400",
    },
    {
      label:  "Today's Activity",
      value:  String(todaysArrivals + todaysDepartures),
      sub:    `${todaysArrivals} arrivals · ${todaysDepartures} departures`,
      icon:   Icons.cal,
      accent: "bg-amber-500",
      border: "border-l-amber-400",
    },
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      {stats.map((s) => (
        <div
          key={s.label}
          className={`bg-white rounded-xl border border-slate-200 border-l-[3px] ${s.border} shadow-sm px-5 py-4 flex items-center gap-4`}
        >
          <div className={`${s.accent} rounded-lg p-2.5 flex-shrink-0`}>
            <span className="text-white block">{s.icon}</span>
          </div>
          <div className="min-w-0">
            <p className="text-[12px] font-medium text-slate-500 truncate leading-none mb-1">
              {s.label}
            </p>
            <p className="text-[26px] font-bold text-slate-900 leading-none tracking-tight">
              {s.value}
            </p>
            <p className="text-[11.5px] text-slate-400 mt-1 leading-snug truncate">
              {s.sub}
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}

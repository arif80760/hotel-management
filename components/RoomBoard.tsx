"use client";

// components/RoomBoard.tsx
//
// The visual grid of all 48 hotel rooms on the Dashboard.
// Reads live room state from HotelContext, so the colour of every
// card updates instantly when a booking changes a room's status.
// Clicking a card navigates to /bookings?room=<number>.

import { useState, useMemo, useRef } from "react";
import Link from "next/link";
import { useHotel, type RoomStatus, type Room, type Booking, type BookingStatus } from "@/contexts/HotelContext";
import { deriveRoomStatusForDate, localDateToISO, TODAY_ISO } from "@/lib/roomStatus";

// ── Status colour config — single source of truth ────────────
const STATUS: Record<RoomStatus, {
  bg: string; border: string; dot: string;
  label: string; text: string;
}> = {
  Available:   { bg: "bg-emerald-50",  border: "border-emerald-200", dot: "bg-emerald-500", label: "Available",   text: "text-emerald-700" },
  Occupied:    { bg: "bg-rose-50",     border: "border-rose-200",    dot: "bg-rose-500",    label: "Occupied",    text: "text-rose-700"    },
  Reserved:    { bg: "bg-blue-50",     border: "border-blue-200",    dot: "bg-blue-500",    label: "Reserved",    text: "text-blue-700"    },
};

const SUMMARY_STATUSES: RoomStatus[] = ["Available", "Reserved", "Occupied"];

const ArrowRight = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
    <path d="M5 12h14M12 5l7 7-7 7"/>
  </svg>
);

const GridIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="w-[18px] h-[18px]">
    <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/>
    <rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>
  </svg>
);

// ── Status derivation helpers ─────────────────────────────────
// localDateToISO / TODAY_ISO / deriveRoomStatusForDate now live in
// lib/roomStatus.ts (imported above) — same logic, shared with the dashboard.

function getBookingForRoomOnDate(
  room: Room, dateISO: string, todayISO: string, bookings: Booking[],
): Booking | undefined {
  if (dateISO === todayISO) return undefined;
  return bookings.find(
    b =>
      b.status !== "Cancelled" &&
      ((dateISO > todayISO && (b.status === "Confirmed" || b.status === "Checked In")) ||
       (dateISO < todayISO && (b.status === "Checked In" || b.status === "Checked Out"))) &&
      b.rooms.some(
        r =>
          r.roomNumber === room.roomNumber &&
          r.status !== "Cancelled" &&
          r.checkInISO <= dateISO && dateISO < r.checkOutISO,
      ),
  );
}

/**
 * Returns a friendly short name for compact display.
 * Handles Bangla honorific prefixes: "Md. Abdullah Hassan" → "Md. Abdullah"
 * Simple names: "John Smith" → "John", "Tofazzol" → "Tofazzol"
 */
function extractFirstName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length <= 1) return parts[0] ?? "";
  // If first word ends with "." treat as honorific → include next word
  if (parts[0].endsWith(".")) return `${parts[0]} ${parts[1]}`;
  return parts[0];
}

export default function RoomBoard() {
  const { rooms, bookings, categoryName } = useHotel();

  const [selectedDate, setSelectedDate] = useState<string>(TODAY_ISO);
  const isToday = selectedDate === TODAY_ISO;

  // Display label: "Wed, May 7, 2026"
  const displayDate = new Date(selectedDate + "T12:00:00").toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric", year: "numeric",
  });

  function goPrev() {
    const d = new Date(selectedDate + "T12:00:00");
    d.setDate(d.getDate() - 1);
    setSelectedDate(localDateToISO(d));
  }

  function goNext() {
    const d = new Date(selectedDate + "T12:00:00");
    d.setDate(d.getDate() + 1);
    setSelectedDate(localDateToISO(d));
  }

  const dateInputRef = useRef<HTMLInputElement>(null);

  function handleDatePick(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = e.target.value;
    if (picked) setSelectedDate(picked);
  }

  // Derive display status for every room on the selected date
  const roomsWithDerivedStatus = useMemo(
    () => rooms.map(r => ({
      ...r,
      displayStatus: deriveRoomStatusForDate(r, selectedDate, TODAY_ISO, bookings),
      displayBooking: getBookingForRoomOnDate(r, selectedDate, TODAY_ISO, bookings),
    })),
    [rooms, bookings, selectedDate],
  );

  const statusCounts = useMemo(() => {
    const counts: Record<RoomStatus, number> = {
      Available: 0, Reserved: 0, Occupied: 0,
    };
    for (const room of roomsWithDerivedStatus) counts[room.displayStatus]++;
    return counts;
  }, [roomsWithDerivedStatus]);

  const totalRooms = roomsWithDerivedStatus.length;

  // Floor list derived from actual rooms data, sorted naturally.
  // Adding a new floor in DB (or via future settings module) appears
  // here automatically without code changes.
  const floorOrder = useMemo(
    () => Array.from(new Set(rooms.map(r => r.floor))).sort((a, b) => {
      // Natural sort: "Floor 1", "Floor 2", ..., "Floor 10"
      const numA = parseInt(a.replace(/\D/g, ""), 10) || 0;
      const numB = parseInt(b.replace(/\D/g, ""), 10) || 0;
      return numA - numB;
    }),
    [rooms],
  );
  const roomsByFloor = floorOrder.reduce<Record<string, typeof roomsWithDerivedStatus>>(
    (acc, floor) => {
      acc[floor] = roomsWithDerivedStatus.filter(r => r.floor === floor);
      return acc;
    },
    {}
  );

  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">

      {/* Card header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
        <div className="flex items-center gap-2.5">
          <span className="text-slate-600">{GridIcon}</span>
          <div>
            <h2 className="text-[14px] font-semibold text-slate-800 leading-none">Room Board</h2>
            <p className="text-[12px] text-slate-400 mt-0.5">
              All {rooms.length}{" "}rooms &mdash; click any room to view or create a booking
            </p>
          </div>
        </div>

        {/* Status legend */}
        <div className="hidden md:flex items-center gap-4">
          {SUMMARY_STATUSES.map((s) => (
            <div key={s} className="flex items-center gap-1.5">
              <span className={`w-2 h-2 rounded-full ${STATUS[s].dot} flex-shrink-0`} />
              <span className="text-[11.5px] font-medium text-slate-500">{s}</span>
            </div>
          ))}
        </div>
      </div>

      {/* ── Date navigation bar ─────────────────────────────── */}
      <div className="flex items-center justify-between px-6 py-2.5 border-b border-slate-100 bg-slate-50/50">

        {/* ← Prev */}
        <button
          onClick={goPrev}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-lg transition-colors"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
            <path d="M19 12H5M12 5l-7 7 7 7"/>
          </svg>
          Prev
        </button>

        {/* Centre: date label + calendar picker + Today badge */}
        <div className="flex items-center gap-3">
          <span className={`text-[13.5px] font-semibold ${isToday ? "text-slate-700" : "text-violet-700"}`}>
            {isToday ? `Today — ${displayDate}` : displayDate}
          </span>
          {/* Calendar picker button */}
          <button
            onClick={() => dateInputRef.current?.showPicker?.() ?? dateInputRef.current?.click()}
            title="Jump to date"
            className="p-1.5 rounded-lg text-slate-400 hover:text-amber-600 hover:bg-amber-50 transition-colors"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
              <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
              <line x1="16" y1="2" x2="16" y2="6"/>
              <line x1="8" y1="2" x2="8" y2="6"/>
              <line x1="3" y1="10" x2="21" y2="10"/>
            </svg>
          </button>
          {/* Hidden date input — triggered by the button above */}
          <input
            ref={dateInputRef}
            type="date"
            value={selectedDate}
            onChange={handleDatePick}
            className="absolute opacity-0 pointer-events-none w-0 h-0"
            aria-label="Jump to date"
          />
          <button
            onClick={() => setSelectedDate(TODAY_ISO)}
            disabled={isToday}
            className={`px-2.5 py-1 text-[11.5px] font-semibold rounded-full transition-colors ${
              isToday
                ? "bg-amber-100 text-amber-700 cursor-default"
                : "bg-slate-100 text-slate-500 hover:bg-amber-50 hover:text-amber-700 cursor-pointer"
            }`}
          >
            Today
          </button>
        </div>

        {/* Next → */}
        <button
          onClick={goNext}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-lg transition-colors"
        >
          Next
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
            <path d="M5 12h14M12 5l7 7-7 7"/>
          </svg>
        </button>
      </div>

      {/* ── Summary stats bar ──────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-6 py-2.5 border-b border-slate-100 text-[12px]">
        <span className="font-semibold text-slate-700">{totalRooms} rooms</span>
        <span className="text-slate-300 select-none">·</span>
        {SUMMARY_STATUSES.map((status, i, arr) => {
          const cfg = STATUS[status];
          const count = statusCounts[status];
          return (
            <span key={status} className="inline-flex items-center gap-1.5">
              <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${count > 0 ? cfg.dot : "bg-slate-200"}`} />
              <span className={count > 0 ? cfg.text : "text-slate-300"}>
                {count} {cfg.label}
              </span>
              {i < arr.length - 1 && <span className="text-slate-300 select-none ml-1">·</span>}
            </span>
          );
        })}
      </div>

      {/* Floor sections */}
      <div className="p-6 space-y-7">
        {floorOrder.map((floorLabel) => {
          const floorRooms = roomsByFloor[floorLabel] ?? [];
          const avail = floorRooms.filter(r => r.displayStatus === "Available").length;
          return (
            <div key={floorLabel}>

              {/* Floor label row */}
              <div className="flex items-center gap-3 mb-3">
                <span className="text-[11px] font-bold text-slate-500 uppercase tracking-widest whitespace-nowrap">
                  {floorLabel}
                </span>
                <div className="flex-1 h-px bg-slate-200" />
                <span className="text-[11px] font-semibold text-emerald-600 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full whitespace-nowrap">
                  {avail} available
                </span>
              </div>

              {/* Room cards */}
              <div
                className="grid gap-2.5"
                style={{ gridTemplateColumns: "repeat(auto-fill, minmax(100px, 1fr))" }}
              >
                {floorRooms.map((room) => {
                  const cfg = STATUS[room.displayStatus];
                  const isClickable = room.displayStatus === "Occupied";

                  const roomCard = (
                    <>
                      <span className="text-[17px] font-extrabold text-slate-800 leading-none tracking-tight">
                        {room.roomNumber}
                      </span>
                      <span className="text-[10.5px] font-medium text-slate-500 leading-none mt-1">
                        {categoryName(room.category)}
                      </span>
                      <div className="flex items-center gap-1 mt-2">
                        <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot} flex-shrink-0`} />
                        <span className={`text-[10.5px] font-semibold ${cfg.text} leading-none`}>
                          {cfg.label}
                        </span>
                      </div>
                      {room.displayBooking && (
                        <p className="text-[11px] text-slate-500 truncate mt-0.5 leading-none"
                           title={room.displayBooking.guestName}>
                          {extractFirstName(room.displayBooking.guestName)}
                        </p>
                      )}
                      {/* Hover arrow — only for occupied rooms */}
                      {isClickable && (
                        <span className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity text-slate-400">
                          {ArrowRight}
                        </span>
                      )}
                    </>
                  );

                  if (isClickable) {
                    // Occupied: clickable link
                    return (
                      <Link
                        key={room.roomNumber}
                        href={`/bookings?room=${room.roomNumber}`}
                        className={`
                          group relative flex flex-col justify-between
                          ${cfg.bg} border ${cfg.border}
                          rounded-lg px-3 py-2.5
                          hover:shadow-md hover:scale-[1.03]
                          active:scale-[0.98]
                          transition-all duration-150 cursor-pointer
                          min-h-[72px]
                        `}
                      >
                        {roomCard}
                      </Link>
                    );
                  }

                  // Available/Reserved: non-clickable div
                  return (
                    <div
                      key={room.roomNumber}
                      className={`
                        relative flex flex-col justify-between
                        ${cfg.bg} border ${cfg.border}
                        rounded-lg px-3 py-2.5
                        cursor-default
                        min-h-[72px]
                      `}
                    >
                      {roomCard}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {/* Mobile legend */}
      <div className="md:hidden flex flex-wrap gap-3 px-6 pb-5">
        {SUMMARY_STATUSES.map((s) => (
          <div key={s} className="flex items-center gap-1.5">
            <span className={`w-2 h-2 rounded-full ${STATUS[s].dot}`} />
            <span className="text-[11.5px] font-medium text-slate-500">{s}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

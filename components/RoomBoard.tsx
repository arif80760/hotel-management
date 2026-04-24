"use client";

// components/RoomBoard.tsx
//
// The visual grid of all 48 hotel rooms on the Dashboard.
// Reads live room state from HotelContext, so the colour of every
// card updates instantly when a booking changes a room's status.
// Clicking a card navigates to /bookings?room=<number>.

import Link from "next/link";
import { useHotel, type RoomStatus } from "@/contexts/HotelContext";

// ── Status colour config — single source of truth ────────────
const STATUS: Record<RoomStatus, {
  bg: string; border: string; dot: string;
  label: string; text: string;
}> = {
  Available:   { bg: "bg-emerald-50",  border: "border-emerald-200", dot: "bg-emerald-500", label: "Available",   text: "text-emerald-700" },
  Occupied:    { bg: "bg-rose-50",     border: "border-rose-200",    dot: "bg-rose-500",    label: "Occupied",    text: "text-rose-700"    },
  Reserved:    { bg: "bg-blue-50",     border: "border-blue-200",    dot: "bg-blue-500",    label: "Reserved",    text: "text-blue-700"    },
  Cleaning:    { bg: "bg-amber-50",    border: "border-amber-200",   dot: "bg-amber-500",   label: "Cleaning",    text: "text-amber-700"   },
  Maintenance: { bg: "bg-slate-100",   border: "border-slate-300",   dot: "bg-slate-400",   label: "Maintenance", text: "text-slate-500"   },
};

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

export default function RoomBoard() {
  const { rooms } = useHotel();

  // Group rooms by floor — order matches "Floor 1" → "Floor 4"
  const floorOrder = ["Floor 1", "Floor 2", "Floor 3", "Floor 4"];
  const roomsByFloor = floorOrder.reduce<Record<string, typeof rooms>>(
    (acc, floor) => {
      acc[floor] = rooms.filter(r => r.floor === floor);
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
              All {rooms.length} rooms &mdash; click any room to view or create a booking
            </p>
          </div>
        </div>

        {/* Status legend */}
        <div className="hidden md:flex items-center gap-4">
          {(Object.keys(STATUS) as RoomStatus[]).map((s) => (
            <div key={s} className="flex items-center gap-1.5">
              <span className={`w-2 h-2 rounded-full ${STATUS[s].dot} flex-shrink-0`} />
              <span className="text-[11.5px] font-medium text-slate-500">{s}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Floor sections */}
      <div className="p-6 space-y-7">
        {floorOrder.map((floorLabel) => {
          const floorRooms = roomsByFloor[floorLabel] ?? [];
          const avail = floorRooms.filter(r => r.status === "Available").length;
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
                  const cfg = STATUS[room.status];
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
                      <span className="text-[17px] font-extrabold text-slate-800 leading-none tracking-tight">
                        {room.roomNumber}
                      </span>
                      <span className="text-[10.5px] font-medium text-slate-500 leading-none mt-1">
                        {room.category}
                      </span>
                      <div className="flex items-center gap-1 mt-2">
                        <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot} flex-shrink-0`} />
                        <span className={`text-[10.5px] font-semibold ${cfg.text} leading-none`}>
                          {cfg.label}
                        </span>
                      </div>
                      {/* Hover arrow */}
                      <span className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity text-slate-400">
                        {ArrowRight}
                      </span>
                    </Link>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {/* Mobile legend */}
      <div className="md:hidden flex flex-wrap gap-3 px-6 pb-5">
        {(Object.keys(STATUS) as RoomStatus[]).map((s) => (
          <div key={s} className="flex items-center gap-1.5">
            <span className={`w-2 h-2 rounded-full ${STATUS[s].dot}`} />
            <span className="text-[11.5px] font-medium text-slate-500">{s}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

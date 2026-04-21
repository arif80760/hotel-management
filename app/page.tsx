// app/page.tsx — Dashboard
// Redesigned for Hotel Albatross Resort internal admin system.
// All data is static demo data — no database connected yet.
// The Room Board cards use Next.js <Link> to navigate to
// /bookings?room=XXX — this is a pure frontend behaviour.

import Link from "next/link";

// ─────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────
type BookingStatus = "Confirmed" | "Checked In" | "Checked Out" | "Cancelled";
type RoomStatus    = "Available" | "Occupied" | "Reserved" | "Cleaning" | "Maintenance";

type RoomCard = {
  number: string;
  type:   string;
  status: RoomStatus;
};

type RecentBooking = {
  id:       string;
  guest:    string;
  room:     string;
  checkIn:  string;
  checkOut: string;
  nights:   number;
  status:   BookingStatus;
  amount:   string;
};

type Arrival = {
  name:   string;
  room:   string;
  type:   string;
  nights: number;
  eta:    string;
};

// ─────────────────────────────────────────────────────────────
// INLINE SVG ICONS  (no package dependency)
// ─────────────────────────────────────────────────────────────
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
  grid: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="w-[18px] h-[18px]">
      <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/>
      <rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>
    </svg>
  ),
};

// ─────────────────────────────────────────────────────────────
// ROOM STATUS CONFIG — single source of truth for all colours
// ─────────────────────────────────────────────────────────────
const STATUS: Record<RoomStatus, {
  bg: string; border: string; dot: string; label: string;
  text: string; badgeBg: string; badgeText: string;
}> = {
  Available:   { bg: "bg-emerald-50",  border: "border-emerald-200", dot: "bg-emerald-500", label: "Available",   text: "text-emerald-700", badgeBg: "bg-emerald-100", badgeText: "text-emerald-700" },
  Occupied:    { bg: "bg-rose-50",     border: "border-rose-200",    dot: "bg-rose-500",    label: "Occupied",    text: "text-rose-700",    badgeBg: "bg-rose-100",    badgeText: "text-rose-700"    },
  Reserved:    { bg: "bg-blue-50",     border: "border-blue-200",    dot: "bg-blue-500",    label: "Reserved",    text: "text-blue-700",    badgeBg: "bg-blue-100",    badgeText: "text-blue-700"    },
  Cleaning:    { bg: "bg-amber-50",    border: "border-amber-200",   dot: "bg-amber-500",   label: "Cleaning",    text: "text-amber-700",   badgeBg: "bg-amber-100",   badgeText: "text-amber-700"   },
  Maintenance: { bg: "bg-slate-100",   border: "border-slate-300",   dot: "bg-slate-400",   label: "Maintenance", text: "text-slate-500",   badgeBg: "bg-slate-200",   badgeText: "text-slate-600"   },
};

// ─────────────────────────────────────────────────────────────
// DEMO DATA — stat cards
// Counts are consistent with the 48-room board below.
// ─────────────────────────────────────────────────────────────
const stats = [
  {
    label:   "Total Rooms",
    value:   "48",
    sub:     "Across 4 floors",
    icon:    Icons.bed,
    accent:  "bg-slate-800",
    border:  "border-l-slate-700",
  },
  {
    label:   "Occupied",
    value:   "31",
    sub:     "64.6% occupancy rate",
    icon:    Icons.lock,
    accent:  "bg-rose-500",
    border:  "border-l-rose-400",
  },
  {
    label:   "Available",
    value:   "12",
    sub:     "Ready for check-in",
    icon:    Icons.unlock,
    accent:  "bg-emerald-500",
    border:  "border-l-emerald-400",
  },
  {
    label:   "Today's Activity",
    value:   "9",
    sub:     "4 arrivals · 5 departures",
    icon:    Icons.cal,
    accent:  "bg-amber-500",
    border:  "border-l-amber-400",
  },
];

// ─────────────────────────────────────────────────────────────
// DEMO DATA — today's arrivals
// ─────────────────────────────────────────────────────────────
const arrivals: Arrival[] = [
  { name: "James Whitfield", room: "204", type: "Deluxe", nights: 3, eta: "14:00" },
  { name: "Priya Nair",      room: "312", type: "Suite",  nights: 5, eta: "15:30" },
  { name: "Carlos Mendez",   room: "115", type: "Double", nights: 2, eta: "16:00" },
  { name: "Sophie Laurent",  room: "408", type: "Suite",  nights: 7, eta: "17:15" },
];

const departures: Arrival[] = [
  { name: "Robert Kim",    room: "101", type: "Single", nights: 2, eta: "10:00" },
  { name: "Amina Hassan",  room: "230", type: "Double", nights: 4, eta: "10:30" },
  { name: "David Okoye",   room: "305", type: "Deluxe", nights: 3, eta: "11:00" },
  { name: "Yuki Tanaka",   room: "412", type: "Suite",  nights: 6, eta: "11:30" },
  { name: "Maria Santos",  room: "118", type: "Family", nights: 5, eta: "12:00" },
];

// Occupancy by floor (matches room board below)
const floors = [
  { label: "Floor 1", occupied: 9,  total: 14 },
  { label: "Floor 2", occupied: 7,  total: 12 },
  { label: "Floor 3", occupied: 8,  total: 12 },
  { label: "Floor 4", occupied: 7,  total: 10 },
];

// ─────────────────────────────────────────────────────────────
// DEMO DATA — recent bookings table
// ─────────────────────────────────────────────────────────────
const recentBookings: RecentBooking[] = [
  { id: "BK-1041", guest: "James Whitfield", room: "204", checkIn: "Apr 21", checkOut: "Apr 24", nights: 3, status: "Confirmed",   amount: "$537"   },
  { id: "BK-1040", guest: "Priya Nair",      room: "312", checkIn: "Apr 21", checkOut: "Apr 26", nights: 5, status: "Confirmed",   amount: "$1,245" },
  { id: "BK-1039", guest: "Robert Kim",      room: "101", checkIn: "Apr 19", checkOut: "Apr 21", nights: 2, status: "Checked Out", amount: "$178"   },
  { id: "BK-1038", guest: "Amina Hassan",    room: "230", checkIn: "Apr 17", checkOut: "Apr 21", nights: 4, status: "Checked Out", amount: "$516"   },
  { id: "BK-1037", guest: "Sophie Laurent",  room: "408", checkIn: "Apr 21", checkOut: "Apr 28", nights: 7, status: "Checked In",  amount: "$2,093" },
];

function bookingBadge(s: BookingStatus) {
  const m: Record<BookingStatus, string> = {
    "Confirmed":   "bg-blue-50 text-blue-700 ring-1 ring-blue-200",
    "Checked In":  "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200",
    "Checked Out": "bg-slate-100 text-slate-500 ring-1 ring-slate-200",
    "Cancelled":   "bg-red-50 text-red-600 ring-1 ring-red-200",
  };
  return m[s];
}

// ─────────────────────────────────────────────────────────────
// DEMO DATA — Room Board  (48 rooms, 4 floors)
// Counts: Occupied=31, Available=12, Cleaning=2,
//         Maintenance=1, Reserved=2  →  total=48
// Each card links to /bookings?room=<number>
// ─────────────────────────────────────────────────────────────
const roomsByFloor: Record<string, RoomCard[]> = {
  "Floor 1": [
    { number: "101", type: "Single",  status: "Occupied"    },
    { number: "102", type: "Single",  status: "Available"   },
    { number: "103", type: "Double",  status: "Occupied"    },
    { number: "104", type: "Double",  status: "Cleaning"    },
    { number: "105", type: "Double",  status: "Occupied"    },
    { number: "106", type: "Double",  status: "Available"   },
    { number: "107", type: "Family",  status: "Occupied"    },
    { number: "108", type: "Family",  status: "Occupied"    },
    { number: "109", type: "Double",  status: "Occupied"    },
    { number: "110", type: "Double",  status: "Maintenance" },
    { number: "111", type: "Single",  status: "Occupied"    },
    { number: "112", type: "Single",  status: "Available"   },
    { number: "113", type: "Double",  status: "Occupied"    },
    { number: "114", type: "Double",  status: "Occupied"    },
  ],
  "Floor 2": [
    { number: "201", type: "Deluxe",  status: "Occupied"   },
    { number: "202", type: "Deluxe",  status: "Occupied"   },
    { number: "203", type: "Suite",   status: "Available"  },
    { number: "204", type: "Deluxe",  status: "Occupied"   },
    { number: "205", type: "Deluxe",  status: "Occupied"   },
    { number: "206", type: "Suite",   status: "Reserved"   },
    { number: "207", type: "Double",  status: "Occupied"   },
    { number: "208", type: "Double",  status: "Cleaning"   },
    { number: "209", type: "Deluxe",  status: "Available"  },
    { number: "210", type: "Deluxe",  status: "Occupied"   },
    { number: "211", type: "Suite",   status: "Available"  },
    { number: "212", type: "Double",  status: "Occupied"   },
  ],
  "Floor 3": [
    { number: "301", type: "Suite",   status: "Occupied"   },
    { number: "302", type: "Double",  status: "Occupied"   },
    { number: "303", type: "Deluxe",  status: "Available"  },
    { number: "304", type: "Deluxe",  status: "Occupied"   },
    { number: "305", type: "Deluxe",  status: "Reserved"   },
    { number: "306", type: "Suite",   status: "Occupied"   },
    { number: "307", type: "Double",  status: "Occupied"   },
    { number: "308", type: "Double",  status: "Available"  },
    { number: "309", type: "Deluxe",  status: "Occupied"   },
    { number: "310", type: "Double",  status: "Occupied"   },
    { number: "311", type: "Double",  status: "Available"  },
    { number: "312", type: "Suite",   status: "Occupied"   },
  ],
  "Floor 4": [
    { number: "401", type: "Suite",   status: "Occupied"   },
    { number: "402", type: "Suite",   status: "Occupied"   },
    { number: "403", type: "Suite",   status: "Available"  },
    { number: "404", type: "Suite",   status: "Occupied"   },
    { number: "405", type: "Suite",   status: "Available"  },
    { number: "406", type: "Suite",   status: "Occupied"   },
    { number: "407", type: "Suite",   status: "Occupied"   },
    { number: "408", type: "Suite",   status: "Occupied"   },
    { number: "409", type: "Suite",   status: "Occupied"   },
    { number: "410", type: "Suite",   status: "Available"  },
  ],
};

// ─────────────────────────────────────────────────────────────
// HELPER — initials from a full name
// ─────────────────────────────────────────────────────────────
function initials(name: string) {
  return name.split(" ").map(n => n[0]).join("").slice(0, 2).toUpperCase();
}

// ─────────────────────────────────────────────────────────────
// PAGE
// ─────────────────────────────────────────────────────────────
export default function DashboardPage() {
  return (
    <div className="p-7 space-y-6 max-w-[1440px]">

      {/* ══════════════════════════════════════════════════════
          SECTION 1 — Page heading
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
        {/* Live indicator */}
        <div className="flex items-center gap-2 text-[12px] text-slate-400 font-medium">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
          </span>
          Live
        </div>
      </div>

      {/* ══════════════════════════════════════════════════════
          SECTION 2 — KPI stat cards
      ══════════════════════════════════════════════════════ */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {stats.map((s) => (
          <div
            key={s.label}
            className={`bg-white rounded-xl border border-slate-200 border-l-[3px] ${s.border} shadow-sm px-5 py-4 flex items-center gap-4`}
          >
            {/* Icon in a soft circle */}
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

      {/* ══════════════════════════════════════════════════════
          SECTION 3 — Arrivals / Departures  +  Occupancy
      ══════════════════════════════════════════════════════ */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-5">

        {/* ── Arrivals & Departures panel (3/5 width) ── */}
        <div className="lg:col-span-3 bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">

          {/* Tab header */}
          <div className="flex border-b border-slate-200">
            {/* Arrivals tab — active */}
            <div className="flex items-center gap-2 px-5 py-3.5 border-b-2 border-amber-500 cursor-default select-none">
              <span className="text-amber-500">{Icons.loginArrow}</span>
              <span className="text-[13px] font-semibold text-slate-800">Arrivals</span>
              <span className="bg-amber-100 text-amber-700 text-[11px] font-bold px-1.5 py-0.5 rounded-full leading-none">
                {arrivals.length}
              </span>
            </div>
            {/* Departures tab — inactive */}
            <div className="flex items-center gap-2 px-5 py-3.5 cursor-default select-none">
              <span className="text-slate-400">{Icons.logoutArrow}</span>
              <span className="text-[13px] font-medium text-slate-400">Departures</span>
              <span className="bg-slate-100 text-slate-500 text-[11px] font-bold px-1.5 py-0.5 rounded-full leading-none">
                {departures.length}
              </span>
            </div>
          </div>

          {/* Arrivals list */}
          <ul className="divide-y divide-slate-100">
            {arrivals.map((a) => (
              <li
                key={a.name}
                className="flex items-center justify-between px-5 py-3 hover:bg-slate-50/80 transition-colors"
              >
                <div className="flex items-center gap-3 min-w-0">
                  {/* Avatar initials */}
                  <div className="w-8 h-8 rounded-full bg-slate-100 flex items-center justify-center flex-shrink-0">
                    <span className="text-[11px] font-bold text-slate-500">
                      {initials(a.name)}
                    </span>
                  </div>
                  <div className="min-w-0">
                    <p className="text-[13px] font-semibold text-slate-800 truncate">{a.name}</p>
                    <p className="text-[12px] text-slate-400">
                      Room {a.room}&nbsp;·&nbsp;{a.type}&nbsp;·&nbsp;{a.nights} night{a.nights !== 1 ? "s" : ""}
                    </p>
                  </div>
                </div>
                {/* ETA chip */}
                <div className="flex-shrink-0 ml-4 text-right">
                  <span className="text-[11px] font-semibold text-slate-500 bg-slate-100 px-2.5 py-1 rounded-full">
                    ETA {a.eta}
                  </span>
                </div>
              </li>
            ))}
          </ul>

          {/* Footer link */}
          <div className="px-5 py-3 border-t border-slate-100 bg-slate-50">
            <Link
              href="/bookings"
              className="inline-flex items-center gap-1.5 text-[12px] font-medium text-amber-600 hover:text-amber-700 transition-colors"
            >
              View all bookings {Icons.arrowRight}
            </Link>
          </div>
        </div>

        {/* ── Occupancy by floor (2/5 width) ── */}
        <div className="lg:col-span-2 bg-white rounded-xl border border-slate-200 shadow-sm p-5 flex flex-col">

          {/* Card header */}
          <div className="flex items-center gap-2.5 mb-1">
            <span className="text-slate-600">{Icons.trend}</span>
            <h2 className="text-[13.5px] font-semibold text-slate-800">Occupancy by Floor</h2>
          </div>
          <p className="text-[12px] text-slate-400 mb-5">Current room usage per floor</p>

          <div className="space-y-4 flex-1">
            {floors.map((f) => {
              const pct = Math.round((f.occupied / f.total) * 100);
              // Colour the bar based on occupancy level
              const barColor =
                pct >= 80 ? "bg-rose-400"
                : pct >= 60 ? "bg-amber-400"
                : "bg-emerald-400";

              return (
                <div key={f.label}>
                  <div className="flex justify-between items-baseline mb-1.5">
                    <span className="text-[12.5px] font-semibold text-slate-700">{f.label}</span>
                    <div className="flex items-baseline gap-1.5">
                      <span className="text-[13px] font-bold text-slate-800">{pct}%</span>
                      <span className="text-[11px] text-slate-400">{f.occupied}/{f.total}</span>
                    </div>
                  </div>
                  {/* Track */}
                  <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
                    <div
                      className={`h-full ${barColor} rounded-full`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>

          {/* Overall occupancy summary */}
          <div className="mt-5 pt-4 border-t border-slate-100 flex items-center justify-between">
            <span className="text-[12px] text-slate-500">Overall occupancy</span>
            <span className="text-[14px] font-bold text-slate-900">64.6%</span>
          </div>
        </div>
      </div>

      {/* ══════════════════════════════════════════════════════
          SECTION 4 — ROOM BOARD
          A visual grid of every room in the hotel.
          Colour-coded by status. Clicking a room opens
          the Bookings page with that room pre-selected.
      ══════════════════════════════════════════════════════ */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">

        {/* Card header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
          <div className="flex items-center gap-2.5">
            <span className="text-slate-600">{Icons.grid}</span>
            <div>
              <h2 className="text-[14px] font-semibold text-slate-800 leading-none">Room Board</h2>
              <p className="text-[12px] text-slate-400 mt-0.5">
                All 48 rooms &mdash; click any room to view its bookings
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
          {Object.entries(roomsByFloor).map(([floorLabel, rooms]) => {
            // Count available rooms on this floor for a quick visual cue
            const avail = rooms.filter(r => r.status === "Available").length;
            return (
              <div key={floorLabel}>

                {/* Floor label row */}
                <div className="flex items-center gap-3 mb-3">
                  <span className="text-[11px] font-bold text-slate-500 uppercase tracking-widest whitespace-nowrap">
                    {floorLabel}
                  </span>
                  {/* Thin rule */}
                  <div className="flex-1 h-px bg-slate-200" />
                  {/* Available count badge */}
                  <span className="text-[11px] font-semibold text-emerald-600 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full whitespace-nowrap">
                    {avail} available
                  </span>
                </div>

                {/* Room cards grid */}
                <div className="grid gap-2.5"
                  style={{ gridTemplateColumns: "repeat(auto-fill, minmax(100px, 1fr))" }}
                >
                  {rooms.map((room) => {
                    const cfg = STATUS[room.status];
                    return (
                      /*
                        Each card is a Next.js Link — clicking navigates to
                        /bookings?room=<number> (pure frontend URL param).
                      */
                      <Link
                        key={room.number}
                        href={`/bookings?room=${room.number}`}
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
                        {/* Room number — dominant element */}
                        <span className="text-[17px] font-extrabold text-slate-800 leading-none tracking-tight">
                          {room.number}
                        </span>

                        {/* Room type — small label */}
                        <span className="text-[10.5px] font-medium text-slate-500 leading-none mt-1">
                          {room.type}
                        </span>

                        {/* Status row */}
                        <div className="flex items-center gap-1 mt-2">
                          <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot} flex-shrink-0`} />
                          <span className={`text-[10.5px] font-semibold ${cfg.text} leading-none`}>
                            {cfg.label}
                          </span>
                        </div>

                        {/* Hover arrow hint */}
                        <span className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity text-slate-400">
                          {Icons.arrowRight}
                        </span>
                      </Link>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>

        {/* Mobile legend (hidden on md+) */}
        <div className="md:hidden flex flex-wrap gap-3 px-6 pb-5">
          {(Object.keys(STATUS) as RoomStatus[]).map((s) => (
            <div key={s} className="flex items-center gap-1.5">
              <span className={`w-2 h-2 rounded-full ${STATUS[s].dot}`} />
              <span className="text-[11.5px] font-medium text-slate-500">{s}</span>
            </div>
          ))}
        </div>
      </div>

      {/* ══════════════════════════════════════════════════════
          SECTION 5 — Recent Bookings table
      ══════════════════════════════════════════════════════ */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">

        {/* Card header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
          <div>
            <h2 className="text-[14px] font-semibold text-slate-800 leading-none">
              Recent Bookings
            </h2>
            <p className="text-[12px] text-slate-400 mt-0.5">
              Latest reservations across all rooms
            </p>
          </div>
          <Link
            href="/bookings"
            className="inline-flex items-center gap-1.5 text-[12px] font-medium text-amber-600 hover:text-amber-700 transition-colors"
          >
            View all {Icons.arrowRight}
          </Link>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200">
                {["ID", "Guest", "Room", "Check-in", "Check-out", "Nights", "Status", "Amount"].map((h) => (
                  <th
                    key={h}
                    className="text-left px-6 py-3 text-[11px] font-semibold text-slate-400 uppercase tracking-wider whitespace-nowrap"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {recentBookings.map((b) => (
                <tr key={b.id} className="hover:bg-slate-50/70 transition-colors">
                  <td className="px-6 py-3.5 font-mono text-[11.5px] text-slate-400 whitespace-nowrap">
                    {b.id}
                  </td>
                  <td className="px-6 py-3.5">
                    {/* Avatar + name inline */}
                    <div className="flex items-center gap-2.5">
                      <div className="w-6 h-6 rounded-full bg-slate-100 flex items-center justify-center flex-shrink-0">
                        <span className="text-[9px] font-bold text-slate-500">
                          {initials(b.guest)}
                        </span>
                      </div>
                      <span className="font-semibold text-slate-800 whitespace-nowrap">{b.guest}</span>
                    </div>
                  </td>
                  <td className="px-6 py-3.5 font-medium text-slate-600 whitespace-nowrap">
                    Rm {b.room}
                  </td>
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
                  <td className="px-6 py-3.5 font-bold text-slate-800 whitespace-nowrap">
                    {b.amount}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Table footer */}
        <div className="px-6 py-3 border-t border-slate-100 bg-slate-50">
          <p className="text-[12px] text-slate-400">
            Showing 5 most recent &mdash; {" "}
            <Link href="/bookings" className="text-amber-600 hover:underline font-medium">
              see all bookings
            </Link>
          </p>
        </div>
      </div>

    </div>
  );
}

"use client";

// app/rooms/analytics/RoomAnalyticsClient.tsx
//
// Room Analytics dashboard — read-only.  All metrics come from two
// server-side RPCs (room_analytics_by_room, room_occupancy_trend).
// No additional npm packages — charts are dependency-free SVG/CSS.
//
// KPI denominators EXCLUDE maintenance rooms (where room_status = 'maintenance').
// Per-room occupancy% in the table is NOT capped — values > 100 surface
// genuine double-bookings recorded in the DB.
// ─────────────────────────────────────────────────────────────

import { useState, useEffect, useMemo } from "react";
import {
  getRoomAnalyticsByRoom,
  getRoomOccupancyTrend,
  type RoomAnalyticsRow,
  type OccupancyTrendRow,
} from "@/services/roomAnalyticsService";

// ─────────────────────────────────────────────────────────────
// DATE UTILITIES
// ─────────────────────────────────────────────────────────────

function formatISO(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function todayISO(): string { return formatISO(new Date()); }
function firstOfMonthISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}
function shiftDays(from: Date, n: number): Date {
  const d = new Date(from);
  d.setDate(d.getDate() + n);
  return d;
}
function monthLabel(iso: string): string {
  return new Date(iso + "-01T12:00:00").toLocaleDateString("en-GB", { month: "short", year: "numeric" });
}
function dayLabel(iso: string): string {
  return new Date(iso + "T12:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

// ─────────────────────────────────────────────────────────────
// FORMAT HELPERS
// ─────────────────────────────────────────────────────────────

function fmt(n: number, dp = 2): string {
  return new Intl.NumberFormat("en-IN", {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  }).format(n);
}
function fmtPct(n: number): string { return `${fmt(n, 1)}%`; }
function cap(s: string): string { return s.charAt(0).toUpperCase() + s.slice(1); }

// ─────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────

type Preset = "today" | "last7" | "last30" | "this_month" | "this_year" | "custom";
type SortKey = "roomNumber" | "category" | "occupancyPct" | "bookings" | "revenue" | "adr" | "revpar";

// ─────────────────────────────────────────────────────────────
// CHART COMPONENTS
// ─────────────────────────────────────────────────────────────

/** Horizontal CSS progress bar. */
function Bar({ value, max, color = "bg-amber-500" }: { value: number; max: number; color?: string }) {
  return (
    <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
      <div
        className={`h-full rounded-full ${color}`}
        style={{ width: max > 0 ? `${Math.min(100, (value / max) * 100)}%` : "0%" }}
      />
    </div>
  );
}

/** SVG polyline chart for occupancy % over time. */
function OccupancyLineChart({ data }: { data: { label: string; occupancyPct: number }[] }) {
  if (data.length === 0) {
    return <p className="text-[13px] text-slate-400 italic py-6 text-center">No trend data for this range.</p>;
  }

  const W = 600, H = 170;
  const padL = 44, padR = 14, padT = 14, padB = 32;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const n = data.length;
  const xPos = (i: number) => padL + (n > 1 ? (i / (n - 1)) * plotW : plotW / 2);
  const yPos = (pct: number) => padT + plotH - Math.max(0, Math.min(pct, 100)) / 100 * plotH;

  const linePoints  = data.map((d, i) => `${xPos(i).toFixed(1)},${yPos(d.occupancyPct).toFixed(1)}`).join(" ");
  const areaPoints  = [
    `${xPos(0).toFixed(1)},${(padT + plotH).toFixed(1)}`,
    ...data.map((d, i) => `${xPos(i).toFixed(1)},${yPos(d.occupancyPct).toFixed(1)}`),
    `${xPos(n - 1).toFixed(1)},${(padT + plotH).toFixed(1)}`,
  ].join(" ");

  // Show ~7 x-axis labels max; always show first + last
  const labelStep = Math.max(1, Math.ceil(n / 7));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: H }}>
      {/* Horizontal grid + Y-axis labels */}
      {[0, 25, 50, 75, 100].map(pct => (
        <g key={pct}>
          <line
            x1={padL} y1={yPos(pct).toFixed(1)}
            x2={W - padR} y2={yPos(pct).toFixed(1)}
            stroke="#f1f5f9" strokeWidth="1"
          />
          <text
            x={padL - 6} y={yPos(pct).toFixed(1)}
            textAnchor="end" dominantBaseline="middle"
            fontSize="10" fill="#94a3b8"
          >{pct}%</text>
        </g>
      ))}

      {/* Area fill */}
      <polygon points={areaPoints} fill="#3b82f6" fillOpacity="0.07" />

      {/* Line */}
      <polyline
        points={linePoints}
        fill="none"
        stroke="#3b82f6"
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />

      {/* Dots — only when few data points */}
      {n <= 62 && data.map((d, i) => (
        <circle
          key={i}
          cx={xPos(i).toFixed(1)}
          cy={yPos(d.occupancyPct).toFixed(1)}
          r="3"
          fill="#3b82f6"
          stroke="white"
          strokeWidth="1.5"
        />
      ))}

      {/* X-axis labels */}
      {data.map((d, i) => {
        const showLabel = i === 0 || i === n - 1 || i % labelStep === 0;
        if (!showLabel) return null;
        return (
          <text
            key={i}
            x={xPos(i).toFixed(1)}
            y={H - 6}
            textAnchor="middle"
            fontSize="10"
            fill="#94a3b8"
          >{d.label}</text>
        );
      })}
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────
// CATEGORY BADGE COLOUR (matches RoomsClient)
// ─────────────────────────────────────────────────────────────
function catBadge(slug: string): string {
  const m: Record<string, string> = {
    single: "bg-slate-100  text-slate-600",
    double: "bg-blue-50    text-blue-700",
    deluxe: "bg-violet-50  text-violet-700",
    suite:  "bg-amber-50   text-amber-700",
    family: "bg-teal-50    text-teal-700",
  };
  return m[slug] ?? "bg-slate-100 text-slate-500";
}

// ─────────────────────────────────────────────────────────────
// SORT HELPERS
// ─────────────────────────────────────────────────────────────
function sortNumVal(row: RoomAnalyticsRow, key: SortKey, dir: "asc" | "desc"): number {
  if (key === "adr") return row.adr ?? (dir === "asc" ? Infinity : -Infinity);
  if (key === "roomNumber") return 0; // handled separately
  if (key === "category")   return 0; // handled separately
  return row[key] as number;
}

// ─────────────────────────────────────────────────────────────
// MAIN COMPONENT
// ─────────────────────────────────────────────────────────────

export default function RoomAnalyticsClient() {
  // ── Data state ───────────────────────────────────────────
  const [rows,    setRows]    = useState<RoomAnalyticsRow[]>([]);
  const [trend,   setTrend]   = useState<OccupancyTrendRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);

  // ── Date range state ────────────────────────────────────
  const [preset,   setPreset]   = useState<Preset>("this_month");
  const [fromDate, setFromDate] = useState<string>(firstOfMonthISO);
  const [toDate,   setToDate]   = useState<string>(todayISO);

  // ── Table sort state ─────────────────────────────────────
  const [sortKey, setSortKey] = useState<SortKey>("revenue");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  // ── Load ─────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      getRoomAnalyticsByRoom(fromDate, toDate),
      getRoomOccupancyTrend(fromDate, toDate),
    ])
      .then(([r, t]) => {
        if (!cancelled) { setRows(r); setTrend(t); }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load analytics.");
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [fromDate, toDate]);

  // ── Preset handler ───────────────────────────────────────
  function applyPreset(p: Preset) {
    setPreset(p);
    if (p === "custom") return;
    const now = new Date();
    const today = formatISO(now);
    if (p === "today") {
      setFromDate(today); setToDate(today);
    } else if (p === "last7") {
      setFromDate(formatISO(shiftDays(now, -6))); setToDate(today);
    } else if (p === "last30") {
      setFromDate(formatISO(shiftDays(now, -29))); setToDate(today);
    } else if (p === "this_month") {
      setFromDate(firstOfMonthISO()); setToDate(today);
    } else if (p === "this_year") {
      setFromDate(`${now.getFullYear()}-01-01`); setToDate(today);
    }
  }

  // ── KPI derivations ──────────────────────────────────────
  const nonMaint    = useMemo(() => rows.filter(r => r.roomStatus !== "maintenance"), [rows]);
  const allBookings = useMemo(() => rows.reduce((s, r) => s + r.bookings, 0),        [rows]);
  const totalRev    = useMemo(() => rows.reduce((s, r) => s + r.revenue, 0),         [rows]);

  const sumOccNights  = useMemo(() => nonMaint.reduce((s, r) => s + r.occupiedNights,  0), [nonMaint]);
  const sumAvailNight = useMemo(() => nonMaint.reduce((s, r) => s + r.availableNights, 0), [nonMaint]);

  const kpiOccupancy     = sumAvailNight > 0 ? (100 * sumOccNights) / sumAvailNight : 0;
  const kpiRevpar        = sumAvailNight > 0 ? totalRev / sumAvailNight              : 0;
  const kpiAdr           = sumOccNights  > 0 ? totalRev / sumOccNights               : null;
  const kpiAvgStay       = allBookings   > 0 ? sumOccNights / allBookings            : 0;
  const kpiOccupiedToday = rows.filter(r => r.roomStatus === "occupied").length;
  const kpiTopRoom       = useMemo(() => {
    if (rows.length === 0) return null;
    return rows.reduce((best, r) => (r.revenue > best.revenue ? r : best), rows[0]);
  }, [rows]);

  // ── Sorted table rows ────────────────────────────────────
  const sortedRows = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => {
      if (sortKey === "roomNumber") {
        const cmp = a.roomNumber.localeCompare(b.roomNumber, undefined, { numeric: true });
        return sortDir === "asc" ? cmp : -cmp;
      }
      if (sortKey === "category") {
        const cmp = a.category.localeCompare(b.category);
        return sortDir === "asc" ? cmp : -cmp;
      }
      const av = sortNumVal(a, sortKey, sortDir);
      const bv = sortNumVal(b, sortKey, sortDir);
      return sortDir === "asc" ? av - bv : bv - av;
    });
    return copy;
  }, [rows, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir(d => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir("desc"); }
  }

  function SortIcon({ col }: { col: SortKey }) {
    if (sortKey !== col) {
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3 h-3 text-slate-300 inline ml-1">
          <path d="M7 15l5 5 5-5M7 9l5-5 5 5"/>
        </svg>
      );
    }
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3 h-3 text-amber-500 inline ml-1">
        {sortDir === "desc"
          ? <path d="M7 15l5 5 5-5"/>
          : <path d="M7 9l5-5 5 5"/>
        }
      </svg>
    );
  }

  // ── Top / bottom rooms ───────────────────────────────────
  const topBooked = useMemo(
    () => [...rows].sort((a, b) => b.bookings - a.bookings).slice(0, 10),
    [rows],
  );
  const bottomBooked = useMemo(
    () => [...rows].sort((a, b) => a.bookings - b.bookings).slice(0, 10),
    [rows],
  );

  // ── Room-type performance ────────────────────────────────
  type TypeRow = { category: string; roomCount: number; occupancyPct: number; revenue: number };
  const byType: TypeRow[] = useMemo(() => {
    const map = new Map<string, { occ: number; avail: number; rev: number; cnt: number }>();
    for (const r of rows) {
      const prev = map.get(r.category) ?? { occ: 0, avail: 0, rev: 0, cnt: 0 };
      const isNonMaint = r.roomStatus !== "maintenance";
      map.set(r.category, {
        occ:   prev.occ   + (isNonMaint ? r.occupiedNights  : 0),
        avail: prev.avail + (isNonMaint ? r.availableNights : 0),
        rev:   prev.rev   + r.revenue,
        cnt:   prev.cnt   + 1,
      });
    }
    return [...map.entries()]
      .map(([category, { occ, avail, rev, cnt }]) => ({
        category,
        roomCount:    cnt,
        occupancyPct: avail > 0 ? (100 * occ) / avail : 0,
        revenue:      rev,
      }))
      .sort((a, b) => b.revenue - a.revenue);
  }, [rows]);

  // ── Revenue chart data (all rooms, sorted desc) ──────────
  const revChartData = useMemo(
    () => [...rows].sort((a, b) => b.revenue - a.revenue),
    [rows],
  );
  const maxRevenue = revChartData.reduce((m, r) => Math.max(m, r.revenue), 0);

  // ── Occupancy trend (daily or monthly rollup) ────────────
  const trendChartData = useMemo(() => {
    if (trend.length === 0) return [];
    if (trend.length <= 62) {
      return trend.map(d => ({ label: dayLabel(d.day), occupancyPct: d.occupancyPct }));
    }
    // Monthly rollup
    const monthMap = new Map<string, { occ: number; avail: number }>();
    for (const d of trend) {
      const k = d.day.slice(0, 7);
      const prev = monthMap.get(k) ?? { occ: 0, avail: 0 };
      monthMap.set(k, { occ: prev.occ + d.occupiedRooms, avail: prev.avail + d.availableRooms });
    }
    return [...monthMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, { occ, avail }]) => ({
        label: monthLabel(k),
        occupancyPct: avail > 0 ? (100 * occ) / avail : 0,
      }));
  }, [trend]);
  const trendGranularity = trend.length > 62 ? "monthly" : "daily";

  // ─────────────────────────────────────────────────────────
  // RENDER — loading / error states
  // ─────────────────────────────────────────────────────────
  const filterBar = (
    <div className="flex flex-wrap items-center gap-3 bg-white border border-slate-200 rounded-xl px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        {(
          [
            ["today",      "Today"],
            ["last7",      "Last 7 days"],
            ["last30",     "Last 30 days"],
            ["this_month", "This month"],
            ["this_year",  "This year"],
          ] as [Preset, string][]
        ).map(([p, label]) => (
          <button
            key={p}
            type="button"
            onClick={() => applyPreset(p)}
            className={`px-3 py-1.5 rounded-md text-[12.5px] font-semibold transition-colors ${
              preset === p
                ? "bg-amber-100 text-amber-800 border border-amber-300"
                : "bg-slate-50 text-slate-600 border border-slate-200 hover:bg-slate-100"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-2 ml-auto">
        <span className="text-[12px] font-semibold text-slate-500 uppercase tracking-wider">From</span>
        <input
          type="date"
          value={fromDate}
          max={toDate || todayISO()}
          onChange={(e) => { setFromDate(e.target.value); setPreset("custom"); }}
          className="px-2.5 py-1.5 text-[13px] text-slate-800 bg-white border border-slate-200 rounded-md
            focus:outline-none focus:ring-2 focus:ring-amber-400"
        />
        <span className="text-[12px] font-semibold text-slate-500 uppercase tracking-wider">To</span>
        <input
          type="date"
          value={toDate}
          min={fromDate || undefined}
          max={todayISO()}
          onChange={(e) => { setToDate(e.target.value); setPreset("custom"); }}
          className="px-2.5 py-1.5 text-[13px] text-slate-800 bg-white border border-slate-200 rounded-md
            focus:outline-none focus:ring-2 focus:ring-amber-400"
        />
      </div>
    </div>
  );

  if (loading) {
    return (
      <div className="p-8 space-y-5">
        <div>
          <h1 className="text-[22px] font-semibold text-slate-900 tracking-tight">Room Analytics</h1>
          <p className="text-[13px] text-slate-500 mt-1">Performance metrics across all rooms for the selected period.</p>
        </div>
        {filterBar}
        <div className="rounded-xl border border-dashed border-slate-200 bg-white px-6 py-16 flex items-center justify-center text-[13px] text-slate-400">
          Loading analytics…
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-8 space-y-5">
        <h1 className="text-[22px] font-semibold text-slate-900 tracking-tight">Room Analytics</h1>
        {filterBar}
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-6 py-4 text-[13px] text-rose-700">{error}</div>
      </div>
    );
  }

  // ─────────────────────────────────────────────────────────
  // RENDER — main dashboard
  // ─────────────────────────────────────────────────────────
  return (
    <div className="p-8 space-y-5 max-w-[1400px]">

      {/* ── Header ──────────────────────────────────────── */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-[22px] font-semibold text-slate-900 tracking-tight leading-none">Room Analytics</h1>
          <p className="text-[13px] text-slate-500 mt-1">
            Performance metrics across all rooms for the selected period.
          </p>
        </div>
        <a
          href="/rooms"
          className="px-4 py-2 rounded-lg bg-white border border-slate-200 text-slate-700 text-[13px] font-semibold hover:bg-slate-50 hover:border-slate-300 transition-colors"
        >
          ← Rooms
        </a>
      </div>

      {/* ── Filter bar ──────────────────────────────────── */}
      {filterBar}

      {/* ── KPI cards ───────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {/* Occupancy % */}
        <div className="rounded-xl border border-slate-200 bg-white px-5 py-4">
          <p className="text-[11.5px] font-semibold text-slate-400 uppercase tracking-wider">Occupancy</p>
          <p className="mt-2 text-[26px] font-semibold text-blue-700 tabular-nums leading-none">
            {fmtPct(kpiOccupancy)}
          </p>
          <p className="mt-1 text-[11px] text-slate-400">excl. maintenance rooms</p>
        </div>

        {/* Total Revenue */}
        <div className="rounded-xl border border-slate-200 bg-white px-5 py-4">
          <p className="text-[11.5px] font-semibold text-slate-400 uppercase tracking-wider">Room Revenue</p>
          <p className="mt-2 text-[26px] font-semibold text-emerald-700 tabular-nums leading-none">
            ৳{fmt(totalRev, 0)}
          </p>
          <p className="mt-1 text-[11px] text-slate-400">all rooms</p>
        </div>

        {/* RevPAR */}
        <div className="rounded-xl border border-slate-200 bg-white px-5 py-4">
          <p className="text-[11.5px] font-semibold text-slate-400 uppercase tracking-wider">RevPAR</p>
          <p className="mt-2 text-[26px] font-semibold text-violet-700 tabular-nums leading-none">
            ৳{fmt(kpiRevpar)}
          </p>
          <p className="mt-1 text-[11px] text-slate-400">revenue / avail. night</p>
        </div>

        {/* ADR */}
        <div className="rounded-xl border border-slate-200 bg-white px-5 py-4">
          <p className="text-[11.5px] font-semibold text-slate-400 uppercase tracking-wider">ADR</p>
          <p className="mt-2 text-[26px] font-semibold text-amber-700 tabular-nums leading-none">
            {kpiAdr !== null ? `৳${fmt(kpiAdr)}` : "—"}
          </p>
          <p className="mt-1 text-[11px] text-slate-400">avg daily rate</p>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
        {/* Avg Stay Length */}
        <div className="rounded-xl border border-slate-200 bg-white px-5 py-4">
          <p className="text-[11.5px] font-semibold text-slate-400 uppercase tracking-wider">Avg Stay</p>
          <p className="mt-2 text-[26px] font-semibold text-slate-800 tabular-nums leading-none">
            {allBookings > 0 ? `${fmt(kpiAvgStay, 1)} nts` : "—"}
          </p>
          <p className="mt-1 text-[11px] text-slate-400">per booking</p>
        </div>

        {/* Top revenue room */}
        <div className="rounded-xl border border-slate-200 bg-white px-5 py-4">
          <p className="text-[11.5px] font-semibold text-slate-400 uppercase tracking-wider">Top Revenue Room</p>
          {kpiTopRoom && kpiTopRoom.revenue > 0 ? (
            <>
              <p className="mt-2 text-[26px] font-semibold text-amber-700 tabular-nums leading-none">
                Room {kpiTopRoom.roomNumber}
              </p>
              <p className="mt-1 text-[11px] text-slate-400 tabular-nums">৳{fmt(kpiTopRoom.revenue, 0)}</p>
            </>
          ) : (
            <p className="mt-2 text-[26px] font-semibold text-slate-300 leading-none">—</p>
          )}
        </div>

        {/* Occupied today */}
        <div className="rounded-xl border border-slate-200 bg-white px-5 py-4">
          <p className="text-[11.5px] font-semibold text-slate-400 uppercase tracking-wider">Occupied Now</p>
          <p className="mt-2 text-[26px] font-semibold text-rose-700 tabular-nums leading-none">
            {kpiOccupiedToday}
          </p>
          <p className="mt-1 text-[11px] text-slate-400">rooms with status "occupied"</p>
        </div>
      </div>

      {/* ── Room Performance Table ───────────────────────── */}
      <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
        <div className="px-5 py-3 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
          <h3 className="text-[13.5px] font-semibold text-slate-700">Room Performance</h3>
          <span className="text-[12px] text-slate-400">{rows.length} rooms</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200">
                {(
                  [
                    ["roomNumber",  "Room"],
                    ["category",    "Category"],
                    ["occupancyPct","Occupancy %"],
                    ["bookings",    "Bookings"],
                    ["revenue",     "Revenue"],
                    ["adr",         "ADR"],
                    ["revpar",      "RevPAR"],
                  ] as [SortKey, string][]
                ).map(([key, label]) => (
                  <th
                    key={key}
                    onClick={() => toggleSort(key)}
                    className="text-left px-4 py-3 text-[11px] font-semibold text-slate-400 uppercase tracking-wider cursor-pointer select-none whitespace-nowrap hover:text-slate-600 transition-colors"
                  >
                    {label}<SortIcon col={key} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {sortedRows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-[13px] text-slate-400 italic">
                    No data for this range.
                  </td>
                </tr>
              ) : sortedRows.map((r) => (
                <tr key={r.roomId} className="hover:bg-slate-50/60 transition-colors">
                  <td className="px-4 py-3 font-bold text-slate-800 text-[15px]">
                    {r.roomNumber}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`px-2.5 py-0.5 rounded-md text-[12px] font-semibold ${catBadge(r.category)}`}>
                      {cap(r.category)}
                    </span>
                  </td>
                  <td className="px-4 py-3 tabular-nums">
                    <span className={r.occupancyPct > 100 ? "text-rose-600 font-semibold" : "text-slate-700"}>
                      {fmtPct(r.occupancyPct)}
                    </span>
                  </td>
                  <td className="px-4 py-3 tabular-nums text-slate-600">{r.bookings}</td>
                  <td className="px-4 py-3 tabular-nums font-semibold text-slate-800">৳{fmt(r.revenue, 0)}</td>
                  <td className="px-4 py-3 tabular-nums text-slate-600">
                    {r.adr !== null ? `৳${fmt(r.adr)}` : <span className="text-slate-300">—</span>}
                  </td>
                  <td className="px-4 py-3 tabular-nums text-slate-600">৳{fmt(r.revpar)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {sortedRows.length > 0 && (
          <div className="px-5 py-2.5 border-t border-slate-100 bg-slate-50">
            <p className="text-[11.5px] text-slate-400 italic">
              Occupancy&nbsp;&gt;&nbsp;100% indicates periods with overlapping bookings recorded for the same room.
            </p>
          </div>
        )}
      </div>

      {/* ── Most / Least Booked ─────────────────────────── */}
      <div className="grid grid-cols-2 gap-4">
        {/* Most booked */}
        <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
          <div className="px-5 py-3 bg-slate-50 border-b border-slate-200">
            <h3 className="text-[13.5px] font-semibold text-slate-700">Most Booked Rooms</h3>
          </div>
          <div className="px-5 py-4 space-y-2.5">
            {topBooked.length === 0
              ? <p className="text-[13px] text-slate-400 italic">No data.</p>
              : topBooked.map((r, i) => (
                <div key={r.roomId} className="flex items-center gap-3">
                  <span className="w-5 flex-shrink-0 text-[12px] font-bold text-slate-300 tabular-nums text-right">
                    {i + 1}
                  </span>
                  <span className="w-10 flex-shrink-0 font-bold text-slate-800 text-[13px]">
                    {r.roomNumber}
                  </span>
                  <div className="flex-1">
                    <Bar value={r.bookings} max={topBooked[0]?.bookings ?? 1} color="bg-blue-500" />
                  </div>
                  <span className="w-10 flex-shrink-0 text-right text-[12.5px] font-semibold text-slate-700 tabular-nums">
                    {r.bookings}
                  </span>
                </div>
              ))}
          </div>
        </div>

        {/* Least booked */}
        <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
          <div className="px-5 py-3 bg-slate-50 border-b border-slate-200">
            <h3 className="text-[13.5px] font-semibold text-slate-700">Least Booked Rooms</h3>
            <p className="text-[11.5px] text-slate-400 mt-0.5">Bottom 10 — zero-booking rooms included</p>
          </div>
          <div className="px-5 py-4 space-y-2.5">
            {bottomBooked.length === 0
              ? <p className="text-[13px] text-slate-400 italic">No data.</p>
              : bottomBooked.map((r) => (
                <div key={r.roomId} className="flex items-center gap-3">
                  <span className="w-10 flex-shrink-0 font-bold text-slate-800 text-[13px]">
                    {r.roomNumber}
                  </span>
                  <div className="flex-1">
                    <Bar
                      value={r.bookings}
                      max={Math.max(1, bottomBooked[bottomBooked.length - 1]?.bookings ?? 1)}
                      color="bg-rose-400"
                    />
                  </div>
                  <span className={`w-10 flex-shrink-0 text-right text-[12.5px] font-semibold tabular-nums ${r.bookings === 0 ? "text-rose-500" : "text-slate-700"}`}>
                    {r.bookings}
                  </span>
                </div>
              ))}
          </div>
        </div>
      </div>

      {/* ── Room Type Performance ────────────────────────── */}
      <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
        <div className="px-5 py-3 bg-slate-50 border-b border-slate-200">
          <h3 className="text-[13.5px] font-semibold text-slate-700">Room Type Performance</h3>
          <p className="text-[11.5px] text-slate-400 mt-0.5">Occupancy excludes maintenance rooms from the denominator.</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200">
                {["Category", "Rooms", "Occupancy %", "Revenue"].map(h => (
                  <th key={h} className="text-left px-5 py-3 text-[11px] font-semibold text-slate-400 uppercase tracking-wider whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {byType.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-5 py-12 text-center text-[13px] text-slate-400 italic">No data.</td>
                </tr>
              ) : byType.map((t) => (
                <tr key={t.category} className="hover:bg-slate-50/60">
                  <td className="px-5 py-3">
                    <span className={`px-2.5 py-0.5 rounded-md text-[12px] font-semibold ${catBadge(t.category)}`}>
                      {cap(t.category)}
                    </span>
                  </td>
                  <td className="px-5 py-3 tabular-nums text-slate-600">{t.roomCount}</td>
                  <td className="px-5 py-3 tabular-nums text-slate-700">{fmtPct(t.occupancyPct)}</td>
                  <td className="px-5 py-3 tabular-nums font-semibold text-slate-800">৳{fmt(t.revenue, 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Revenue by Room bar chart ───────────────────── */}
      <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
        <div className="px-5 py-3 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
          <h3 className="text-[13.5px] font-semibold text-slate-700">Revenue by Room</h3>
          <span className="text-[12px] text-slate-400">sorted by revenue</span>
        </div>
        <div className="px-5 py-4 space-y-2">
          {revChartData.length === 0 ? (
            <p className="text-[13px] text-slate-400 italic">No revenue data for this range.</p>
          ) : revChartData.map((r) => (
            <div key={r.roomId} className="flex items-center gap-3">
              <span className="w-12 flex-shrink-0 font-bold text-slate-700 text-[13px]">
                {r.roomNumber}
              </span>
              <span className={`w-16 flex-shrink-0 text-[11.5px] font-semibold px-1.5 py-0.5 rounded ${catBadge(r.category)}`}>
                {cap(r.category)}
              </span>
              <div className="flex-1">
                <Bar value={r.revenue} max={maxRevenue} color="bg-amber-500" />
              </div>
              <span className="w-28 flex-shrink-0 text-right text-[12px] text-slate-600 tabular-nums">
                ৳{fmt(r.revenue, 0)}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* ── Occupancy Trend ──────────────────────────────── */}
      <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
        <div className="px-5 py-3 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
          <h3 className="text-[13.5px] font-semibold text-slate-700">Occupancy Trend</h3>
          <span className="text-[12px] text-slate-400 capitalize">{trendGranularity}</span>
        </div>
        <div className="px-5 py-4">
          <OccupancyLineChart data={trendChartData} />
        </div>
      </div>

    </div>
  );
}

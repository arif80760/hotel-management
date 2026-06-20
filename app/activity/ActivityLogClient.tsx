"use client";

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

type ActivityRow = {
  id: string; occurred_at: string; actor_name: string | null; action: string;
  entity_type: string | null; entity_id: string | null; entity_label: string | null;
  summary: string; details: Record<string, unknown> | null;
};

const PAGE_SIZE = 25;

type CategoryKey = "booking" | "payment" | "refund" | "room" | "employee" | "inventory" | "day" | "other";

const CATEGORY: Record<CategoryKey, { label: string; dot: string; chip: string }> = {
  booking:   { label: "Bookings",  dot: "bg-blue-500",    chip: "bg-blue-50 text-blue-700 ring-blue-200" },
  payment:   { label: "Money",     dot: "bg-emerald-500", chip: "bg-emerald-50 text-emerald-700 ring-emerald-200" },
  refund:    { label: "Refunds",   dot: "bg-rose-500",    chip: "bg-rose-50 text-rose-700 ring-rose-200" },
  room:      { label: "Rooms",     dot: "bg-violet-500",  chip: "bg-violet-50 text-violet-700 ring-violet-200" },
  employee:  { label: "Staff",     dot: "bg-amber-500",   chip: "bg-amber-50 text-amber-700 ring-amber-200" },
  inventory: { label: "Inventory", dot: "bg-cyan-500",    chip: "bg-cyan-50 text-cyan-700 ring-cyan-200" },
  day:       { label: "Day close", dot: "bg-slate-500",   chip: "bg-slate-100 text-slate-700 ring-slate-200" },
  other:     { label: "Other",     dot: "bg-slate-400",   chip: "bg-slate-100 text-slate-600 ring-slate-200" },
};

function categoryOf(action: string): CategoryKey {
  const head = action.split(".")[0];
  if (head === "booking") return "booking";
  if (head === "payment" || head === "cash") return "payment";
  if (head === "refund") return "refund";
  if (head === "room") return "room";
  if (head === "employee") return "employee";
  if (head === "inventory") return "inventory";
  if (head === "day") return "day";
  return "other";
}

// Pills filter server-side by entity_type so page counts stay accurate.
const FILTERS: { key: string; label: string; types: string[] | null }[] = [
  { key: "all",     label: "All",       types: null },
  { key: "booking", label: "Bookings",  types: ["booking", "booking_room"] },
  { key: "money",   label: "Money",     types: ["payment", "refund", "cash"] },
  { key: "staff",   label: "Staff",     types: ["employee"] },
  { key: "stock",   label: "Inventory", types: ["inventory", "day_close"] },
];

const RANGES: { key: string; label: string; hours: number | null }[] = [
  { key: "24h",    label: "Last 24h",     hours: 24 },
  { key: "7d",     label: "Last 7 days",  hours: 24 * 7 },
  { key: "30d",    label: "Last 30 days", hours: 24 * 30 },
  { key: "all",    label: "All time",     hours: null },
  { key: "custom", label: "Custom range", hours: null },
];

const dhakaTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Dhaka", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: true,
});
function dhakaDateStr(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dhaka", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
function relativeTime(iso: string): string {
  const secs = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 45) return "just now";
  if (secs < 90) return "1 min ago";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr${hrs === 1 ? "" : "s"} ago`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;
  return dhakaTime.format(new Date(iso));
}
function initials(name: string | null): string {
  if (!name) return "·";
  return name.trim().split(/\s+/).slice(0, 2).map(n => n[0]?.toUpperCase() ?? "").join("") || "·";
}

export default function ActivityLogClient() {
  const [rows, setRows]   = useState<ActivityRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage]   = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

  const [filter, setFilter]   = useState("all");
  const [rangeKey, setRange]  = useState("7d");
  const [search, setSearch]   = useState("");
  const [debounced, setDeb]   = useState("");

  const [customStart, setCustomStart] = useState(dhakaDateStr(new Date(Date.now() - 7 * 24 * 3600 * 1000)));
  const [customEnd,   setCustomEnd]   = useState(dhakaDateStr(new Date()));

  // Debounce the search box; reset to first page on a new term.
  useEffect(() => {
    const t = setTimeout(() => { setDeb(search); setPage(0); }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const fetchData = useCallback(async () => {
    setLoading(true); setError(null);

    const f = FILTERS.find(x => x.key === filter);
    let gte: string | null = null;
    let lte: string | null = null;
    if (rangeKey === "custom") {
      if (customStart) gte = new Date(`${customStart}T00:00:00+06:00`).toISOString();
      if (customEnd)   lte = new Date(`${customEnd}T23:59:59.999+06:00`).toISOString();
    } else {
      const r = RANGES.find(x => x.key === rangeKey);
      if (r?.hours) gte = new Date(Date.now() - r.hours * 3600 * 1000).toISOString();
    }

    let q = supabase
      .from("activity_log")
      .select("id, occurred_at, actor_name, action, entity_type, entity_id, entity_label, summary, details", { count: "exact" })
      .order("occurred_at", { ascending: false })
      .order("id", { ascending: false })
      .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);

    if (f?.types) q = q.in("entity_type", f.types);
    if (gte) q = q.gte("occurred_at", gte);
    if (lte) q = q.lte("occurred_at", lte);

    const term = debounced.trim().replace(/[%,()]/g, " ").trim();
    if (term) q = q.or(`summary.ilike.%${term}%,actor_name.ilike.%${term}%,entity_label.ilike.%${term}%`);

    const { data, error, count } = await q;
    if (error) setError(error.message);
    else { setRows((data ?? []) as ActivityRow[]); setTotal(count ?? 0); }
    setLoading(false);
  }, [filter, rangeKey, customStart, customEnd, debounced, page]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const fromN = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const toN   = Math.min((page + 1) * PAGE_SIZE, total);

  const inputCls = "px-3 py-1.5 rounded-lg text-[12.5px] font-medium text-slate-700 bg-white ring-1 ring-slate-200 focus:outline-none focus:ring-amber-400";

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-6">
      <div className="mb-5">
        <h1 className="text-xl font-semibold text-slate-900">Activity Log</h1>
        <p className="text-[13px] text-slate-500 mt-0.5">
          Every consequential action across the hotel — bookings, payments, rooms, cash and staff changes.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-3">
        <div className="flex flex-wrap gap-1">
          {FILTERS.map(f => (
            <button key={f.key} onClick={() => { setFilter(f.key); setPage(0); }}
              className={`px-3 py-1.5 rounded-full text-[12.5px] font-medium transition-colors ${
                filter === f.key ? "bg-slate-900 text-white" : "bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50"
              }`}>
              {f.label}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        <select value={rangeKey} onChange={e => { setRange(e.target.value); setPage(0); }} className={inputCls}>
          {RANGES.map(r => <option key={r.key} value={r.key}>{r.label}</option>)}
        </select>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search…"
          className={`${inputCls} w-32 sm:w-44 font-normal`} />
      </div>

      {rangeKey === "custom" && (
        <div className="flex items-center gap-2 mb-4">
          <input type="date" value={customStart} max={customEnd}
            onChange={e => { setCustomStart(e.target.value); setPage(0); }} className={inputCls} />
          <span className="text-[12px] text-slate-400">to</span>
          <input type="date" value={customEnd} min={customStart} max={dhakaDateStr(new Date())}
            onChange={e => { setCustomEnd(e.target.value); setPage(0); }} className={inputCls} />
        </div>
      )}

      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (<div key={i} className="h-16 rounded-xl bg-slate-100 animate-pulse" />))}
        </div>
      ) : error ? (
        <div className="rounded-xl bg-rose-50 ring-1 ring-rose-200 px-4 py-3 text-[13px] text-rose-700">
          Couldn’t load the activity log: {error}
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-xl bg-white ring-1 ring-slate-200 px-4 py-10 text-center">
          <p className="text-[13px] text-slate-500">No activity matches these filters.</p>
        </div>
      ) : (
        <ul className="space-y-1.5">
          {rows.map(r => {
            const cat = CATEGORY[categoryOf(r.action)];
            const detailEntries = r.details
              ? Object.entries(r.details).filter(([, v]) => v !== null && v !== undefined && v !== "")
              : [];
            return (
              <li key={r.id} className="group flex gap-3 rounded-xl bg-white ring-1 ring-slate-200 px-3.5 py-3 hover:ring-slate-300 transition-colors">
                <div className="mt-0.5 w-8 h-8 rounded-full bg-slate-100 flex items-center justify-center flex-shrink-0">
                  <span className="text-[10.5px] font-bold text-slate-500">{initials(r.actor_name)}</span>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium ring-1 ${cat.chip}`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${cat.dot}`} />
                      {cat.label}
                    </span>
                    {r.entity_label && (<span className="text-[11.5px] font-medium text-slate-400">{r.entity_label}</span>)}
                  </div>
                  <p className="text-[13.5px] text-slate-800 mt-1 leading-snug">{r.summary}</p>
                  <div className="flex items-center gap-2 mt-1 text-[11.5px] text-slate-400">
                    <span className="font-medium text-slate-500">{r.actor_name ?? "System"}</span>
                    <span>·</span>
                    <span title={dhakaTime.format(new Date(r.occurred_at))}>{relativeTime(r.occurred_at)}</span>
                  </div>
                  {detailEntries.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mt-2">
                      {detailEntries.map(([k, v]) => (
                        <span key={k} className="text-[11px] text-slate-500 bg-slate-50 ring-1 ring-slate-200 rounded px-1.5 py-0.5">
                          <span className="text-slate-400">{k.replace(/_/g, " ")}:</span> {String(v)}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {!loading && !error && total > 0 && (
        <div className="flex items-center justify-between mt-4 text-[12.5px] text-slate-500">
          <span>Showing {fromN}–{toN} of {total}</span>
          <div className="flex items-center gap-2">
            <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}
              className="px-3 py-1.5 rounded-lg font-medium text-slate-700 bg-white ring-1 ring-slate-200 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed">
              Prev
            </button>
            <span className="text-slate-400">Page {page + 1} / {totalPages}</span>
            <button onClick={() => setPage(p => (p + 1 < totalPages ? p + 1 : p))} disabled={page + 1 >= totalPages}
              className="px-3 py-1.5 rounded-lg font-medium text-slate-700 bg-white ring-1 ring-slate-200 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed">
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

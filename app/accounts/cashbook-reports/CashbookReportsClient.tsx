"use client";

// app/accounts/cashbook-reports/CashbookReportsClient.tsx
//
// Cashbook Reports archive — lists day_closes (newest first) with a
// Print action opening the printable /accounts/cashbook/report/[date]
// document. READ ONLY: first list-read of day_closes (write-only until
// the report feature landed).
//
// Date presets reuse the Revenue Report / P&L plain-local helper
// convention (todayISO / firstOfMonthISO copied verbatim — per-feature
// duplication is this codebase's convention; no new date semantics).
// "This week" starts Monday, built from the same local-date parts.

import { useEffect, useState } from "react";
import { getDayCloses, type DayCloseListItem } from "@/services/dayCloseService";

// ── Date helpers — copied from RevenueReportClient (same semantics) ──
function todayISO(){ const d=new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; }
function firstOfMonthISO(d=new Date()){ return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-01`; }
function yesterdayISO(){
  const d = new Date();
  d.setDate(d.getDate() - 1); // same local-date convention as todayISO
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}
function mondayOfWeekISO(){
  const d = new Date();
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // back to Monday, same local-date convention
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

function formatAmount(n: number): string {
  return new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}
function formatDateLabel(iso: string): string {
  const d = new Date(iso + "T12:00:00");
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}
function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
}

type Preset = "today" | "yesterday" | "week" | "month" | "year" | "custom";

export default function CashbookReportsClient() {
  const [preset,   setPreset]   = useState<Preset>("month");
  const [fromDate, setFromDate] = useState<string>(firstOfMonthISO());
  const [toDate,   setToDate]   = useState<string>(todayISO());

  const [rows,       setRows]       = useState<DayCloseListItem[]>([]);
  const [fetching,   setFetching]   = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  function applyPreset(p: Exclude<Preset, "custom">) {
    const today = todayISO();
    setPreset(p);
    if (p === "today")          { setFromDate(today);             setToDate(today); }
    else if (p === "yesterday") { const y = yesterdayISO();       setFromDate(y); setToDate(y); }
    else if (p === "week")      { setFromDate(mondayOfWeekISO()); setToDate(today); }
    else if (p === "month") { setFromDate(firstOfMonthISO());        setToDate(today); }
    else                    { setFromDate(`${new Date().getFullYear()}-01-01`); setToDate(today); }
  }

  useEffect(() => {
    let cancelled = false;
    setFetching(true);
    setFetchError(null);
    getDayCloses({ fromDate: fromDate || undefined, toDate: toDate || undefined })
      .then((r) => { if (!cancelled) setRows(r); })
      .catch((e) => { if (!cancelled) setFetchError(e instanceof Error ? e.message : "Failed to load day closes."); })
      .finally(() => { if (!cancelled) setFetching(false); });
    return () => { cancelled = true; };
  }, [fromDate, toDate]);

  return (
    <div className="p-4 sm:p-8 space-y-4 sm:space-y-5 max-w-4xl">

      {/* ── Header ──────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-slate-800">Cashbook Reports</h1>
          <p className="text-[13px] text-slate-500 mt-1">
            Signed daily records — one printable report per closed day.
          </p>
        </div>
      </div>

      {/* ── Filter bar ──────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-3 bg-white border border-slate-200 rounded-xl px-4 py-3">
        <div className="inline-flex flex-wrap rounded-lg bg-slate-100 p-0.5">
          {([["today","Today"],["yesterday","Yesterday"],["week","This Week"],["month","This Month"],["year","This Year"],["custom","Custom"]] as const).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => key === "custom" ? setPreset("custom") : applyPreset(key)}
              className={`px-3 py-1.5 rounded-md text-[12.5px] font-semibold transition-colors ${
                preset === key ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        {preset === "custom" && (
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="date"
              value={fromDate}
              max={toDate || todayISO()}
              onChange={(e) => setFromDate(e.target.value)}
              className="px-2.5 py-1.5 text-[13px] text-slate-800 bg-white border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-amber-400"
            />
            <span className="text-[12px] text-slate-400">to</span>
            <input
              type="date"
              value={toDate}
              min={fromDate || undefined}
              max={todayISO()}
              onChange={(e) => setToDate(e.target.value)}
              className="px-2.5 py-1.5 text-[13px] text-slate-800 bg-white border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-amber-400"
            />
          </div>
        )}
        <span className="ml-auto text-[12px] text-slate-400">
          {fetching ? "Loading…" : `${rows.length} closed day${rows.length === 1 ? "" : "s"}`}
        </span>
      </div>

      {/* ── List ────────────────────────────────────────────── */}
      {fetchError ? (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-[13px] text-rose-700">{fetchError}</div>
      ) : !fetching && rows.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white px-5 py-10 text-center">
          <p className="text-[13.5px] font-semibold text-slate-600 mb-1">No closed days in this range</p>
          <p className="text-[12.5px] text-slate-400">Days appear here once they are closed from the Cashbook.</p>
        </div>
      ) : (
        <div className="rounded-xl border border-slate-200 bg-white divide-y divide-slate-100 overflow-hidden">
          {rows.map((r) => (
            <div key={r.id} className="px-4 sm:px-5 py-3.5 flex flex-wrap sm:flex-nowrap items-center gap-x-4 gap-y-2">
              <div className="w-full sm:w-auto flex-none sm:flex-1 min-w-0">
                <p className="text-[13.5px] font-semibold text-slate-800">{formatDateLabel(r.closeDate)}</p>
                <p className="text-[12px] text-slate-400 mt-0.5 truncate">
                  Closed{r.closedByName ? ` by ${r.closedByName}` : ""} · {formatTimestamp(r.closedAt)}
                </p>
              </div>
              <div className="text-right">
                <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Closing (Cash)</p>
                <p className="text-[14px] font-semibold text-slate-800 tabular-nums whitespace-nowrap">৳{formatAmount(r.closingBalance)}</p>
              </div>
              <a
                href={`/accounts/cashbook/report/${r.closeDate}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 min-h-11 md:min-h-0 px-3 py-1.5 rounded-lg bg-slate-900 text-white text-[12px] font-semibold hover:bg-slate-800 transition-colors whitespace-nowrap flex-shrink-0"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
                  <polyline points="6 9 6 2 18 2 18 9"/>
                  <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/>
                  <rect x="6" y="14" width="12" height="8"/>
                </svg>
                Print
              </a>
            </div>
          ))}
        </div>
      )}

      <p className="text-[11.5px] text-slate-400">
        The stored day-close record verifies Cash in Hand only; each report reconstructs the other
        accounts from the immutable transaction ledger, so reprints always match.
      </p>
    </div>
  );
}

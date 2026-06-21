"use client";

import { useEffect, useState } from "react";
import { getTransactions } from "@/services/accountsService";
import { getExpenses } from "@/services/expensesService";
import { getExpenseCategories } from "@/services/expenseCategoriesService";

type Preset = "this_month" | "last_month" | "this_year" | "all" | "custom";
const PRESETS: { value: Preset; label: string }[] = [
  { value: "this_month", label: "This month" },
  { value: "last_month", label: "Last month" },
  { value: "this_year",  label: "This year" },
  { value: "all",        label: "All time" },
  { value: "custom",     label: "Custom" },
];

function pad(n: number) { return String(n).padStart(2, "0"); }
function isoDate(y: number, m: number, d: number) { return `${y}-${pad(m)}-${pad(d)}`; }
function todayISO() { const d = new Date(); return isoDate(d.getFullYear(), d.getMonth() + 1, d.getDate()); }
function firstOfMonthISO() { const d = new Date(); return isoDate(d.getFullYear(), d.getMonth() + 1, 1); }
function presetRange(p: Preset, cFrom: string, cTo: string): { from: string; to: string } {
  const now = new Date(); const y = now.getFullYear(); const m = now.getMonth();
  switch (p) {
    case "this_month": return { from: isoDate(y, m + 1, 1), to: todayISO() };
    case "last_month": {
      const ly = m === 0 ? y - 1 : y; const lm = m === 0 ? 12 : m;
      const lastDay = new Date(ly, lm, 0).getDate();
      return { from: isoDate(ly, lm, 1), to: isoDate(ly, lm, lastDay) };
    }
    case "this_year": return { from: isoDate(y, 1, 1), to: todayISO() };
    case "all":       return { from: "", to: "" };
    case "custom":    return { from: cFrom, to: cTo };
  }
}

const SG = { fontFamily: "var(--font-space-grotesk)" } as const;
const PJ = { fontFamily: "var(--font-jakarta)" } as const;
const taka  = (n: number) => `৳${Math.round(Math.abs(n)).toLocaleString()}`;
const takaS = (n: number) => `${n < 0 ? "−" : ""}৳${Math.round(Math.abs(n)).toLocaleString()}`;

export default function ProfitLossClient() {
  const [preset, setPreset] = useState<Preset>("this_month");
  const [cFrom, setCFrom] = useState(firstOfMonthISO());
  const [cTo, setCTo] = useState(todayISO());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState({ revenue: 0, refunds: 0, operating: 0, remuneration: 0, opByCat: [] as { name: string; total: number }[] });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true); setError(null);
      try {
        const { from, to } = presetRange(preset, cFrom, cTo);
        const filters: { fromDate?: string; toDate?: string } = {};
        if (from) filters.fromDate = from;
        if (to) filters.toDate = to;
        const [txns, expenses, cats] = await Promise.all([getTransactions(filters), getExpenses(filters), getExpenseCategories()]);
        if (cancelled) return;
        const kindById = new Map(cats.map((c) => [c.id, c.kind]));
        const nameById = new Map(cats.map((c) => [c.id, c.name]));
        const revenue = txns.filter((t) => t.type === "revenue_in").reduce((s, t) => s + t.amount, 0);
        const refunds = txns.filter((t) => t.type === "expense_out" && t.bookingPaymentId !== null).reduce((s, t) => s + t.amount, 0);
        let operating = 0, remuneration = 0;
        const catMap = new Map<string, number>();
        for (const e of expenses) {
          const kind = kindById.get(e.categoryId) ?? "operating";
          if (kind === "remuneration") remuneration += e.amount;
          else { operating += e.amount; const name = nameById.get(e.categoryId) ?? "Uncategorized"; catMap.set(name, (catMap.get(name) ?? 0) + e.amount); }
        }
        const opByCat = [...catMap.entries()].map(([name, total]) => ({ name, total })).sort((a, b) => b.total - a.total);
        setData({ revenue, refunds, operating, remuneration, opByCat });
      } catch (err) { if (!cancelled) setError((err as Error).message || "Failed to load."); }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [preset, cFrom, cTo]);

  const { revenue, refunds, operating, remuneration, opByCat } = data;
  const netRevenue = revenue - refunds;
  const netProfit = netRevenue - operating;
  const retained = netProfit - remuneration;
  const npMargin = netRevenue > 0 ? Math.round((netProfit / netRevenue) * 100) : null;
  const rpMargin = netRevenue > 0 ? Math.round((retained / netRevenue) * 100) : null;
  const showSplit = netRevenue > 0 && operating >= 0 && remuneration >= 0 && retained >= 0;
  const wOp = showSplit ? (operating / netRevenue) * 100 : 0;
  const wRem = showSplit ? (remuneration / netRevenue) * 100 : 0;
  const wRet = showSplit ? (retained / netRevenue) * 100 : 0;

  const inputCls = "px-3 py-1.5 rounded-lg text-[12.5px] font-medium text-slate-700 bg-white ring-1 ring-slate-200 focus:outline-none focus:ring-2 focus:ring-teal-400";

  return (
    <div style={PJ} className="max-w-[680px] mx-auto px-4 sm:px-6 py-6">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 style={SG} className="text-[23px] font-semibold tracking-tight text-slate-900">Profit &amp; Loss</h1>
          <p className="text-[13px] text-slate-500 mt-0.5">Revenue, expenses, and remuneration for the period.</p>
        </div>
        <select value={preset} onChange={(e) => setPreset(e.target.value as Preset)} className={inputCls}>
          {PRESETS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
        </select>
      </div>
      {preset === "custom" && (
        <div className="flex items-center gap-2 mb-4">
          <input type="date" value={cFrom} max={cTo || todayISO()} onChange={(e) => setCFrom(e.target.value)} className={inputCls} />
          <span className="text-[12px] text-slate-400">to</span>
          <input type="date" value={cTo} min={cFrom} max={todayISO()} onChange={(e) => setCTo(e.target.value)} className={inputCls} />
        </div>
      )}

      {loading ? (
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-3">
            <div className="h-24 rounded-2xl bg-slate-100 animate-pulse" /><div className="h-24 rounded-2xl bg-slate-100 animate-pulse" /><div className="h-24 rounded-2xl bg-slate-100 animate-pulse" />
          </div>
          <div className="h-64 rounded-2xl bg-slate-100 animate-pulse" />
        </div>
      ) : error ? (
        <div className="rounded-2xl bg-rose-50 ring-1 ring-rose-200 px-4 py-3 text-[13px] text-rose-700">Couldn’t load the statement: {error}</div>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-3 mb-5">
            <MetricCard label="Net revenue" value={takaS(netRevenue)} meta={refunds > 0 ? `after ${taka(refunds)} refunds` : "no refunds"} bad={netRevenue < 0} />
            <MetricCard label="Net profit" value={takaS(netProfit)} meta={npMargin !== null ? `${npMargin}% margin` : "—"} bad={netProfit < 0} />
            <MetricCard label="Retained profit" value={takaS(retained)} meta={rpMargin !== null ? `${rpMargin}% · after remuneration` : "after remuneration"} bad={retained < 0} feat />
          </div>

          {showSplit && (
            <div className="mb-5">
              <div className="text-[13px] font-semibold text-slate-600 mb-2">Where net revenue goes</div>
              <div className="flex h-[34px] rounded-[10px] overflow-hidden gap-[3px]">
                <Seg w={wOp} bg="bg-rose-400" text="text-white" label={`${Math.round(wOp)}%`} />
                <Seg w={wRem} bg="bg-amber-400" text="text-amber-900" label={`${Math.round(wRem)}%`} />
                <Seg w={wRet} bg="bg-emerald-500" text="text-white" label={`${Math.round(wRet)}%`} />
              </div>
              <div className="flex flex-wrap gap-4 mt-2.5 text-[12px] font-medium text-slate-500">
                <Legend dot="bg-rose-400" label="Operating expenses" />
                <Legend dot="bg-amber-400" label="Director remuneration" />
                <Legend dot="bg-emerald-500" label="Retained profit" />
              </div>
            </div>
          )}

          <div className="bg-white ring-1 ring-slate-200 rounded-2xl px-5 sm:px-6 py-5">
            <Line label="Revenue" value={taka(revenue)} tone="ink" />
            {refunds > 0 && <Line label="Less: refunds" value={`−${taka(refunds)}`} tone="neg" />}
            <Hr />
            <Line label="Net revenue" value={takaS(netRevenue)} tone={netRevenue >= 0 ? "pos" : "neg"} strong />

            <Line label="Operating expenses" value={`−${taka(operating)}`} tone="neg" strong className="mt-2" />
            {operating > 0 && opByCat.map((c) => (
              <div key={c.name} className="flex items-center gap-3 py-1 pl-0.5">
                <span className="w-[108px] shrink-0 text-[12.5px] font-medium text-slate-500 truncate">{c.name}</span>
                <div className="flex-1 h-2 rounded-full bg-rose-50 overflow-hidden">
                  <div className="h-full rounded-full bg-rose-400" style={{ width: `${(c.total / operating) * 100}%` }} />
                </div>
                <span style={SG} className="w-[66px] text-right text-[12.5px] font-medium text-rose-600 tabular-nums">−{taka(c.total)}</span>
              </div>
            ))}
            <Hr />
            <Line label="Net profit" value={takaS(netProfit)} tone={netProfit >= 0 ? "pos" : "neg"} strong />

            <Line label="Less: director remuneration" value={`−${taka(remuneration)}`} tone="amber" className="mt-2" />
            <p className="text-[11.5px] text-slate-400 pb-1">Appropriation of profit — not an operating expense.</p>
            <div className="border-t-2 border-slate-300 my-2.5" />
            <Line label="Retained profit" value={takaS(retained)} tone={retained >= 0 ? "pos" : "neg"} big />
          </div>
        </>
      )}
    </div>
  );
}

function MetricCard({ label, value, meta, feat, bad }: { label: string; value: string; meta: string; feat?: boolean; bad?: boolean }) {
  return (
    <div className={`rounded-2xl px-4 py-3.5 bg-gradient-to-br ${feat ? "from-teal-950 to-slate-900 ring-2 ring-teal-400" : "from-slate-900 to-slate-800"}`}>
      <div className="text-[12.5px] font-semibold text-slate-400">{label}</div>
      <div style={SG} className={`text-[25px] font-semibold mt-1.5 tabular-nums leading-none ${bad ? "text-rose-400" : "text-teal-400"}`}>{value}</div>
      <div className="text-[11.5px] font-medium text-teal-300 mt-1.5">{meta}</div>
    </div>
  );
}

function Seg({ w, bg, text, label }: { w: number; bg: string; text: string; label: string }) {
  return (
    <div className={`flex items-center justify-center ${bg} ${text} text-[12.5px] font-bold tabular-nums`} style={{ width: `${w}%`, ...SG }}>
      {w >= 8 ? label : ""}
    </div>
  );
}

function Legend({ dot, label }: { dot: string; label: string }) {
  return <span className="flex items-center gap-1.5"><span className={`w-2.5 h-2.5 rounded ${dot}`} />{label}</span>;
}

function Hr() { return <div className="border-t border-slate-100 my-2.5" />; }

function Line({ label, value, tone, strong, big, className = "" }: { label: string; value: string; tone: "ink" | "pos" | "neg" | "amber"; strong?: boolean; big?: boolean; className?: string }) {
  const c = { ink: "text-slate-700", pos: "text-teal-700", neg: "text-rose-600", amber: "text-amber-700" }[tone];
  return (
    <div className={`flex justify-between items-center py-1 ${className}`}>
      <span className={`${c} ${big ? "text-[17px]" : "text-[14px]"} ${strong || big ? "font-semibold" : "font-normal"}`}>{label}</span>
      <span style={SG} className={`${c} tabular-nums ${big ? "text-[17px]" : "text-[14px]"} ${strong || big ? "font-semibold" : "font-medium"}`}>{value}</span>
    </div>
  );
}

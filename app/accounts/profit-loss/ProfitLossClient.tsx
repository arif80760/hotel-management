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
        const kindById = new Map(cats.map(c => [c.id, c.kind]));
        const nameById = new Map(cats.map(c => [c.id, c.name]));
        const revenue = txns.filter(t => t.type === "revenue_in").reduce((s, t) => s + t.amount, 0);
        const refunds = txns.filter(t => t.type === "expense_out" && t.bookingPaymentId !== null).reduce((s, t) => s + t.amount, 0);
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

  const netRevenue = data.revenue - data.refunds;
  const netProfit = netRevenue - data.operating;
  const retained = netProfit - data.remuneration;
  const inputCls = "px-3 py-1.5 rounded-lg text-[12.5px] font-medium text-slate-700 bg-white ring-1 ring-slate-200 focus:outline-none focus:ring-amber-400";

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-6">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Profit &amp; Loss</h1>
          <p className="text-[13px] text-slate-500 mt-0.5">Revenue, operating expenses, and director remuneration for the period.</p>
        </div>
        <select value={preset} onChange={e => setPreset(e.target.value as Preset)} className={inputCls}>
          {PRESETS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
        </select>
      </div>

      {preset === "custom" && (
        <div className="flex items-center gap-2 mb-4">
          <input type="date" value={cFrom} max={cTo || todayISO()} onChange={e => setCFrom(e.target.value)} className={inputCls} />
          <span className="text-[12px] text-slate-400">to</span>
          <input type="date" value={cTo} min={cFrom} max={todayISO()} onChange={e => setCTo(e.target.value)} className={inputCls} />
        </div>
      )}

      {loading ? (
        <div className="h-72 rounded-2xl bg-slate-100 animate-pulse" />
      ) : error ? (
        <div className="rounded-2xl bg-rose-50 ring-1 ring-rose-200 px-4 py-3 text-[13px] text-rose-700">Couldn’t load the statement: {error}</div>
      ) : (
        <div className="rounded-2xl bg-white ring-1 ring-slate-200 p-5 sm:p-6">
          <Row label="Revenue" value={data.revenue} />
          {data.refunds > 0 && <Row label="Less: Refunds" value={-data.refunds} muted />}
          <Divider />
          <Row label="Net Revenue" value={netRevenue} strong />
          <div className="mt-4">
            <Row label="Operating Expenses" value={-data.operating} />
            {data.opByCat.length > 0 && (
              <div className="mt-1.5 space-y-1 pl-3 border-l border-slate-100">
                {data.opByCat.map(c => (
                  <div key={c.name} className="flex items-center justify-between text-[12.5px] text-slate-500">
                    <span>{c.name}</span><span className="tabular-nums">−৳{Math.round(c.total).toLocaleString()}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <Divider />
          <Row label="Net Profit" value={netProfit} strong profit />
          <div className="mt-4">
            <Row label="Less: Director Remuneration" value={-data.remuneration} muted />
            <p className="text-[11px] text-slate-400 mt-0.5">Appropriation of profit — not an operating expense.</p>
          </div>
          <Divider heavy />
          <Row label="Retained Profit" value={retained} strong profit big />
        </div>
      )}
    </div>
  );
}

function Row({ label, value, strong, muted, profit, big }: { label: string; value: number; strong?: boolean; muted?: boolean; profit?: boolean; big?: boolean }) {
  const color = profit ? (value >= 0 ? "text-emerald-700" : "text-rose-700") : muted ? "text-slate-500" : "text-slate-800";
  return (
    <div className="flex items-center justify-between py-0.5">
      <span className={`${big ? "text-[15px]" : "text-[13.5px]"} ${strong ? "font-semibold" : "font-medium"} ${muted ? "text-slate-500" : "text-slate-700"}`}>{label}</span>
      <span className={`tabular-nums ${big ? "text-[16px]" : "text-[13.5px]"} ${strong ? "font-bold" : "font-medium"} ${color}`}>
        {value < 0 ? "−" : ""}৳{Math.round(Math.abs(value)).toLocaleString()}
      </span>
    </div>
  );
}
function Divider({ heavy }: { heavy?: boolean }) {
  return <div className={`my-2 ${heavy ? "border-t-2 border-slate-300" : "border-t border-slate-200"}`} />;
}

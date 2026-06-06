"use client";

// app/accounts/revenue-report/RevenueReportClient.tsx
//
// Revenue Report — read-only analytics over all revenue_in rows. No writes.
// Booking rows are enriched with their source booking detail via
// getBookingPaymentMap (payment id -> booking ref + method) + getAllBookings.
// ─────────────────────────────────────────────────────────────

import { useState, useEffect, useMemo } from "react";
import { getTransactions, getAccounts, type AccountTransaction } from "@/services/accountsService";
import { getRevenues, type Revenue } from "@/services/revenueService";
import { getRevenueCategories } from "@/services/revenueCategoriesService";
import { getAllBookings, getBookingPaymentMap } from "@/services/bookingsService";
import type { MockBooking } from "@/lib/mockData";

const BOOKING_LABEL = "Room / Booking";

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function firstOfMonthISO(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}
function isoFrom(y: number, m: number, day: number): string {
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
function formatAmount(n: number): string {
  return new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}
function formatDateLabel(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}
function trendDayLabel(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}
function trendMonthLabel(key: string): string {
  const d = new Date(key + "-01T00:00:00");
  return d.toLocaleDateString("en-GB", { month: "short", year: "numeric" });
}
function daysInclusive(fromISO: string, toISO: string): number {
  const a = new Date(fromISO + "T00:00:00").getTime();
  const b = new Date(toISO + "T00:00:00").getTime();
  if (isNaN(a) || isNaN(b) || b < a) return 0;
  return Math.floor((b - a) / 86400000) + 1;
}
function formatMethod(m: string): string {
  return m.split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

type Preset = "this_month" | "last_month" | "this_year" | "all" | "custom";

function rangeFilters(f: string, t: string): { fromDate?: string; toDate?: string } {
  const out: { fromDate?: string; toDate?: string } = {};
  if (f) out.fromDate = f;
  if (t) out.toDate = t;
  return out;
}

async function loadTxns(f: string, t: string) {
  const filters = rangeFilters(f, t);
  const [tx, rv] = await Promise.all([getTransactions(filters), getRevenues(filters)]);
  const paymentIds = tx
    .filter((x) => x.type === "revenue_in" && x.bookingPaymentId)
    .map((x) => x.bookingPaymentId as string);
  const pm = await getBookingPaymentMap(paymentIds);
  return { tx, rv, pm };
}

export default function RevenueReportClient() {
  const [fromDate, setFromDate] = useState<string>(firstOfMonthISO());
  const [toDate, setToDate]     = useState<string>(todayISO());
  const [preset, setPreset]     = useState<Preset>("this_month");

  const [txns, setTxns]             = useState<AccountTransaction[]>([]);
  const [manual, setManual]         = useState<Revenue[]>([]);
  const [accounts, setAccounts]     = useState<{ id: string; name: string }[]>([]);
  const [categories, setCategories] = useState<{ id: string; name: string }[]>([]);
  const [bookingsByRef, setBookingsByRef] = useState<Map<string, MockBooking>>(new Map());
  const [paymentMap, setPaymentMap] = useState<Awaited<ReturnType<typeof getBookingPaymentMap>>>(new Map());

  const [fetching, setFetching]     = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [{ tx, rv, pm }, accs, cats, bks] = await Promise.all([
          loadTxns(fromDate, toDate),
          getAccounts(),
          getRevenueCategories(),
          getAllBookings(),
        ]);
        if (cancelled) return;
        setTxns(tx);
        setManual(rv);
        setPaymentMap(pm);
        setAccounts(accs.map((a) => ({ id: a.id, name: a.name })));
        setCategories(cats.map((c) => ({ id: c.id, name: c.name })));
        setBookingsByRef(new Map(bks.map((b) => [b.id, b])));
      } catch (err) {
        if (!cancelled) setFetchError(err instanceof Error ? err.message : "Failed to load.");
      } finally {
        if (!cancelled) setFetching(false);
      }
    }
    load();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (fetching) return;
    let cancelled = false;
    (async () => {
      try {
        const { tx, rv, pm } = await loadTxns(fromDate, toDate);
        if (!cancelled) { setTxns(tx); setManual(rv); setPaymentMap(pm); }
      } catch (err) {
        console.error("[RevenueReportClient] refilter failed:", err);
      }
    })();
    return () => { cancelled = true; };
  }, [fromDate, toDate, fetching]);

  function applyPreset(p: Preset) {
    setPreset(p);
    const now = new Date();
    if (p === "this_month") {
      setFromDate(firstOfMonthISO(now)); setToDate(todayISO());
    } else if (p === "last_month") {
      const lm = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const lastDay = new Date(now.getFullYear(), now.getMonth(), 0).getDate();
      setFromDate(isoFrom(lm.getFullYear(), lm.getMonth(), 1));
      setToDate(isoFrom(lm.getFullYear(), lm.getMonth(), lastDay));
    } else if (p === "this_year") {
      setFromDate(isoFrom(now.getFullYear(), 0, 1)); setToDate(todayISO());
    } else if (p === "all") {
      setFromDate(""); setToDate("");
    }
  }

  const revenueTxns = useMemo(() => txns.filter((t) => t.type === "revenue_in"), [txns]);

  const accountName = useMemo(() => {
    const m = new Map(accounts.map((a) => [a.id, a.name]));
    return (id: string | null) => (id ? m.get(id) ?? "Unknown" : "—");
  }, [accounts]);

  const categoryName = useMemo(() => {
    const m = new Map(categories.map((c) => [c.id, c.name]));
    return (id: string) => m.get(id) ?? "Uncategorized";
  }, [categories]);

  const manualById = useMemo(() => {
    const m = new Map<string, { category: string; payee: string }>();
    for (const r of manual) m.set(r.id, { category: categoryName(r.revenueCategoryId), payee: r.payee });
    return m;
  }, [manual, categoryName]);

  const total = useMemo(() => revenueTxns.reduce((s, t) => s + t.amount, 0), [revenueTxns]);
  const count = revenueTxns.length;
  const bookingTotal = useMemo(
    () => revenueTxns.filter((t) => t.bookingPaymentId !== null).reduce((s, t) => s + t.amount, 0),
    [revenueTxns],
  );

  const avgPerDay = useMemo(() => {
    let f = fromDate, t = toDate;
    if (!f || !t) {
      const dates = revenueTxns.map((x) => x.txnDate).sort();
      if (dates.length === 0) return 0;
      f = f || dates[0];
      t = t || dates[dates.length - 1];
    }
    const d = daysInclusive(f, t);
    return d > 0 ? total / d : 0;
  }, [fromDate, toDate, revenueTxns, total]);

  const bySource = useMemo(() => {
    const rows: { label: string; amount: number }[] = [];
    if (bookingTotal > 0) rows.push({ label: BOOKING_LABEL, amount: bookingTotal });
    const byCat = new Map<string, number>();
    for (const r of manual) {
      const name = categoryName(r.revenueCategoryId);
      byCat.set(name, (byCat.get(name) ?? 0) + r.amount);
    }
    for (const [label, amount] of byCat) rows.push({ label, amount });
    return rows.sort((a, b) => b.amount - a.amount);
  }, [bookingTotal, manual, categoryName]);

  const byBucket = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of revenueTxns) {
      const name = accountName(t.toAccountId);
      m.set(name, (m.get(name) ?? 0) + t.amount);
    }
    return Array.from(m.entries()).map(([label, amount]) => ({ label, amount })).sort((a, b) => b.amount - a.amount);
  }, [revenueTxns, accountName]);

  const trendData = useMemo(() => {
    const dayMap = new Map<string, number>();
    for (const t of revenueTxns) dayMap.set(t.txnDate, (dayMap.get(t.txnDate) ?? 0) + t.amount);
    if (dayMap.size <= 45) {
      const rows = Array.from(dayMap.entries()).sort(([a], [b]) => a.localeCompare(b))
        .map(([key, amount]) => ({ key, label: trendDayLabel(key), amount }));
      return { granularity: "daily" as const, rows };
    }
    const monthMap = new Map<string, number>();
    for (const [day, amt] of dayMap) { const k = day.slice(0, 7); monthMap.set(k, (monthMap.get(k) ?? 0) + amt); }
    const rows = Array.from(monthMap.entries()).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, amount]) => ({ key, label: trendMonthLabel(key), amount }));
    return { granularity: "monthly" as const, rows };
  }, [revenueTxns]);

  const trend = trendData.rows;
  const maxTrend = trend.reduce((m, x) => Math.max(m, x.amount), 0);
  const maxSource = bySource.reduce((m, x) => Math.max(m, x.amount), 0);
  const maxBucket = byBucket.reduce((m, x) => Math.max(m, x.amount), 0);

  if (fetching) {
    return (
      <div className="p-8">
        <h1 className="text-2xl font-semibold text-slate-800">Revenue Report</h1>
        <div className="mt-8 rounded-xl border border-dashed border-slate-200 bg-white px-6 py-12 flex items-center justify-center text-[13px] text-slate-400">Loading…</div>
      </div>
    );
  }
  if (fetchError) {
    return (
      <div className="p-8">
        <h1 className="text-2xl font-semibold text-slate-800">Revenue Report</h1>
        <div className="mt-8 rounded-xl border border-rose-200 bg-rose-50 px-6 py-4 text-[13px] text-rose-700">{fetchError}</div>
      </div>
    );
  }

  const presetBtn = (p: Preset, label: string) => (
    <button key={p} type="button" onClick={() => applyPreset(p)}
      className={`px-3 py-1.5 rounded-md text-[12.5px] font-semibold transition-colors ${preset === p ? "bg-emerald-100 text-emerald-800 border border-emerald-300" : "bg-slate-50 text-slate-600 border border-slate-200 hover:bg-slate-100"}`}>
      {label}
    </button>
  );

  const Bar = ({ amount, max }: { amount: number; max: number }) => (
    <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
      <div className="h-full rounded-full bg-emerald-500" style={{ width: max > 0 ? `${(amount / max) * 100}%` : "0%" }} />
    </div>
  );

  const pct = (a: number) => (total > 0 ? Math.round((a / total) * 100) : 0);

  return (
    <div className="p-8 space-y-5">

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-800">Revenue Report</h1>
          <p className="mt-1 text-[13px] text-slate-500">All income — room/booking and manually recorded — across the selected range.</p>
        </div>
        <a href="/accounts/revenue-management" className="px-4 py-2 rounded-lg bg-white border border-slate-200 text-slate-700 text-[13px] font-semibold hover:bg-slate-50 hover:border-slate-300 transition-colors">← Revenue entries</a>
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-3 bg-white border border-slate-200 rounded-xl px-4 py-3">
        <div className="flex items-center gap-2">
          {presetBtn("this_month", "This month")}
          {presetBtn("last_month", "Last month")}
          {presetBtn("this_year", "This year")}
          {presetBtn("all", "All time")}
        </div>
        <div className="flex items-center gap-2 ml-auto">
          <span className="text-[12px] font-semibold text-slate-500 uppercase tracking-wider">From</span>
          <input type="date" value={fromDate} max={toDate || todayISO()} onChange={(e) => { setFromDate(e.target.value); setPreset("custom"); }} className="px-2.5 py-1.5 text-[13px] text-slate-800 bg-white border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-400" />
          <span className="text-[12px] font-semibold text-slate-500 uppercase tracking-wider">To</span>
          <input type="date" value={toDate} min={fromDate || undefined} max={todayISO()} onChange={(e) => { setToDate(e.target.value); setPreset("custom"); }} className="px-2.5 py-1.5 text-[13px] text-slate-800 bg-white border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-400" />
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-4">
        <div className="rounded-xl border border-slate-200 bg-white px-5 py-4">
          <p className="text-[12px] font-semibold text-slate-500 uppercase tracking-wider">Total revenue</p>
          <p className="mt-2 text-[22px] font-semibold text-emerald-700 tabular-nums">৳{formatAmount(total)}</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white px-5 py-4">
          <p className="text-[12px] font-semibold text-slate-500 uppercase tracking-wider">Entries</p>
          <p className="mt-2 text-[22px] font-semibold text-slate-800 tabular-nums">{count}</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white px-5 py-4">
          <p className="text-[12px] font-semibold text-slate-500 uppercase tracking-wider">Avg / day</p>
          <p className="mt-2 text-[22px] font-semibold text-slate-800 tabular-nums">৳{formatAmount(avgPerDay)}</p>
        </div>
      </div>

      {/* By source + by bucket */}
      <div className="grid grid-cols-2 gap-4">
        <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
          <div className="px-5 py-3 bg-slate-50 border-b border-slate-200"><h3 className="text-[13.5px] font-semibold text-slate-700">By source</h3></div>
          <div className="px-5 py-4 space-y-3">
            {bySource.length === 0 ? (
              <p className="text-[13px] text-slate-400 italic">No revenue in this range.</p>
            ) : bySource.map((row) => (
              <div key={row.label} className="space-y-1">
                <div className="flex items-center justify-between text-[12.5px]">
                  <span className="font-medium text-slate-700">{row.label}</span>
                  <span className="text-slate-500 tabular-nums">৳{formatAmount(row.amount)} · {pct(row.amount)}%</span>
                </div>
                <Bar amount={row.amount} max={maxSource} />
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
          <div className="px-5 py-3 bg-slate-50 border-b border-slate-200"><h3 className="text-[13.5px] font-semibold text-slate-700">By bucket</h3></div>
          <div className="px-5 py-4 space-y-3">
            {byBucket.length === 0 ? (
              <p className="text-[13px] text-slate-400 italic">No revenue in this range.</p>
            ) : byBucket.map((row) => (
              <div key={row.label} className="space-y-1">
                <div className="flex items-center justify-between text-[12.5px]">
                  <span className="font-medium text-slate-700">{row.label}</span>
                  <span className="text-slate-500 tabular-nums">৳{formatAmount(row.amount)} · {pct(row.amount)}%</span>
                </div>
                <Bar amount={row.amount} max={maxBucket} />
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Trend */}
      <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3 bg-slate-50 border-b border-slate-200">
          <h3 className="text-[13.5px] font-semibold text-slate-700">Trend</h3>
          <span className="text-[12px] text-slate-400">{trendData.granularity}</span>
        </div>
        <div className="px-5 py-4 space-y-2">
          {trend.length === 0 ? (
            <p className="text-[13px] text-slate-400 italic">No revenue in this range.</p>
          ) : trend.map((row) => (
            <div key={row.key} className="flex items-center gap-3">
              <span className="w-24 flex-shrink-0 text-[12px] text-slate-500">{row.label}</span>
              <div className="flex-1"><Bar amount={row.amount} max={maxTrend} /></div>
              <span className="w-28 flex-shrink-0 text-right text-[12px] text-slate-600 tabular-nums">৳{formatAmount(row.amount)}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Transaction list */}
      <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3 bg-slate-50 border-b border-slate-200">
          <h3 className="text-[13.5px] font-semibold text-slate-700">Transactions</h3>
          <span className="text-[12.5px] text-slate-500">
            {count} {count === 1 ? "entry" : "entries"} ·{" "}
            <span className="font-semibold text-slate-700 tabular-nums">৳{formatAmount(total)}</span>
          </span>
        </div>
        {revenueTxns.length === 0 ? (
          <div className="px-6 py-12 text-center text-[13px] text-slate-400 italic">No revenue in this range.</div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {revenueTxns.map((t) => {
              const isBooking = t.bookingPaymentId !== null;

              if (!isBooking) {
                const m = manualById.get(t.id);
                const cat = m?.category ?? "Revenue";
                const payee = m?.payee ?? "";
                return (
                  <li key={t.id} className="px-5 py-3.5 flex items-center gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2.5">
                        <span className="text-[14px] font-semibold text-slate-800 tabular-nums">৳{formatAmount(t.amount)}</span>
                        <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold uppercase tracking-wider border bg-sky-50 text-sky-700 border-sky-100">{cat}</span>
                        {payee && <span className="text-[12.5px] text-slate-500 truncate">{payee}</span>}
                      </div>
                      <p className="mt-0.5 text-[12px] text-slate-400">{formatDateLabel(t.txnDate)} · {accountName(t.toAccountId)}</p>
                    </div>
                  </li>
                );
              }

              const pmEntry = t.bookingPaymentId ? paymentMap.get(t.bookingPaymentId) : undefined;
              const booking = pmEntry ? bookingsByRef.get(pmEntry.bookingRef) : undefined;
              return (
                <li key={t.id} className="px-5 py-3.5">
                  <div className="flex items-center gap-2.5 flex-wrap">
                    <span className="text-[14px] font-semibold text-slate-800 tabular-nums">৳{formatAmount(t.amount)}</span>
                    <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold uppercase tracking-wider border bg-emerald-50 text-emerald-700 border-emerald-100">{BOOKING_LABEL}</span>
                    {booking && <span className="text-[12.5px] font-medium text-slate-700">{booking.guestName}</span>}
                    {pmEntry && (
                      <a href={`/bookings/${pmEntry.bookingRef}/reservation`} className="text-[12px] font-semibold text-emerald-700 hover:text-emerald-800 hover:underline">{pmEntry.bookingRef} →</a>
                    )}
                  </div>
                  <p className="mt-0.5 text-[12px] text-slate-400">
                    {formatDateLabel(t.txnDate)} · {accountName(t.toAccountId)}{pmEntry ? ` · ${formatMethod(pmEntry.method)}` : ""}
                  </p>
                  {booking ? (
                    <div className="mt-1.5 rounded-lg bg-slate-50 border border-slate-100 px-3 py-2 space-y-0.5 text-[12px] text-slate-600">
                      {booking.rooms.map((r) => (
                        <div key={r.id}>Room {r.roomNumber} · {r.roomCategory} · {r.checkIn} → {r.checkOut} · {r.nights} night{r.nights === 1 ? "" : "s"}</div>
                      ))}
                      <div>Guest: {booking.guestName}{booking.phone ? ` · ${booking.phone}` : ""} · {booking.totalGuests} guest{booking.totalGuests === 1 ? "" : "s"}</div>
                      <div>Booking: {booking.status} · {booking.payment} · total ৳{formatAmount(booking.totalAmount)} / paid ৳{formatAmount(booking.amountPaid)}</div>
                    </div>
                  ) : (
                    <p className="mt-1 text-[12px] text-slate-300 italic">Booking detail unavailable for this payment.</p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

    </div>
  );
}

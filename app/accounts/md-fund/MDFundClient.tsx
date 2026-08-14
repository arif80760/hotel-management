"use client";

// app/accounts/md-fund/MDFundClient.tsx
//
// MD Fund tracking — READ AND DISPLAY ONLY. Two money streams that both
// end up with the MD, in one place:
//   1. RECEIPTS — every transaction INTO the Bank / bKash / Nagad
//      accounts. The MD has sole access to those accounts, so money paid
//      into them never reaches the hotel's till (their balances only
//      ever rise). Resolved from the accounts table as the NON-spendable
//      accounts (is_spendable = false) — never by hardcoded name/id.
//   2. CASH REMUNERATION — expense_out rows in the Remuneration
//      category, resolved by expense_categories.system_key =
//      'remuneration' (NEVER by name — names are user-renameable).
//
// Structure cloned from CashbookReportsClient (admin-gated sibling).
// Date helpers copied verbatim from that page / RevenueReportClient —
// same plain-local (Asia/Dhaka wall clock) semantics, no new date maths.
// No write path, form, day-close logic, balance math, or RPC touched.

import { useEffect, useMemo, useState } from "react";
import { getAccounts, getTransactions, type Account, type AccountTransaction } from "@/services/accountsService";
import { getExpenseCategoryBySystemKey } from "@/services/expenseCategoriesService";
import { getAllEmployees } from "@/services/employeesService";
import { getBookingGuestForPayments } from "@/services/bookingsService";

// ── Date helpers — copied from CashbookReportsClient (same semantics) ──
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
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

type Preset = "today" | "yesterday" | "week" | "month" | "year" | "custom";

export default function MDFundClient() {
  const [preset,   setPreset]   = useState<Preset>("month");
  const [fromDate, setFromDate] = useState<string>(firstOfMonthISO());
  const [toDate,   setToDate]   = useState<string>(todayISO());

  const [accounts,     setAccounts]     = useState<Account[]>([]);
  const [transactions, setTransactions] = useState<AccountTransaction[]>([]);
  const [remunCatId,   setRemunCatId]   = useState<string | null>(null);
  const [employeeName, setEmployeeName] = useState<Map<string, string>>(new Map());
  const [paymentInfo,  setPaymentInfo]  = useState<Map<string, { bookingRef: string; guestName: string }>>(new Map());

  const [fetching,   setFetching]   = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  function applyPreset(p: Exclude<Preset, "custom">) {
    const today = todayISO();
    setPreset(p);
    if (p === "today")          { setFromDate(today);             setToDate(today); }
    else if (p === "yesterday") { const y = yesterdayISO();       setFromDate(y); setToDate(y); }
    else if (p === "week")      { setFromDate(mondayOfWeekISO()); setToDate(today); }
    else if (p === "month")     { setFromDate(firstOfMonthISO()); setToDate(today); }
    else                        { setFromDate(`${new Date().getFullYear()}-01-01`); setToDate(today); }
  }

  // Reference data — once on mount. Remuneration resolved by system_key.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [accts, remunCat, emps] = await Promise.all([
          getAccounts(),
          getExpenseCategoryBySystemKey("remuneration"),
          getAllEmployees(),
        ]);
        if (cancelled) return;
        setAccounts(accts);
        setRemunCatId(remunCat?.id ?? null);
        setEmployeeName(new Map(emps.map((e) => [e.id, e.fullName])));
      } catch (e) {
        if (!cancelled) setFetchError(e instanceof Error ? e.message : "Failed to load reference data.");
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Transactions for the selected range.
  useEffect(() => {
    let cancelled = false;
    setFetching(true);
    setFetchError(null);
    getTransactions({ fromDate: fromDate || undefined, toDate: toDate || undefined })
      .then((t) => { if (!cancelled) setTransactions(t); })
      .catch((e) => { if (!cancelled) setFetchError(e instanceof Error ? e.message : "Failed to load transactions."); })
      .finally(() => { if (!cancelled) setFetching(false); });
    return () => { cancelled = true; };
  }, [fromDate, toDate]);

  // MD accounts = the non-spendable accounts (Bank / bKash / Nagad) —
  // resolved from the accounts table; Cash in Hand is the spendable one.
  const mdAccounts = useMemo(() => accounts.filter((a) => !a.isSpendable), [accounts]);
  const mdAccountName = useMemo(() => new Map(mdAccounts.map((a) => [a.id, a.name])), [mdAccounts]);

  // Stream 1 — receipts INTO MD accounts (any inflow; voided rows are
  // already excluded by getTransactions).
  const receipts = useMemo(
    () => transactions.filter((t) => t.toAccountId && mdAccountName.has(t.toAccountId)),
    [transactions, mdAccountName],
  );

  // Stream 2 — cash remuneration (system_key-resolved category).
  const remunerations = useMemo(
    () => (remunCatId ? transactions.filter((t) => t.type === "expense_out" && t.categoryId === remunCatId) : []),
    [transactions, remunCatId],
  );

  // Booking ref + guest for guest-payment receipts — ONE batched lookup
  // per data change, never per row (display only; a failure just leaves
  // rows without booking context).
  useEffect(() => {
    const ids = [...new Set(receipts.filter((t) => t.bookingPaymentId).map((t) => t.bookingPaymentId as string))];
    if (ids.length === 0) { setPaymentInfo(new Map()); return; }
    let cancelled = false;
    getBookingGuestForPayments(ids)
      .then((m) => { if (!cancelled) setPaymentInfo(m); })
      .catch((e) => console.error("[MDFund] booking/guest lookup failed:", e instanceof Error ? e.message : e));
    return () => { cancelled = true; };
  }, [receipts]);

  // ── Summary ────────────────────────────────────────────────
  const perAccount = useMemo(() => {
    const sums = new Map<string, number>();
    for (const t of receipts) sums.set(t.toAccountId!, (sums.get(t.toAccountId!) ?? 0) + t.amount);
    return mdAccounts.map((a) => ({ id: a.id, name: a.name, total: sums.get(a.id) ?? 0 }));
  }, [receipts, mdAccounts]);
  const receiptsTotal = useMemo(() => perAccount.reduce((s, a) => s + a.total, 0), [perAccount]);
  const remunTotal    = useMemo(() => remunerations.reduce((s, t) => s + t.amount, 0), [remunerations]);
  const grandTotal    = receiptsTotal + remunTotal;

  const tile = "bg-white border border-slate-200 rounded-xl px-4 py-3";
  const tileLabel = "text-[11px] font-semibold text-slate-400 uppercase tracking-wider";
  const tileValue = "text-[18px] font-bold text-slate-800 tabular-nums whitespace-nowrap mt-1";

  return (
    <div className="p-4 sm:p-8 space-y-4 sm:space-y-5 max-w-5xl">

      {/* ── Header ──────────────────────────────────────────── */}
      <div>
        <h1 className="text-2xl font-semibold text-slate-800">MD Fund</h1>
        <p className="text-[13px] text-slate-500 mt-1">
          Money that reaches the MD — receipts into the MD-held accounts plus cash remuneration.
        </p>
      </div>

      {/* ── Filter bar (same pattern as Cashbook Reports) ───── */}
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
          {fetching ? "Loading…" : `${receipts.length + remunerations.length} transactions`}
        </span>
      </div>

      {fetchError && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-[13px] text-rose-700">{fetchError}</div>
      )}
      {!fetchError && remunCatId === null && !fetching && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-[12.5px] text-amber-800">
          No expense category carries system_key = &lsquo;remuneration&rsquo; — the remuneration stream cannot be resolved and shows empty.
        </div>
      )}

      {/* ── Summary strip ───────────────────────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {perAccount.map((a) => (
          <div key={a.id} className={tile}>
            <p className={tileLabel}>Via {a.name}</p>
            <p className={tileValue}>৳{formatAmount(a.total)}</p>
          </div>
        ))}
        <div className={`${tile} border-sky-200`}>
          <p className={`${tileLabel} text-sky-600`}>Account receipts total</p>
          <p className={tileValue}>৳{formatAmount(receiptsTotal)}</p>
        </div>
        <div className={`${tile} border-amber-200`}>
          <p className={`${tileLabel} text-amber-600`}>Cash remuneration paid</p>
          <p className={tileValue}>৳{formatAmount(remunTotal)}</p>
        </div>
        <div className="bg-slate-900 rounded-xl px-4 py-3">
          <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">MD Fund total</p>
          <p className="text-[18px] font-bold text-white tabular-nums whitespace-nowrap mt-1">৳{formatAmount(grandTotal)}</p>
        </div>
      </div>

      {/* ── Two streams, side by side (stacked on phones) ───── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

        {/* Stream 1 — account receipts */}
        <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
          <div className="px-4 sm:px-5 py-3 bg-sky-50 border-b border-sky-100 flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5">
            <h2 className="text-[13px] font-semibold text-sky-900">Received into MD accounts</h2>
            <span className="text-[12px] text-sky-700 tabular-nums whitespace-nowrap">৳{formatAmount(receiptsTotal)} · {receipts.length}</span>
          </div>
          <ul className="divide-y divide-slate-100">
            {!fetching && receipts.length === 0 ? (
              <li className="px-4 sm:px-5 py-8 text-center text-[12.5px] text-slate-400">No receipts in this range.</li>
            ) : receipts.map((t) => {
              const info = t.bookingPaymentId ? paymentInfo.get(t.bookingPaymentId) : undefined;
              return (
                <li key={t.id} className="px-4 sm:px-5 py-3 flex flex-wrap sm:flex-nowrap items-center gap-x-4 gap-y-1">
                  <div className="w-full sm:w-auto flex-none sm:flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="text-[12.5px] text-slate-500 whitespace-nowrap">{formatDateLabel(t.txnDate)}</span>
                      <span className="text-[10.5px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full bg-sky-50 text-sky-700 whitespace-nowrap">
                        {mdAccountName.get(t.toAccountId!) ?? "—"}
                      </span>
                      {info && (info.bookingRef || info.guestName) && (
                        <span className="text-[12px] text-slate-600 truncate min-w-0" title={`${info.bookingRef}${info.guestName ? ` · ${info.guestName}` : ""}`}>
                          {info.bookingRef}{info.guestName ? ` · ${info.guestName}` : ""}
                        </span>
                      )}
                      {!t.bookingPaymentId && t.note && (
                        <span className="text-[12px] text-slate-500 truncate min-w-0">{t.note}</span>
                      )}
                    </div>
                  </div>
                  <p className="ml-auto text-[14px] font-semibold text-sky-700 tabular-nums whitespace-nowrap flex-shrink-0">
                    +৳{formatAmount(t.amount)}
                  </p>
                </li>
              );
            })}
          </ul>
        </div>

        {/* Stream 2 — cash remuneration */}
        <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
          <div className="px-4 sm:px-5 py-3 bg-amber-50 border-b border-amber-100 flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5">
            <h2 className="text-[13px] font-semibold text-amber-900">Cash remuneration paid</h2>
            <span className="text-[12px] text-amber-700 tabular-nums whitespace-nowrap">৳{formatAmount(remunTotal)} · {remunerations.length}</span>
          </div>
          <ul className="divide-y divide-slate-100">
            {!fetching && remunerations.length === 0 ? (
              <li className="px-4 sm:px-5 py-8 text-center text-[12.5px] text-slate-400">No remuneration in this range.</li>
            ) : remunerations.map((t) => {
              const recipient = (t.employeeId ? employeeName.get(t.employeeId) : undefined) ?? (t.payee?.trim() || "—");
              return (
                <li key={t.id} className="px-4 sm:px-5 py-3 flex flex-wrap sm:flex-nowrap items-center gap-x-4 gap-y-1">
                  <div className="w-full sm:w-auto flex-none sm:flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="text-[12.5px] text-slate-500 whitespace-nowrap">{formatDateLabel(t.txnDate)}</span>
                      <span className="text-[12.5px] font-medium text-slate-700 truncate min-w-0">{recipient}</span>
                    </div>
                    {t.note && <p className="text-[12px] text-slate-400 truncate">{t.note}</p>}
                  </div>
                  <p className="ml-auto text-[14px] font-semibold text-amber-700 tabular-nums whitespace-nowrap flex-shrink-0">
                    −৳{formatAmount(t.amount)}
                  </p>
                </li>
              );
            })}
          </ul>
        </div>
      </div>

      <p className="text-[11.5px] text-slate-400">
        Receipts cover every transaction into the Bank, bKash and Nagad accounts (the MD holds sole
        access; these balances never fund the till). Remuneration is resolved by the category&rsquo;s
        system key, never its display name. Read-only view — nothing here writes.
      </p>
    </div>
  );
}

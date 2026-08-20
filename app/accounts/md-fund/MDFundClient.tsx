"use client";

// app/accounts/md-fund/MDFundClient.tsx
//
// MD Fund — READ AND DISPLAY ONLY. Redesigned 2026-08-20 for the
// central-fund model (2026-08-16): all revenue lands in Cash in Hand,
// so the old "receipts into MD accounts" stream is structurally zero
// for new dates. The MD accounts (Bank / bKash / Nagad — every
// is_spendable = false account, resolved from the accounts table,
// never by name/id) now change ONLY via:
//   IN  — explicit transfers from Cash in Hand
//   OUT — guarded remuneration drawdowns + transfers back out
//
// Page structure:
//   • Balance cards — CURRENT balance per MD account + combined,
//     computed from the full transaction set with the exact
//     account_balances view semantics (non-deleted rows, to − from),
//     so the numbers can never disagree with the Accounts page.
//   • Range flow tiles + per-account mini-statement:
//     opening / in / out / closing for the selected range.
//   • Stream A — transfers INTO MD accounts.
//   • Stream B — money OUT of MD accounts (drawdowns + transfers out).
//   • Legacy stream — direct receipts into MD accounts (pre-central-
//     fund routing, before 2026-08-16), shown for historical ranges
//     instead of silently vanishing.
//   • Cash remuneration — COLLAPSED section (MD income taken in cash
//     from the till; kept so the page still answers "what did the MD
//     take this month" in one place). Excludes MD-account drawdowns,
//     which already appear in Stream B — no double counting.
//
// Entry stays in the Daybook / remuneration form — no write path here.

import { useEffect, useMemo, useState } from "react";
import { getAccounts, getTransactions, type Account, type AccountTransaction } from "@/services/accountsService";
import { getExpenseCategoryBySystemKey } from "@/services/expenseCategoriesService";
import { getAllEmployees } from "@/services/employeesService";
import { getBookingGuestForPayments } from "@/services/bookingsService";

// Central-fund changeover — receipts into MD accounts before this date
// are legitimate history (old method→bucket routing); on/after it they
// should not exist.
const CENTRAL_FUND_DATE = "2026-08-16";

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
  // ALL transactions, fetched once — the MD-account subset is small and
  // full history is needed anyway for opening/closing balance math.
  const [transactions, setTransactions] = useState<AccountTransaction[]>([]);
  const [remunCatId,   setRemunCatId]   = useState<string | null>(null);
  const [employeeName, setEmployeeName] = useState<Map<string, string>>(new Map());
  const [paymentInfo,  setPaymentInfo]  = useState<Map<string, { bookingRef: string; guestName: string }>>(new Map());
  const [showRemun,    setShowRemun]    = useState(false);   // collapsed by default

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

  // Everything loads once — range changes are pure client-side filtering.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [accts, txns, remunCat, emps] = await Promise.all([
          getAccounts(),
          getTransactions({}),   // full history; voided rows excluded by the service
          getExpenseCategoryBySystemKey("remuneration"),
          getAllEmployees(),
        ]);
        if (cancelled) return;
        setAccounts(accts);
        setTransactions(txns);
        setRemunCatId(remunCat?.id ?? null);
        setEmployeeName(new Map(emps.map((e) => [e.id, e.fullName])));
      } catch (e) {
        if (!cancelled) setFetchError(e instanceof Error ? e.message : "Failed to load MD Fund data.");
      } finally {
        if (!cancelled) setFetching(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // MD accounts = the non-spendable accounts — resolved from the
  // accounts table; Cash in Hand is the spendable one.
  const mdAccounts    = useMemo(() => accounts.filter((a) => !a.isSpendable), [accounts]);
  const mdAccountName = useMemo(() => new Map(mdAccounts.map((a) => [a.id, a.name])), [mdAccounts]);
  const accountName   = useMemo(() => new Map(accounts.map((a) => [a.id, a.name])), [accounts]);

  // All transactions touching an MD account, oldest → newest irrelevant —
  // sums only. Same row-set semantics as the account_balances view.
  const mdTxns = useMemo(
    () => transactions.filter((t) =>
      (t.toAccountId   && mdAccountName.has(t.toAccountId)) ||
      (t.fromAccountId && mdAccountName.has(t.fromAccountId))),
    [transactions, mdAccountName],
  );

  // Per-account statement: current balance (all rows) and range
  // opening / in / out / closing. Balance expression mirrors the
  // account_balances view: SUM(to) − SUM(from) over non-deleted rows.
  const statements = useMemo(() => {
    return mdAccounts.map((a) => {
      let current = 0, opening = 0, rangeIn = 0, rangeOut = 0;
      for (const t of mdTxns) {
        const inflow  = t.toAccountId   === a.id ? t.amount : 0;
        const outflow = t.fromAccountId === a.id ? t.amount : 0;
        if (inflow === 0 && outflow === 0) continue;
        current += inflow - outflow;
        if (t.txnDate < fromDate) opening += inflow - outflow;
        else if (t.txnDate <= toDate) { rangeIn += inflow; rangeOut += outflow; }
      }
      return { id: a.id, name: a.name, current, opening, rangeIn, rangeOut, closing: opening + rangeIn - rangeOut };
    });
  }, [mdAccounts, mdTxns, fromDate, toDate]);
  const combinedCurrent = useMemo(() => statements.reduce((s, a) => s + a.current, 0), [statements]);

  // Range subset of MD transactions.
  const inRange = useMemo(
    () => mdTxns.filter((t) => t.txnDate >= fromDate && t.txnDate <= toDate),
    [mdTxns, fromDate, toDate],
  );

  // Stream A — transfers INTO MD accounts (the post-changeover inflow path).
  const transfersIn = useMemo(
    () => inRange.filter((t) => t.type === "transfer" && t.toAccountId && mdAccountName.has(t.toAccountId)
      && !(t.fromAccountId && mdAccountName.has(t.fromAccountId))),
    [inRange, mdAccountName],
  );
  // Stream B — money OUT of MD accounts: guarded drawdowns (expense_out)
  // and transfers back out. MD→MD moves (none expected) would show here.
  const moneyOut = useMemo(
    () => inRange.filter((t) => t.fromAccountId && mdAccountName.has(t.fromAccountId)),
    [inRange, mdAccountName],
  );
  // Legacy stream — non-transfer inflows (revenue receipts under the old
  // method→bucket routing, injections). Labelled by era below.
  const legacyReceipts = useMemo(
    () => inRange.filter((t) => t.type !== "transfer" && t.toAccountId && mdAccountName.has(t.toAccountId)),
    [inRange, mdAccountName],
  );

  // Cash remuneration (collapsed section): remuneration-category rows NOT
  // paid from an MD account — those are drawdowns and live in Stream B.
  const cashRemun = useMemo(
    () => (remunCatId
      ? transactions.filter((t) =>
          t.type === "expense_out" && t.categoryId === remunCatId &&
          t.txnDate >= fromDate && t.txnDate <= toDate &&
          !(t.fromAccountId && mdAccountName.has(t.fromAccountId)))
      : []),
    [transactions, remunCatId, fromDate, toDate, mdAccountName],
  );

  const transfersInTotal = useMemo(() => transfersIn.reduce((s, t) => s + t.amount, 0), [transfersIn]);
  const moneyOutTotal    = useMemo(() => moneyOut.reduce((s, t) => s + t.amount, 0), [moneyOut]);
  const legacyTotal      = useMemo(() => legacyReceipts.reduce((s, t) => s + t.amount, 0), [legacyReceipts]);
  const cashRemunTotal   = useMemo(() => cashRemun.reduce((s, t) => s + t.amount, 0), [cashRemun]);

  // Booking ref + guest for legacy guest-payment receipts — ONE batched
  // lookup per data change (display only; failure just omits context).
  useEffect(() => {
    const ids = [...new Set(legacyReceipts.filter((t) => t.bookingPaymentId).map((t) => t.bookingPaymentId as string))];
    if (ids.length === 0) { setPaymentInfo(new Map()); return; }
    let cancelled = false;
    getBookingGuestForPayments(ids)
      .then((m) => { if (!cancelled) setPaymentInfo(m); })
      .catch((e) => console.error("[MDFund] booking/guest lookup failed:", e instanceof Error ? e.message : e));
    return () => { cancelled = true; };
  }, [legacyReceipts]);

  const tile = "bg-white border border-slate-200 rounded-xl px-4 py-3";
  const tileLabel = "text-[11px] font-semibold text-slate-400 uppercase tracking-wider";
  const tileValue = "text-[18px] font-bold text-slate-800 tabular-nums whitespace-nowrap mt-1";

  return (
    <div className="p-4 sm:p-8 space-y-4 sm:space-y-5 max-w-5xl">

      {/* ── Header ──────────────────────────────────────────── */}
      <div>
        <h1 className="text-2xl font-semibold text-slate-800">MD Fund</h1>
        <p className="text-[13px] text-slate-500 mt-1">
          The MD&rsquo;s personal accounts — not operating cash. Since {formatDateLabel(CENTRAL_FUND_DATE)} they
          change only via explicit transfers in and guarded drawdowns out.
        </p>
      </div>

      {/* ── Current balances (all-time, view-identical math) ── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {statements.map((a) => (
          <div key={a.id} className={tile}>
            <p className={tileLabel}>{a.name} — balance now</p>
            <p className={tileValue}>৳{formatAmount(a.current)}</p>
          </div>
        ))}
        <div className="bg-slate-900 rounded-xl px-4 py-3">
          <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">MD holdings — total</p>
          <p className="text-[18px] font-bold text-white tabular-nums whitespace-nowrap mt-1">৳{formatAmount(combinedCurrent)}</p>
        </div>
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
          {fetching ? "Loading…" : `${transfersIn.length + moneyOut.length + legacyReceipts.length} MD-account movements`}
        </span>
      </div>

      {fetchError && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-[13px] text-rose-700">{fetchError}</div>
      )}
      {!fetchError && remunCatId === null && !fetching && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-[12.5px] text-amber-800">
          No expense category carries system_key = &lsquo;remuneration&rsquo; — the cash remuneration section cannot be resolved and shows empty.
        </div>
      )}

      {/* ── Range flow tiles ────────────────────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className={`${tile} border-emerald-200`}>
          <p className={`${tileLabel} text-emerald-600`}>Transfers in (range)</p>
          <p className={tileValue}>৳{formatAmount(transfersInTotal)}</p>
        </div>
        <div className={`${tile} border-rose-200`}>
          <p className={`${tileLabel} text-rose-600`}>Money out (range)</p>
          <p className={tileValue}>৳{formatAmount(moneyOutTotal)}</p>
        </div>
        <div className={tile}>
          <p className={tileLabel}>Net movement (range)</p>
          <p className={tileValue}>{transfersInTotal + legacyTotal - moneyOutTotal < 0 ? "−" : ""}৳{formatAmount(Math.abs(transfersInTotal + legacyTotal - moneyOutTotal))}</p>
        </div>
      </div>

      {/* ── Per-account mini-statement for the range ────────── */}
      <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
        <div className="px-4 sm:px-5 py-3 bg-slate-50 border-b border-slate-200">
          <h2 className="text-[13px] font-semibold text-slate-800">Account statements — {formatDateLabel(fromDate)} to {formatDateLabel(toDate)}</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[12.5px]">
            <thead>
              <tr className="text-left text-slate-400 border-b border-slate-100">
                <th className="px-4 sm:px-5 py-2 font-semibold uppercase tracking-wider text-[10.5px]">Account</th>
                <th className="px-3 py-2 font-semibold uppercase tracking-wider text-[10.5px] text-right">Opening</th>
                <th className="px-3 py-2 font-semibold uppercase tracking-wider text-[10.5px] text-right">In</th>
                <th className="px-3 py-2 font-semibold uppercase tracking-wider text-[10.5px] text-right">Out</th>
                <th className="px-4 sm:px-5 py-2 font-semibold uppercase tracking-wider text-[10.5px] text-right">Closing</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {statements.map((a) => (
                <tr key={a.id}>
                  <td className="px-4 sm:px-5 py-2.5 font-medium text-slate-700">{a.name}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-slate-600">৳{formatAmount(a.opening)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-emerald-700">{a.rangeIn > 0 ? `+৳${formatAmount(a.rangeIn)}` : "—"}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-rose-700">{a.rangeOut > 0 ? `−৳${formatAmount(a.rangeOut)}` : "—"}</td>
                  <td className="px-4 sm:px-5 py-2.5 text-right tabular-nums font-semibold text-slate-800">৳{formatAmount(a.closing)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Streams A + B, side by side (stacked on phones) ─── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

        {/* Stream A — transfers in */}
        <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
          <div className="px-4 sm:px-5 py-3 bg-emerald-50 border-b border-emerald-100 flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5">
            <h2 className="text-[13px] font-semibold text-emerald-900">Transfers into MD accounts</h2>
            <span className="text-[12px] text-emerald-700 tabular-nums whitespace-nowrap">৳{formatAmount(transfersInTotal)} · {transfersIn.length}</span>
          </div>
          <ul className="divide-y divide-slate-100">
            {!fetching && transfersIn.length === 0 ? (
              <li className="px-4 sm:px-5 py-8 text-center text-[12.5px] text-slate-400">No transfers in this range.</li>
            ) : transfersIn.map((t) => (
              <li key={t.id} className="px-4 sm:px-5 py-3 flex flex-wrap sm:flex-nowrap items-center gap-x-4 gap-y-1">
                <div className="w-full sm:w-auto flex-none sm:flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="text-[12.5px] text-slate-500 whitespace-nowrap">{formatDateLabel(t.txnDate)}</span>
                    <span className="text-[10.5px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 whitespace-nowrap">
                      {(t.fromAccountId ? accountName.get(t.fromAccountId) : null) ?? "—"} → {mdAccountName.get(t.toAccountId!) ?? "—"}
                    </span>
                    {t.note && <span className="text-[12px] text-slate-500 truncate min-w-0">{t.note}</span>}
                  </div>
                </div>
                <p className="ml-auto text-[14px] font-semibold text-emerald-700 tabular-nums whitespace-nowrap flex-shrink-0">
                  +৳{formatAmount(t.amount)}
                </p>
              </li>
            ))}
          </ul>
        </div>

        {/* Stream B — money out */}
        <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
          <div className="px-4 sm:px-5 py-3 bg-rose-50 border-b border-rose-100 flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5">
            <h2 className="text-[13px] font-semibold text-rose-900">Money out of MD accounts</h2>
            <span className="text-[12px] text-rose-700 tabular-nums whitespace-nowrap">৳{formatAmount(moneyOutTotal)} · {moneyOut.length}</span>
          </div>
          <ul className="divide-y divide-slate-100">
            {!fetching && moneyOut.length === 0 ? (
              <li className="px-4 sm:px-5 py-8 text-center text-[12.5px] text-slate-400">No drawdowns or transfers out in this range.</li>
            ) : moneyOut.map((t) => {
              const isDrawdown = t.type === "expense_out";
              const recipient  = isDrawdown
                ? ((t.employeeId ? employeeName.get(t.employeeId) : undefined) ?? (t.payee?.trim() || "—"))
                : ((t.toAccountId ? accountName.get(t.toAccountId) : null) ?? "—");
              return (
                <li key={t.id} className="px-4 sm:px-5 py-3 flex flex-wrap sm:flex-nowrap items-center gap-x-4 gap-y-1">
                  <div className="w-full sm:w-auto flex-none sm:flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="text-[12.5px] text-slate-500 whitespace-nowrap">{formatDateLabel(t.txnDate)}</span>
                      <span className="text-[10.5px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full bg-rose-50 text-rose-700 whitespace-nowrap">
                        {mdAccountName.get(t.fromAccountId!) ?? "—"} · {isDrawdown ? "drawdown" : "transfer out"}
                      </span>
                      <span className="text-[12.5px] font-medium text-slate-700 truncate min-w-0">{recipient}</span>
                    </div>
                    {t.note && <p className="text-[12px] text-slate-400 truncate">{t.note}</p>}
                  </div>
                  <p className="ml-auto text-[14px] font-semibold text-rose-700 tabular-nums whitespace-nowrap flex-shrink-0">
                    −৳{formatAmount(t.amount)}
                  </p>
                </li>
              );
            })}
          </ul>
        </div>
      </div>

      {/* ── Legacy stream — pre-central-fund direct receipts ── */}
      {legacyReceipts.length > 0 && (
        <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
          <div className="px-4 sm:px-5 py-3 bg-sky-50 border-b border-sky-100 flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5">
            <h2 className="text-[13px] font-semibold text-sky-900">Direct receipts — pre-central-fund routing (before {formatDateLabel(CENTRAL_FUND_DATE)})</h2>
            <span className="text-[12px] text-sky-700 tabular-nums whitespace-nowrap">৳{formatAmount(legacyTotal)} · {legacyReceipts.length}</span>
          </div>
          <ul className="divide-y divide-slate-100">
            {legacyReceipts.map((t) => {
              const info = t.bookingPaymentId ? paymentInfo.get(t.bookingPaymentId) : undefined;
              const postChangeover = t.txnDate >= CENTRAL_FUND_DATE;
              return (
                <li key={t.id} className="px-4 sm:px-5 py-3 flex flex-wrap sm:flex-nowrap items-center gap-x-4 gap-y-1">
                  <div className="w-full sm:w-auto flex-none sm:flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="text-[12.5px] text-slate-500 whitespace-nowrap">{formatDateLabel(t.txnDate)}</span>
                      <span className="text-[10.5px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full bg-sky-50 text-sky-700 whitespace-nowrap">
                        {mdAccountName.get(t.toAccountId!) ?? "—"} · {t.type.replace("_", " ")}
                      </span>
                      {postChangeover && (
                        <span className="text-[10.5px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 whitespace-nowrap" title="Direct receipts into MD accounts should not occur after the central-fund changeover — investigate.">
                          ⚠ post-changeover
                        </span>
                      )}
                      {info && (info.bookingRef || info.guestName) && (
                        <span className="text-[12px] text-slate-600 truncate min-w-0">
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
      )}

      {/* ── Cash remuneration — collapsed ───────────────────── */}
      <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
        <button
          type="button"
          onClick={() => setShowRemun((v) => !v)}
          className="w-full px-4 sm:px-5 py-3 bg-amber-50 border-b border-amber-100 flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 text-left hover:bg-amber-100/60 transition-colors"
        >
          <span className="text-[13px] font-semibold text-amber-900">
            {showRemun ? "▾" : "▸"} Cash remuneration (from the till) — not an MD-account movement
          </span>
          <span className="text-[12px] text-amber-700 tabular-nums whitespace-nowrap">৳{formatAmount(cashRemunTotal)} · {cashRemun.length}</span>
        </button>
        {showRemun && (
          <ul className="divide-y divide-slate-100">
            {!fetching && cashRemun.length === 0 ? (
              <li className="px-4 sm:px-5 py-8 text-center text-[12.5px] text-slate-400">No cash remuneration in this range.</li>
            ) : cashRemun.map((t) => {
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
        )}
      </div>

      <p className="text-[11.5px] text-slate-400">
        Balances use the same maths as the Accounts page (non-voided rows, inflows minus outflows) so the two
        can never disagree. MD accounts are resolved as the non-spendable accounts; remuneration by the
        category&rsquo;s system key, never its display name. Drawdowns paid FROM an MD account appear only under
        &ldquo;Money out&rdquo; — the cash section excludes them, so nothing is counted twice. Read-only view — nothing here writes.
      </p>
    </div>
  );
}

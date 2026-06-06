"use client";

// app/accounts/cashbook/CashbookClient.tsx
// Accounts daybook — client component.
//
// STAGE 2. Built in pieces:
//   4a — scaffold: state + parallel load + loading/error shell  ← THIS STEP
//   4b — DatePickerField + calendar consts + inputCls (copied
//        from EmployeesClient; this codebase has no shared UI layer)
//   4c — manual transaction entry form (transfer / injection)
//   Step 5 — balance cards, transaction list, date filters
//
// Manual entry is limited to 'transfer' and 'injection' — the other
// four transaction types get dedicated feature stages later.

import { useState, useEffect, useRef } from "react";
import {
  getBalances,
  getAccounts,
  getTransactions,
  createTransaction,
  updateTransaction,
  deleteTransaction,
  transactionsToCsv,
  ACCOUNT_IDS,
  type AccountBalance,
  type Account,
  type AccountTransaction,
  type ManualTxnType,
} from "@/services/accountsService";

import {
  getDayCloseStatus,
  getPastDayActivity,
  closeDay,
  closePastDay,
  type DayCloseStatus,
  type PastDayActivity,
} from "@/services/dayCloseService";

import LoanEntryActions from "@/app/accounts/loans/LoanEntryActions";

// ─────────────────────────────────────────────────────────────
// COPIED FROM app/employees/EmployeesClient.tsx
// This codebase has no shared UI primitives layer (no components/ui/);
// each feature inlines its own. Per-feature duplication is the existing
// convention. Extracting these into a shared module is a candidate for
// the minor backlog.
// ─────────────────────────────────────────────────────────────

// ── Input styling helper ──
function inputCls(hasError = false): string {
  return [
    "w-full px-3.5 py-2.5 text-[13.5px] text-slate-800 bg-white border rounded-lg",
    "placeholder:text-slate-300 focus:outline-none focus:ring-2 focus:ring-amber-400 focus:border-transparent transition",
    hasError ? "border-rose-300 bg-rose-50" : "border-slate-200",
  ].join(" ");
}

// ── Calendar constants ──
const CAL_MONTHS_LONG  = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const CAL_MONTHS_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const CAL_DAYS         = ["Su","Mo","Tu","We","Th","Fr","Sa"];

// ── DatePickerField — three-mode (day / month / year) drill-down picker ──
type CalMode = "day" | "month" | "year";

/** Returns the start of a 12-year block that contains `year` */
function yearBlockStart(year: number): number {
  return Math.floor(year / 12) * 12;
}

function DatePickerField({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const [open,       setOpen]       = useState(false);
  const [openUpward, setOpenUpward] = useState(false);
  const [mode,       setMode]       = useState<CalMode>("day");
  const containerRef = useRef<HTMLDivElement>(null);

  const today  = new Date();
  const parsed = value ? new Date(`${value}T12:00:00`) : null;

  const [viewYear,       setViewYear]       = useState(() => parsed?.getFullYear() ?? today.getFullYear());
  const [viewMonth,      setViewMonth]      = useState(() => parsed?.getMonth()    ?? today.getMonth());
  const [yearRangeStart, setYearRangeStart] = useState(() => yearBlockStart(parsed?.getFullYear() ?? today.getFullYear()));

  // ── Close on outside click ───────────────────────────────
  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // ── Open / close ─────────────────────────────────────────
  function handleToggle() {
    if (!open && containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      setOpenUpward(window.innerHeight - rect.bottom < 360);
      setMode("day");
    }
    setOpen(o => !o);
  }

  // ── Prev / Next arrows (behaviour depends on current mode) ─
  function handlePrev() {
    if (mode === "day") {
      if (viewMonth === 0) { setViewYear(y => y - 1); setViewMonth(11); }
      else setViewMonth(m => m - 1);
    } else if (mode === "month") {
      setViewYear(y => y - 1);
    } else {
      setYearRangeStart(s => s - 12);
    }
  }
  function handleNext() {
    if (mode === "day") {
      if (viewMonth === 11) { setViewYear(y => y + 1); setViewMonth(0); }
      else setViewMonth(m => m + 1);
    } else if (mode === "month") {
      setViewYear(y => y + 1);
    } else {
      setYearRangeStart(s => s + 12);
    }
  }

  // ── Header click: day → month → year ─────────────────────
  function handleHeaderClick() {
    if (mode === "day")   { setMode("month"); }
    if (mode === "month") {
      setYearRangeStart(yearBlockStart(viewYear));
      setMode("year");
    }
    // year mode header is not clickable (it's a range label)
  }

  // ── Day selection ────────────────────────────────────────
  const firstWeekday = new Date(viewYear, viewMonth, 1).getDay();
  const daysInMonth  = new Date(viewYear, viewMonth + 1, 0).getDate();
  const dayCells: (number | null)[] = [
    ...Array<null>(firstWeekday).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];
  while (dayCells.length % 7 !== 0) dayCells.push(null);

  function selectDay(day: number) {
    const m = String(viewMonth + 1).padStart(2, "0");
    const d = String(day).padStart(2, "0");
    onChange(`${viewYear}-${m}-${d}`);
    setOpen(false);
  }

  function isSelectedDay(day: number) {
    return !!parsed && parsed.getFullYear() === viewYear && parsed.getMonth() === viewMonth && parsed.getDate() === day;
  }
  function isTodayDay(day: number) {
    return today.getFullYear() === viewYear && today.getMonth() === viewMonth && today.getDate() === day;
  }

  // ── Month selection ──────────────────────────────────────
  function selectMonth(monthIndex: number) {
    setViewMonth(monthIndex);
    setMode("day");
  }
  function isSelectedMonth(monthIndex: number) {
    return !!parsed && parsed.getFullYear() === viewYear && parsed.getMonth() === monthIndex;
  }
  function isTodayMonth(monthIndex: number) {
    return today.getFullYear() === viewYear && today.getMonth() === monthIndex;
  }

  // ── Year selection ───────────────────────────────────────
  const yearCells = Array.from({ length: 12 }, (_, i) => yearRangeStart + i);

  function selectYear(year: number) {
    setViewYear(year);
    setMode("month");
  }
  function isSelectedYear(year: number) {
    return !!parsed && parsed.getFullYear() === year;
  }
  function isTodayYear(year: number) {
    return today.getFullYear() === year;
  }

  // ── Today shortcut ───────────────────────────────────────
  function selectToday() {
    const t = new Date();
    onChange(`${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`);
    setViewYear(t.getFullYear());
    setViewMonth(t.getMonth());
    setOpen(false);
  }

  // ── Header label per mode ────────────────────────────────
  const headerLabel =
    mode === "day"   ? `${CAL_MONTHS_LONG[viewMonth]} ${viewYear}` :
    mode === "month" ? `${viewYear}`                                :
    `${yearRangeStart} – ${yearRangeStart + 11}`;

  const headerClickable = mode !== "year";

  const displayText = parsed
    ? parsed.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
    : "";

  // ── Shared nav-arrow button ──────────────────────────────
  function NavArrow({ dir, onClick, label }: { dir: "left" | "right"; onClick: () => void; label: string }) {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        className="w-7 h-7 flex items-center justify-center rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors flex-shrink-0"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="w-3.5 h-3.5">
          <path d={dir === "left" ? "M15 18l-6-6 6-6" : "M9 18l6-6-6-6"}/>
        </svg>
      </button>
    );
  }

  return (
    <div ref={containerRef} className="relative">

      {/* ── Trigger button ─────────────────────────────────── */}
      <button
        type="button"
        onClick={handleToggle}
        className={`w-full flex items-center gap-2.5 px-3.5 py-2.5 text-left bg-white border rounded-lg transition-all focus:outline-none ${
          open
            ? "border-amber-400 ring-2 ring-amber-400/25 shadow-sm"
            : "border-slate-200 hover:border-slate-300 hover:shadow-sm"
        }`}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"
          className={`w-[17px] h-[17px] flex-shrink-0 transition-colors ${open ? "text-amber-500" : "text-slate-400"}`}>
          <rect x="3" y="4" width="18" height="17" rx="2"/>
          <path d="M3 10h18"/><path d="M8 2v4"/><path d="M16 2v4"/>
        </svg>
        <span className={`flex-1 text-[13.5px] ${displayText ? "text-slate-800 font-medium" : "text-slate-300"}`}>
          {displayText || "Select a date"}
        </span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
          className={`w-4 h-4 text-slate-400 flex-shrink-0 transition-transform duration-200 ${open ? "rotate-180 text-amber-500" : ""}`}>
          <path d="M6 9l6 6 6-6"/>
        </svg>
      </button>

      {/* ── Dropdown panel ─────────────────────────────────── */}
      {open && (
        <div className={`absolute left-0 z-30 bg-white border border-slate-200 rounded-xl shadow-2xl p-4 w-[272px] ${
          openUpward ? "bottom-full mb-2" : "top-full mt-2"
        }`}>

          {/* ── Shared header: prev arrow · label · next arrow ─ */}
          <div className="flex items-center justify-between mb-3 gap-1">
            <NavArrow dir="left"  onClick={handlePrev} label={mode === "day" ? "Previous month" : mode === "month" ? "Previous year" : "Previous 12 years"} />

            {headerClickable ? (
              <button
                type="button"
                onClick={handleHeaderClick}
                className="flex items-center gap-1.5 px-2 py-1 rounded-lg text-[13.5px] font-semibold text-slate-800 hover:bg-slate-100 transition-colors select-none"
                title={mode === "day" ? "Switch to month view" : "Switch to year view"}
              >
                {headerLabel}
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="w-3 h-3 text-slate-400">
                  <path d="M6 9l6 6 6-6"/>
                </svg>
              </button>
            ) : (
              <span className="text-[13px] font-semibold text-slate-500 select-none px-2">
                {headerLabel}
              </span>
            )}

            <NavArrow dir="right" onClick={handleNext} label={mode === "day" ? "Next month" : mode === "month" ? "Next year" : "Next 12 years"} />
          </div>

          {/* ══════════════════════════════
              DAY VIEW — month calendar grid
          ══════════════════════════════ */}
          {mode === "day" && (
            <>
              {/* Weekday labels */}
              <div className="grid grid-cols-7 mb-1">
                {CAL_DAYS.map(d => (
                  <div key={d} className="h-7 flex items-center justify-center text-[11px] font-semibold text-slate-400 select-none">
                    {d}
                  </div>
                ))}
              </div>

              {/* Day cells */}
              <div className="grid grid-cols-7 gap-y-0.5">
                {dayCells.map((day, idx) =>
                  day === null ? (
                    <div key={idx} className="h-8" />
                  ) : (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => selectDay(day)}
                      className={`h-8 w-8 mx-auto flex items-center justify-center rounded-lg text-[13px] transition-colors select-none ${
                        isSelectedDay(day)
                          ? "bg-slate-900 text-white font-semibold shadow-sm"
                          : isTodayDay(day)
                          ? "bg-amber-50 text-amber-700 font-semibold ring-1 ring-amber-300"
                          : "text-slate-700 hover:bg-slate-100 font-medium"
                      }`}
                    >
                      {day}
                    </button>
                  ),
                )}
              </div>
            </>
          )}

          {/* ══════════════════════════════
              MONTH VIEW — 3×4 month grid
          ══════════════════════════════ */}
          {mode === "month" && (
            <div className="grid grid-cols-3 gap-1.5">
              {CAL_MONTHS_SHORT.map((name, idx) => (
                <button
                  key={name}
                  type="button"
                  onClick={() => selectMonth(idx)}
                  className={`py-2.5 rounded-lg text-[13px] font-semibold transition-colors select-none ${
                    isSelectedMonth(idx)
                      ? "bg-slate-900 text-white shadow-sm"
                      : isTodayMonth(idx)
                      ? "bg-amber-50 text-amber-700 ring-1 ring-amber-300"
                      : "text-slate-700 hover:bg-slate-100"
                  }`}
                >
                  {name}
                </button>
              ))}
            </div>
          )}

          {/* ══════════════════════════════
              YEAR VIEW — 4×3 year grid
          ══════════════════════════════ */}
          {mode === "year" && (
            <div className="grid grid-cols-3 gap-1.5">
              {yearCells.map(year => (
                <button
                  key={year}
                  type="button"
                  onClick={() => selectYear(year)}
                  className={`py-2.5 rounded-lg text-[13px] font-semibold transition-colors select-none ${
                    isSelectedYear(year)
                      ? "bg-slate-900 text-white shadow-sm"
                      : isTodayYear(year)
                      ? "bg-amber-50 text-amber-700 ring-1 ring-amber-300"
                      : "text-slate-700 hover:bg-slate-100"
                  }`}
                >
                  {year}
                </button>
              ))}
            </div>
          )}

          {/* ── Today shortcut (day view only) ─────────────── */}
          {mode === "day" && (
            <div className="mt-3 pt-3 border-t border-slate-100">
              <button
                type="button"
                onClick={selectToday}
                className="w-full py-1.5 text-[12.5px] font-semibold text-slate-500 hover:text-slate-800 hover:bg-slate-50 rounded-lg transition-colors"
              >
                Today
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Format YYYY-MM-DD for today (local time) ─────────────────
function todayISO(): string {
  const t = new Date();
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
}

// ── Empty form factory ───────────────────────────────────────
function emptyForm() {
  return {
    type:          "transfer" as ManualTxnType,
    txnDate:       todayISO(),
    fromAccountId: "",
    toAccountId:   "",
    amount:        "",   // string in the form, parsed on submit
    note:          "",
  };
}
// ── Currency formatter — ৳ X,XXX (whole taka only, thousand-grouped) ──
// Sub-taka amounts are stored at full precision (NUMERIC(12,2)) but
// displayed rounded — hotel cash flow doesn't deal in fractions of a taka.
const moneyFmt = new Intl.NumberFormat("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
function formatBdt(n: number): string {
  return `৳ ${moneyFmt.format(n)}`;
}

// ── Transaction direction by type ────────────────────────────
// in       — money landing in a bucket (no `from`, has `to`)
// out      — money leaving a bucket (has `from`, no `to`)
// neutral  — moves between two buckets (transfer)
// Stage 2 only creates 'transfer' and 'injection'; the other four
// are wired here in advance so later feature stages render correctly.
type TxnDirection = "in" | "out" | "neutral";
function txnDirection(type: string): TxnDirection {
  switch (type) {
    case "revenue_in":
    case "injection":
    case "loan_received":
      return "in";
    case "expense_out":
    case "loan_repayment":
      return "out";
    case "transfer":
    default:
      return "neutral";
  }
}

// ── Type → human label + badge classes ───────────────────────
const TXN_TYPE_META: Record<string, { label: string; badgeCls: string }> = {
  transfer:       { label: "Transfer",       badgeCls: "bg-slate-100 text-slate-700"   },
  injection:      { label: "Cash Injection", badgeCls: "bg-emerald-50 text-emerald-700" },
  revenue_in:     { label: "Revenue",        badgeCls: "bg-emerald-50 text-emerald-700" },
  expense_out:    { label: "Expense",        badgeCls: "bg-rose-50 text-rose-700"       },
  loan_received:  { label: "Loan Received",  badgeCls: "bg-sky-50 text-sky-700"         },
  loan_repayment: { label: "Loan Repayment", badgeCls: "bg-amber-50 text-amber-700"     },
};

// ── Parse YYYY-MM-DD as local time, format as long day header ──
function formatDayHeader(yyyyMmDd: string): string {
  // Parsing with "T12:00:00" avoids UTC-midnight-shifts-back-one-day.
  const d = new Date(`${yyyyMmDd}T12:00:00`);
  return d.toLocaleDateString("en-US", {
    weekday: "long",
    year:    "numeric",
    month:   "long",
    day:     "numeric",
  });
}

// ── Group transactions by txn_date, preserving newest-first order ──
function groupByDay(txns: AccountTransaction[]): [string, AccountTransaction[]][] {
  const map = new Map<string, AccountTransaction[]>();
  for (const t of txns) {
    const bucket = map.get(t.txnDate);
    if (bucket) bucket.push(t);
    else        map.set(t.txnDate, [t]);
  }
  return Array.from(map.entries());
}

type FormErrors = Partial<Record<"fromAccountId" | "toAccountId" | "amount" | "txnDate" | "form", string>>;

export default function CashbookClient() {
  // ── Data ───────────────────────────────────────────────────
  const [balances,     setBalances]     = useState<AccountBalance[]>([]);
  const [accounts,     setAccounts]     = useState<Account[]>([]);
  const [transactions, setTransactions] = useState<AccountTransaction[]>([]);

  // ── Load state ─────────────────────────────────────────────
  const [fetching,   setFetching]   = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // ── Modal + form state ─────────────────────────────────────
  const [modalOpen, setModalOpen] = useState(false);
  const [form,      setForm]      = useState(emptyForm);
  const [errors,    setErrors]    = useState<FormErrors>({});
  const [saving,    setSaving]    = useState(false);
  // editingId: null = create mode; UUID = edit mode for that transaction.
  const [editingId, setEditingId] = useState<string | null>(null);
  // deletingId: UUID of the transaction whose delete-confirm dialog is open;
  // null when no dialog is open.
  const [deletingId, setDeletingId] = useState<string | null>(null);
  // deleting: true while the delete API call is in flight (disables dialog buttons).
  const [deleting,   setDeleting]   = useState(false);

  // ── Success banner ─────────────────────────────────────────
  const [successMsg, setSuccessMsg] = useState("");

  // ── Day-close state ────────────────────────────────────────
  // dayCloseStatus: result of getDayCloseStatus() — last-closed date,
  // missed-days backlog, can-close-today flag, today's opening balance.
  // null until first load completes (or load failed).
  const [dayCloseStatus, setDayCloseStatus] = useState<DayCloseStatus | null>(null);
  // pastActivity: data for the oldest missed day (review screen). Loaded by
  // loadDayCloseStatus when missedDays.length > 0; null otherwise.
  const [pastActivity, setPastActivity] = useState<PastDayActivity | null>(null);
  // closingDay: true while closeDay() call is in flight (disables button).
  const [closingDay, setClosingDay] = useState(false);
  // closeDayError: error message from a failed close attempt (banner under the button).
  // null when no error to show.
  const [closeDayError, setCloseDayError] = useState<string | null>(null);

  // Helper: refresh dayCloseStatus, plus pastActivity when there's a backlog.
  // Errors are non-fatal — we leave the state null and the card skips itself.
  //
  // The two fetches are sequential because pastActivity depends on knowing
  // missedDays[0]. Doing them in parallel would require predicting the oldest
  // missed date, which we don't know without first fetching status.
  async function loadDayCloseStatus() {
    try {
      const status = await getDayCloseStatus();
      setDayCloseStatus(status);

      if (status.missedDays.length > 0) {
        // Catch-up mode: fetch the oldest missed day's review data.
        try {
          const activity = await getPastDayActivity(status.missedDays[0]);
          setPastActivity(activity);
        } catch {
          // Non-fatal: pastActivity stays null, card will skip itself in
          // catch-up mode rather than rendering with stale or partial data.
          setPastActivity(null);
        }
      } else {
        // No backlog → clear any stale catch-up data.
        setPastActivity(null);
      }
    } catch {
      setDayCloseStatus(null);
      setPastActivity(null);
    }
  }

  // ── Show-deleted toggle (audit/forensic view) ──
  // When true, getTransactions includes soft-deleted rows. They render
  // struck-through with inline deleted_at metadata. Default false.
  const [showDeleted, setShowDeleted] = useState(false);

  // ── Date range filter — defaults to today (focused daybook view) ──
  const [filterFromDate, setFilterFromDate] = useState<string>(todayISO);
  const [filterToDate,   setFilterToDate]   = useState<string>(todayISO);
  // Tracks the first mount so the filter effect can skip its initial
  // run (the initial-load Promise.all already used these defaults).
  const filterMountedRef = useRef(false);

  // ── Load on mount — three independent reads in parallel ────
  // Day-close status loads separately (non-fatal: if it fails, the card hides).
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [bal, accts, txns] = await Promise.all([
          getBalances(),
          getAccounts(),
          getTransactions({ fromDate: filterFromDate || undefined, toDate: filterToDate || undefined, includeDeleted: showDeleted }),
        ]);
        if (!cancelled) {
          setBalances(bal);
          setAccounts(accts);
          setTransactions(txns);
          // Fire-and-forget the day-close status load. Non-fatal: if it
          // fails the card just stays hidden.
          loadDayCloseStatus();
        }
      } catch (err) {
        if (!cancelled) {
          setFetchError(
            err instanceof Error ? err.message : "Failed to load accounts data.",
          );
        }
      } finally {
        if (!cancelled) setFetching(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  // ── Auto-clear success banner after 4s ─────────────────────
  useEffect(() => {
    if (!successMsg) return;
    const t = setTimeout(() => setSuccessMsg(""), 4000);
    return () => clearTimeout(t);
  }, [successMsg]);

  // ── Escape closes the modal (when not saving) ──────────────
  useEffect(() => {
    if (!modalOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !saving) closeModal();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [modalOpen, saving]);

  // ── Re-fetch transactions when the filter range changes ────
  // Skipped on the very first mount — the initial Promise.all already
  // fetched with these defaults. Subsequent changes always re-fetch.
  useEffect(() => {
    if (!filterMountedRef.current) {
      filterMountedRef.current = true;
      return;
    }
    let cancelled = false;
    async function refetch() {
      try {
        const txns = await getTransactions({
          fromDate:       filterFromDate || undefined,
          toDate:         filterToDate   || undefined,
          includeDeleted: showDeleted,
        });
        if (!cancelled) setTransactions(txns);
      } catch (err) {
        if (!cancelled) {
          setFetchError(
            err instanceof Error ? err.message : "Failed to load transactions.",
          );
        }
      }
    }
    refetch();
    return () => { cancelled = true; };
  }, [filterFromDate, filterToDate, showDeleted]);

  // ── Reload all — re-fetches transactions (with current filter) + balances ──
  // Used as the onRecorded callback for LoanEntryActions so that loan_received
  // and loan_repayment rows appear in the cashbook immediately after recording.
  async function reloadAll() {
    try {
      const [txns, bal] = await Promise.all([
        getTransactions({
          fromDate:       filterFromDate || undefined,
          toDate:         filterToDate   || undefined,
          includeDeleted: showDeleted,
        }),
        getBalances(),
      ]);
      setTransactions(txns);
      setBalances(bal);
    } catch {
      // Non-fatal: the transaction was already saved; the list will reconcile
      // on the next filter change or page reload.
    }
  }

  // ── Open / close ───────────────────────────────────────────
  function openModal() {
    setForm(emptyForm());
    setErrors({});
    setEditingId(null);
    setModalOpen(true);
  }
  function openEditModal(t: AccountTransaction) {
    // Pre-fill the form from the transaction. Cast is safe because the
    // Edit button is only rendered when t.type is 'transfer' or 'injection'.
    setForm({
      type:          t.type as ManualTxnType,
      txnDate:       t.txnDate,
      fromAccountId: t.fromAccountId ?? "",
      toAccountId:   t.toAccountId ?? "",
      amount:        String(t.amount),
      note:          t.note ?? "",
    });
    setErrors({});
    setEditingId(t.id);
    setModalOpen(true);
  }
  function closeModal() {
    if (saving) return;
    setModalOpen(false);
    setEditingId(null);
  }

  // ── Export CSV ────────────────────────────────────────────
  // Builds a CSV string from the current transactions state (whatever
  // the date-range filter is currently showing) and triggers a download
  // via a temporary Blob URL. No DB access; pure transform of state.
  function handleExportCsv() {
    if (transactions.length === 0) return;

    const csv = transactionsToCsv(transactions, accounts);

    // Filename includes today's date so successive exports don't
    // overwrite each other in the user's Downloads folder.
    const today = todayISO();
    const filename =
      (filterFromDate || filterToDate)
        ? `accounts-${filterFromDate || "start"}-to-${filterToDate || "today"}.csv`
        : `accounts-all-${today}.csv`;

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url  = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href      = url;
    a.download  = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ── Delete flow ──────────────────────────────────────────
  function openDeleteDialog(id: string) {
    setDeletingId(id);
  }
  function cancelDelete() {
    if (deleting) return;
    setDeletingId(null);
  }
  async function confirmDelete() {
    if (!deletingId) return;
    setDeleting(true);
    try {
      await deleteTransaction(deletingId);
      // Remove the row from local state by id.
      setTransactions(prev => prev.filter(t => t.id !== deletingId));

      // Refresh balances — the deleted row was contributing to them.
      try {
        const bal = await getBalances();
        setBalances(bal);
      } catch {
        // A balance refresh failure shouldn't block the success path —
        // the transaction was deleted. The cards will reconcile on next load.
      }

      setSuccessMsg("Transaction deleted.");
      setDeletingId(null);
    } catch (err) {
      // Surface the failure as a top-of-page error banner via fetchError.
      setFetchError(err instanceof Error ? err.message : "Failed to delete transaction.");
      setDeletingId(null);
    } finally {
      setDeleting(false);
    }
  }

  // ── Field setters ──────────────────────────────────────────
  function setField<K extends keyof ReturnType<typeof emptyForm>>(
    key: K,
    value: ReturnType<typeof emptyForm>[K],
  ) {
    setForm(f => ({ ...f, [key]: value }));
    if (errors[key as keyof FormErrors]) {
      setErrors(e => ({ ...e, [key]: undefined }));
    }
  }

  // Switching type clears the from-bucket if moving to injection
  // (injection must NOT have a from), and clears related errors.
  function setType(next: ManualTxnType) {
    setForm(f => ({
      ...f,
      type:          next,
      fromAccountId: next === "injection" ? "" : f.fromAccountId,
    }));
    setErrors(e => ({ ...e, fromAccountId: undefined, toAccountId: undefined, form: undefined }));
  }

  // ── Submit ─────────────────────────────────────────────────
  async function handleSubmit() {
    // Client-side validation mirrors createTransaction()'s checks.
    const next: FormErrors = {};

    if (!form.txnDate) next.txnDate = "Pick a date.";

    const amountNum = Number(form.amount);
    if (!form.amount.trim() || !Number.isFinite(amountNum) || amountNum <= 0) {
      next.amount = "Enter a positive amount.";
    }

    if (form.type === "transfer") {
      if (!form.fromAccountId) next.fromAccountId = "Choose a source bucket.";
      if (!form.toAccountId)   next.toAccountId   = "Choose a destination bucket.";
      if (form.fromAccountId && form.toAccountId && form.fromAccountId === form.toAccountId) {
        next.toAccountId = "Source and destination must be different.";
      }
    } else {
      // injection
      if (!form.toAccountId) next.toAccountId = "Choose a destination bucket.";
    }

    if (Object.keys(next).length > 0) {
      setErrors(next);
      return;
    }

    setErrors({});
    setSaving(true);
    try {
      const input = {
        type:          form.type,
        txnDate:       form.txnDate,
        amount:        amountNum,
        fromAccountId: form.type === "injection" ? null : form.fromAccountId,
        toAccountId:   form.toAccountId,
        note:          form.note.trim() ? form.note.trim() : null,
      };

      if (editingId === null) {
        // ── CREATE mode ──
        const saved = await createTransaction(input);
        // Prepend (newest first, matches getTransactions order).
        setTransactions(prev => [saved, ...prev]);
        setSuccessMsg(form.type === "transfer" ? "Transfer recorded." : "Cash injection recorded.");
      } else {
        // ── EDIT mode ──
        const saved = await updateTransaction(editingId, input);
        // Replace the row in place — preserves position in the list.
        setTransactions(prev => prev.map(t => t.id === saved.id ? saved : t));
        setSuccessMsg("Transaction updated.");
      }

      // Refresh balances regardless of mode (an edit may shift any bucket).
      try {
        const bal = await getBalances();
        setBalances(bal);
      } catch {
        // A balance refresh failure shouldn't block the success path —
        // the transaction was saved. The cards will reconcile on next load.
      }

      setModalOpen(false);
      setEditingId(null);
    } catch (err) {
      setErrors({ form: err instanceof Error ? err.message : "Failed to save transaction." });
    } finally {
      setSaving(false);
    }
  }

  // ── Loading state ──────────────────────────────────────────
  if (fetching) {
    return (
      <div className="p-8">
        <p className="text-sm text-slate-400">Loading accounts…</p>
      </div>
    );
  }

  // ── Error state ────────────────────────────────────────────
  if (fetchError) {
    return (
      <div className="p-8">
        <div className="flex items-center gap-3 bg-rose-50 border border-rose-200 rounded-xl px-5 py-3.5">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-5 h-5 text-rose-600 flex-shrink-0">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 8v4" />
            <path d="M12 16h.01" />
          </svg>
          <p className="text-[13px] font-medium text-rose-800">{fetchError}</p>
        </div>
      </div>
    );
  }

  // ── Loaded ─────────────────────────────────────────────────
  return (
    <div className="p-8 space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-slate-800">Accounts</h1>
        <div className="flex items-center gap-2">
          <LoanEntryActions onRecorded={reloadAll} />
          <button
            type="button"
            onClick={handleExportCsv}
            disabled={transactions.length === 0}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-white border border-slate-200 text-slate-700 text-[13px] font-semibold hover:bg-slate-50 hover:border-slate-300 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            title={transactions.length === 0 ? "No transactions to export" : "Download current view as CSV"}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
              <path d="M7 10l5 5 5-5" />
              <path d="M12 15V3" />
            </svg>
            Export CSV
          </button>
          <button
            type="button"
            onClick={openModal}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-900 text-white text-[13px] font-semibold hover:bg-slate-800 transition-colors"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" className="w-4 h-4">
              <path d="M12 5v14M5 12h14" />
            </svg>
            Add Transaction
          </button>
        </div>
      </div>

      {/* ── Close Day card ──────────────────────────────────── */}
      {dayCloseStatus && (() => {
        const today = todayISO();
        const hasBacklog = dayCloseStatus.missedDays.length > 0;
        const alreadyClosedToday = !hasBacklog && dayCloseStatus.lastClosedDate === today;
        const cashId = ACCOUNT_IDS.cash;

        // Mode discriminator. catchup > closed > today (priority for rendering).
        // catchup: backlog exists, render the oldest missed day's review.
        // closed:  no backlog AND today already closed, show the pill.
        // today:   no backlog AND today not yet closed, render today's preview.
        type CardMode = "catchup" | "closed" | "today";
        const mode: CardMode =
          hasBacklog          ? "catchup" :
          alreadyClosedToday  ? "closed"  :
          "today";

        // In catchup mode we render from pastActivity. If it hasn't loaded yet,
        // skip rendering rather than showing partial/stale data.
        if (mode === "catchup" && !pastActivity) return null;

        // ── Derive per-mode data ──────────────────────────────
        // For "today" mode: pull from the already-loaded transactions state.
        // For "catchup" mode: use pastActivity (a separate service fetch).
        // For "closed" mode: show today's opening, no activity list.
        type DerivedRow = { id: string; note: string | null; type: string; amount: number; sign: "+" | "−"; color: string };

        let displayDate:        string;
        let opening:            number;
        let closingShown:       number;
        let displayRows:        DerivedRow[];
        let isClosing:          boolean;

        if (mode === "catchup") {
          const pa = pastActivity!;
          displayDate  = pa.closeDate;
          opening      = pa.opening;
          closingShown = pa.closingPreview;
          displayRows  = pa.transactions.map((t) => ({
            id:     t.id,
            note:   t.note,
            type:   t.type,
            amount: t.amount,
            sign:   t.toAccountId === cashId ? "+" : "−",
            color:  t.toAccountId === cashId ? "text-emerald-700" : "text-rose-700",
          }));
          isClosing = closingDay;
        } else if (mode === "today") {
          displayDate = today;
          opening     = dayCloseStatus.todaysOpeningBalance;
          // Filter out soft-deleted rows independent of the showDeleted toggle.
          // The card's closing-balance preview must reflect live money only —
          // deleted rows don't contribute to the actual close. Without this
          // filter, toggling "Show Deleted" would inflate the preview.
          const todaysCashTxns = transactions.filter(
            (t) => t.txnDate === today
              && t.deletedAt === null
              && (t.fromAccountId === cashId || t.toAccountId === cashId),
          );
          const netDelta = todaysCashTxns.reduce((acc, t) => {
            if (t.toAccountId   === cashId) return acc + t.amount;
            if (t.fromAccountId === cashId) return acc - t.amount;
            return acc;
          }, 0);
          closingShown = +(opening + netDelta).toFixed(2);
          displayRows = todaysCashTxns.map((t) => ({
            id:     t.id,
            note:   t.note,
            type:   t.type,
            amount: t.amount,
            sign:   t.toAccountId === cashId ? "+" : "−",
            color:  t.toAccountId === cashId ? "text-emerald-700" : "text-rose-700",
          }));
          isClosing = closingDay;
        } else {
          // closed
          displayDate  = today;
          opening      = dayCloseStatus.todaysOpeningBalance;
          closingShown = dayCloseStatus.todaysOpeningBalance;
          displayRows  = [];
          isClosing    = false;
        }

        // ── Handlers ─────────────────────────────────────────
        async function handleClose() {
          setCloseDayError(null);
          setClosingDay(true);
          try {
            const result = mode === "catchup"
              ? await closePastDay(displayDate)
              : await closeDay(today);
            if (result.ok) {
              setSuccessMsg(`Day ${displayDate} closed at ${formatBdt(result.row.closingBalance)}.`);
              await loadDayCloseStatus();
            } else {
              setCloseDayError(result.message);
            }
          } catch (err) {
            setCloseDayError(err instanceof Error ? err.message : "Close failed.");
          } finally {
            setClosingDay(false);
          }
        }

        // ── Styling, label, copy ─────────────────────────────
        // catchup gets amber accent on border + header background. today/closed
        // stays neutral slate.
        const cardCls = mode === "catchup"
          ? "bg-white border border-amber-300 rounded-xl p-5 space-y-4"
          : "bg-white border border-slate-200 rounded-xl p-5 space-y-4";

        const headerLabel = mode === "catchup"
          ? `Day Close — Catch up (${displayDate})`
          : `Day Close — Today (${displayDate})`;

        const buttonLabel = isClosing
          ? "Closing..."
          : mode === "catchup"
            ? `Catch up: close ${displayDate}`
            : "Close Today";

        const activityLabel = mode === "catchup"
          ? `Cash in Hand activity on ${displayDate}:`
          : "Today's Cash in Hand activity:";

        const emptyActivityLabel = mode === "catchup"
          ? `No Cash in Hand activity on ${displayDate}.`
          : "No Cash in Hand activity today.";

        // Backlog count pill — shown in catchup header only.
        const backlogCount = dayCloseStatus.missedDays.length;

        return (
          <div className={cardCls}>
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-[15px] font-semibold text-slate-800">
                  {headerLabel}
                </h2>
                {mode === "catchup" && (
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-amber-100 border border-amber-200 text-[11px] font-semibold text-amber-800 uppercase tracking-wide">
                    {backlogCount} day{backlogCount === 1 ? "" : "s"} behind
                  </span>
                )}
              </div>
              {mode === "closed" && (
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-50 border border-emerald-200 text-[12px] font-medium text-emerald-700 flex-shrink-0">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
                    <path d="M20 6L9 17l-5-5" />
                  </svg>
                  Closed
                </span>
              )}
            </div>

            {mode === "catchup" && backlogCount >= 3 && (
              <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-[12.5px] text-amber-800">
                All missed days: {dayCloseStatus.missedDays.join(", ")}. Close oldest-first; today becomes closable after backlog clears.
              </div>
            )}

            <div className="flex items-center justify-between text-[13.5px]">
              <span className="text-slate-600">Opening balance</span>
              <span className="font-medium text-slate-800 tabular-nums">{formatBdt(opening)}</span>
            </div>

            <div className="space-y-1.5">
              <div className="text-[13px] text-slate-600">{activityLabel}</div>
              {displayRows.length === 0 ? (
                <div className="text-[13px] text-slate-400 italic pl-3">{emptyActivityLabel}</div>
              ) : (
                <ul className="space-y-1 pl-3">
                  {displayRows.map((r) => (
                    <li key={r.id} className="flex items-center justify-between text-[13px]">
                      <span className="text-slate-700 truncate pr-3">{r.note || r.type}</span>
                      <span className={`font-medium tabular-nums ${r.color}`}>{r.sign}{formatBdt(r.amount)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="flex items-center justify-between text-[13.5px] pt-3 border-t border-slate-100">
              <span className="text-slate-600 font-medium">
                Closing balance{mode === "closed" ? "" : " (preview)"}
              </span>
              <span className="font-semibold text-slate-900 tabular-nums">{formatBdt(closingShown)}</span>
            </div>

            {mode !== "closed" && (
              <div className="pt-2">
                <button
                  type="button"
                  onClick={handleClose}
                  disabled={isClosing}
                  className={
                    mode === "catchup"
                      ? "w-full px-4 py-2.5 rounded-lg bg-amber-600 text-white text-[13px] font-semibold hover:bg-amber-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                      : "w-full px-4 py-2.5 rounded-lg bg-slate-900 text-white text-[13px] font-semibold hover:bg-slate-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  }
                  title={isClosing ? "Closing..." : buttonLabel}
                >
                  {buttonLabel}
                </button>
                {closeDayError && (
                  <div className="mt-2 text-[12.5px] text-rose-700 bg-rose-50 border border-rose-200 rounded-md px-3 py-2">
                    {closeDayError}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })()}

      {/* ── Success banner ──────────────────────────────────── */}
      {successMsg && (
        <div className="flex items-center gap-3 bg-emerald-50 border border-emerald-200 rounded-xl px-5 py-3.5">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-5 h-5 text-emerald-600 flex-shrink-0">
            <path d="M22 11.08V12a10 10 0 11-5.93-9.14" />
            <path d="M22 4L12 14.01l-3-3" />
          </svg>
          <p className="text-[13px] font-medium text-emerald-800">{successMsg}</p>
        </div>
      )}

      {/* ── Balance cards — Cash in Hand first, then alphabetical ────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[...balances]
          .sort((a, b) => {
            if (a.isSpendable && !b.isSpendable) return -1;
            if (!a.isSpendable && b.isSpendable) return 1;
            return a.name.localeCompare(b.name);
          })
          .map(b => {
            const negative = b.balance < 0;
            return (
              <div
                key={b.accountId}
                className="rounded-xl border border-slate-200 bg-white p-5"
              >
                <div className="flex items-center justify-between">
                  <p className="text-[12px] font-semibold text-slate-500 uppercase tracking-wider">
                    {b.name}
                  </p>
                  {b.isSpendable && (
                    <span className="text-[10px] font-semibold text-amber-700 bg-amber-50 px-2 py-0.5 rounded-full uppercase tracking-wider">
                      Spendable
                    </span>
                  )}
                </div>
                <p className={`mt-2 text-[22px] font-semibold tabular-nums ${
                  negative ? "text-rose-600" : "text-slate-800"
                }`}>
                  {formatBdt(b.balance)}
                </p>
              </div>
            );
          })}
      </div>

      {/* ══════════════════════════════════════════════════════
          TRANSACTIONS — grouped by day, newest first
          The section header (title + filter pickers) renders
          unconditionally; only the body below switches between
          empty-state and the grouped list. This keeps the filter
          UI reachable even when the current range has no rows.
      ══════════════════════════════════════════════════════ */}
      {(() => {
        // UUID -> bucket name. accounts is always 4 items.
        const bucketName: Record<string, string> = {};
        for (const a of accounts) bucketName[a.id] = a.name;

        const hasFilter = !!(filterFromDate || filterToDate);

        return (
          <div className="space-y-5">

            {/* ── Section header: title + date range filter ─────── */}
            <div className="flex items-end justify-between gap-4 flex-wrap">
              <p className="text-[12px] font-semibold text-slate-500 uppercase tracking-wider">
                Transactions
              </p>
              <div className="flex items-end gap-3 flex-wrap">
                <div className="w-[200px]">
                  <label className="block text-[10.5px] font-semibold text-slate-500 uppercase tracking-wider mb-1.5">From</label>
                  <DatePickerField value={filterFromDate} onChange={setFilterFromDate} />
                </div>
                <div className="w-[200px]">
                  <label className="block text-[10.5px] font-semibold text-slate-500 uppercase tracking-wider mb-1.5">To</label>
                  <DatePickerField value={filterToDate} onChange={setFilterToDate} />
                </div>
                {hasFilter && (
                  <button
                    type="button"
                    onClick={() => { setFilterFromDate(""); setFilterToDate(""); }}
                    className="h-[42px] px-3 text-[12.5px] font-semibold text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded-lg transition-colors"
                  >
                    Clear
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setShowDeleted(v => !v)}
                  className={`h-[42px] px-3 text-[12.5px] font-semibold rounded-lg transition-colors ${
                    showDeleted
                      ? "bg-rose-50 text-rose-600 hover:bg-rose-100"
                      : "text-slate-500 hover:text-slate-800 hover:bg-slate-100"
                  }`}
                  title={showDeleted ? "Hide deleted transactions" : "Show deleted transactions"}
                >
                  {showDeleted ? "Hide Deleted" : "Show Deleted"}
                </button>
              </div>
            </div>

            {/* ── Body: empty-state card OR day-grouped list ─────── */}
            {transactions.length === 0 ? (
              <div className="rounded-xl border border-dashed border-slate-200 bg-white px-6 py-10 flex flex-col items-center justify-center text-center">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="w-7 h-7 text-slate-300 mb-2">
                  <path d="M3 7h18" />
                  <path d="M3 12h18" />
                  <path d="M3 17h12" />
                </svg>
                <p className="text-[13.5px] font-medium text-slate-500">
                  {hasFilter ? "No transactions in this date range." : "No transactions yet."}
                </p>
                <p className="text-[12px] text-slate-400 mt-1">
                  {hasFilter ? "Widen the filter or clear it to see other days." : "Add a transfer or cash injection to get started."}
                </p>
              </div>
            ) : (
              groupByDay(transactions).map(([day, dayTxns]) => (
                <div key={day} className="space-y-2">
                  <p className="text-[12.5px] font-semibold text-slate-700">
                    {formatDayHeader(day)}
                  </p>

                  <div className="rounded-xl border border-slate-200 bg-white divide-y divide-slate-100 overflow-hidden">
                    {dayTxns.map(t => {
                      const meta = TXN_TYPE_META[t.type] ?? { label: t.type, badgeCls: "bg-slate-100 text-slate-700" };
                      const dir  = txnDirection(t.type);

                      const fromName = t.fromAccountId ? (bucketName[t.fromAccountId] ?? "Unknown") : null;
                      const toName   = t.toAccountId   ? (bucketName[t.toAccountId]   ?? "Unknown") : null;

                      // Direction arrow text per type:
                      //   transfer   →  "Cash in Hand → Bank"
                      //   in         →  "→ Bank"
                      //   out        →  "Cash in Hand →"
                      const flow =
                        dir === "neutral" && fromName && toName ? `${fromName} → ${toName}` :
                        dir === "in"      && toName             ? `→ ${toName}`             :
                        dir === "out"     && fromName           ? `${fromName} →`           :
                        "";

                      const amountSign  = dir === "in" ? "+ " : dir === "out" ? "− " : "";
                      const amountCls   = dir === "in" ? "text-emerald-700" : dir === "out" ? "text-rose-700" : "text-slate-700";

                      // A row is "manual" (editable from the daybook) iff it has no
                      // booking_payment_id AND its type is one of the two manual types.
                      // Both guards: bookingPaymentId guards against auto-rows once the
                      // integration ships; type guards against future feature stages
                      // (expense, payroll, etc.) that won't be editable here either.
                      const isManual =
                        t.bookingPaymentId === null &&
                        (t.type === "transfer" || t.type === "injection");

                      // A row sits on a closed day iff dayCloseStatus is loaded AND
                      // the row's txn_date is on or before the latest closed date.
                      // String compare works because YYYY-MM-DD is lexicographically
                      // chronological. Closed-day rows can't be edited or deleted —
                      // the DB-level immutability trigger rejects any UPDATE/DELETE
                      // touching them. UI mirrors that by disabling the buttons.
                      const isClosedDay =
                        dayCloseStatus !== null &&
                        t.txnDate <= dayCloseStatus.lastClosedDate;

                      const isDeleted = t.deletedAt !== null;

                      return (
                        <div key={t.id} className={`px-5 py-3.5 flex items-start gap-4 ${isDeleted ? "opacity-50 bg-rose-50/40" : ""}`}>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className={`text-[10.5px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full ${meta.badgeCls}`}>
                                {meta.label}
                              </span>
                              {isDeleted && (
                                <span className="text-[10.5px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full bg-rose-100 text-rose-600"
                                  title={`Deleted ${new Date(t.deletedAt!).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })}`}
                                >
                                  Deleted
                                </span>
                              )}
                              <p className="text-[13px] font-medium text-slate-700">{flow}</p>
                            </div>
                            {(t.type === "loan_received" || t.type === "loan_repayment") && t.lenderName && (
                              <p className={`mt-1 text-[12.5px] text-slate-500 break-words ${isDeleted ? "line-through decoration-slate-400" : ""}`}>{t.lenderName}</p>
                            )}
                            {t.note && (
                              <p className={`mt-1 text-[12.5px] text-slate-500 break-words ${isDeleted ? "line-through decoration-slate-400" : ""}`}>{t.note}</p>
                            )}
                            {isDeleted && (
                              <p className="mt-1 text-[11.5px] text-rose-600/90 italic">
                                Deleted by {t.deletedBy ? "Admin" : "—"}{" "}
                                {t.deletedAt && (
                                  <>
                                    on {new Date(t.deletedAt).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })}
                                  </>
                                )}
                              </p>
                            )}
                          </div>

                          {isManual && !isDeleted && t.editedAt && (
                            <span
                              className="inline-flex items-center text-slate-400 flex-shrink-0"
                              title={`Edited ${new Date(t.editedAt).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })}`}
                              aria-label="This transaction has been edited"
                            >
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
                                <circle cx="12" cy="12" r="9" />
                                <path d="M12 7v5l3 2" />
                              </svg>
                            </span>
                          )}

                          {isManual && !isDeleted && (
                            <>
                              <button
                                type="button"
                                onClick={() => openEditModal(t)}
                                disabled={isClosedDay}
                                aria-label="Edit transaction"
                                title={isClosedDay ? "This day is closed — edit not allowed" : "Edit"}
                                className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors flex-shrink-0 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-slate-400"
                              >
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
                                  <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                                  <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
                                </svg>
                              </button>
                              <button
                                type="button"
                                onClick={() => openDeleteDialog(t.id)}
                                disabled={isClosedDay}
                                aria-label="Delete transaction"
                                title={isClosedDay ? "This day is closed — delete not allowed" : "Delete"}
                                className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition-colors flex-shrink-0 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-slate-400"
                              >
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
                                  <path d="M3 6h18" />
                                  <path d="M19 6l-2 14a2 2 0 01-2 2H9a2 2 0 01-2-2L5 6" />
                                  <path d="M10 11v6" />
                                  <path d="M14 11v6" />
                                  <path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2" />
                                </svg>
                              </button>
                            </>
                          )}

                          <p className={`text-[14px] font-semibold tabular-nums whitespace-nowrap ${amountCls} ${isDeleted ? "line-through decoration-current" : ""}`}>
                            {amountSign}{formatBdt(t.amount)}
                          </p>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))
            )}
          </div>
        );
      })()}

      {/* ══════════════════════════════════════════════════════
          DELETE CONFIRM DIALOG
      ══════════════════════════════════════════════════════ */}
      {deletingId && (() => {
        const t = transactions.find(x => x.id === deletingId);
        if (!t) return null;

        // Re-derive flow text and amount for the confirmation summary.
        const bucketName: Record<string, string> = {};
        for (const a of accounts) bucketName[a.id] = a.name;
        const meta     = TXN_TYPE_META[t.type] ?? { label: t.type, badgeCls: "" };
        const dir      = txnDirection(t.type);
        const fromName = t.fromAccountId ? (bucketName[t.fromAccountId] ?? "Unknown") : null;
        const toName   = t.toAccountId   ? (bucketName[t.toAccountId]   ?? "Unknown") : null;
        const flow =
          dir === "neutral" && fromName && toName ? `${fromName} → ${toName}` :
          dir === "in"      && toName             ? `→ ${toName}`             :
          dir === "out"     && fromName           ? `${fromName} →`           :
          "";

        return (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm"
            onClick={e => { if (e.target === e.currentTarget) cancelDelete(); }}
          >
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md flex flex-col">

              {/* Body */}
              <div className="px-6 py-5">
                <div className="flex items-start gap-3">
                  <div className="w-9 h-9 rounded-lg bg-rose-50 flex items-center justify-center flex-shrink-0">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-4.5 h-4.5 text-rose-600">
                      <circle cx="12" cy="12" r="10" />
                      <path d="M12 8v4" />
                      <path d="M12 16h.01" />
                    </svg>
                  </div>
                  <div className="flex-1 min-w-0">
                    <h2 className="text-[15px] font-semibold text-slate-800 leading-tight">
                      Delete this transaction?
                    </h2>
                    <p className="text-[12px] text-slate-500 mt-1">This action cannot be undone.</p>
                  </div>
                </div>

                {/* Row summary */}
                <div className="mt-4 px-4 py-3 rounded-lg bg-slate-50 border border-slate-200">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`text-[10.5px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full ${meta.badgeCls}`}>
                      {meta.label}
                    </span>
                    <p className="text-[13px] font-medium text-slate-700">{flow}</p>
                    <p className="text-[13px] font-semibold text-slate-800 tabular-nums ml-auto">
                      {formatBdt(t.amount)}
                    </p>
                  </div>
                  <p className="text-[11.5px] text-slate-500 mt-1.5">{formatDayHeader(t.txnDate)}</p>
                  {(t.type === "loan_received" || t.type === "loan_repayment") && t.lenderName && (
                    <p className="text-[12px] text-slate-600 mt-1.5 italic break-words">{t.lenderName}</p>
                  )}
                  {t.note && (
                    <p className="text-[12px] text-slate-600 mt-1.5 italic break-words">{t.note}</p>
                  )}
                </div>
              </div>

              {/* Footer */}
              <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-slate-200 bg-slate-50 rounded-b-2xl">
                <button
                  type="button"
                  onClick={cancelDelete}
                  disabled={deleting}
                  className="px-4 py-2 rounded-lg text-[13px] font-semibold text-slate-600 hover:bg-slate-200 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={confirmDelete}
                  disabled={deleting}
                  className="px-4 py-2 rounded-lg bg-rose-600 text-white text-[13px] font-semibold hover:bg-rose-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {deleting ? "Deleting…" : "Delete"}
                </button>
              </div>

            </div>
          </div>
        );
      })()}

      {/* ══════════════════════════════════════════════════════
          MODAL — manual transaction entry
      ══════════════════════════════════════════════════════ */}
      {modalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm"
          onClick={e => { if (e.target === e.currentTarget) closeModal(); }}
        >
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-xl flex flex-col max-h-[90vh]">

            {/* ── Modal header ──────────────────────────────── */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 bg-slate-50 flex-shrink-0 rounded-t-2xl">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-slate-800 flex items-center justify-center flex-shrink-0">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-4 h-4 text-white">
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                </div>
                <div>
                  <h2 className="text-[15px] font-semibold text-slate-800 leading-none">
                    {editingId === null ? "Add Transaction" : "Edit Transaction"}
                  </h2>
                  <p className="text-[11.5px] text-slate-400 mt-0.5">Manual daybook entry — transfer or cash injection</p>
                </div>
              </div>
              <button
                type="button"
                onClick={closeModal}
                disabled={saving}
                aria-label="Close"
                className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-200 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-4 h-4">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* ── Modal body (scrollable) ──────────────────── */}
            <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">

              {/* Form-level error (server failure) */}
              {errors.form && (
                <div className="flex items-start gap-3 bg-rose-50 border border-rose-200 rounded-lg px-4 py-3">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-4 h-4 text-rose-600 flex-shrink-0 mt-0.5">
                    <circle cx="12" cy="12" r="10" />
                    <path d="M12 8v4" />
                    <path d="M12 16h.01" />
                  </svg>
                  <p className="text-[12.5px] font-medium text-rose-800">{errors.form}</p>
                </div>
              )}

              {/* ── Type toggle ──────────────────────────── */}
              <div>
                <label className="block text-[11.5px] font-semibold text-slate-500 uppercase tracking-wider mb-1.5">Type</label>
                <div className="grid grid-cols-2 gap-2">
                  {(["transfer", "injection"] as ManualTxnType[]).map(t => {
                    const active = form.type === t;
                    return (
                      <button
                        key={t}
                        type="button"
                        onClick={() => setType(t)}
                        className={`px-4 py-2.5 rounded-lg text-[13px] font-semibold transition-colors select-none ${
                          active
                            ? "bg-slate-900 text-white shadow-sm"
                            : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                        }`}
                      >
                        {t === "transfer" ? "Transfer" : "Cash Injection"}
                      </button>
                    );
                  })}
                </div>
                <p className="text-[11.5px] text-slate-400 mt-1.5">
                  {form.type === "transfer"
                    ? "Move money from one bucket to another."
                    : "Owner adds money into a bucket from outside."}
                </p>
              </div>

              {/* ── Date ─────────────────────────────────── */}
              <div>
                <label className="block text-[11.5px] font-semibold text-slate-500 uppercase tracking-wider mb-1.5">
                  Date <span className="text-rose-400">*</span>
                </label>
                <DatePickerField value={form.txnDate} onChange={v => setField("txnDate", v)} />
                {errors.txnDate && <p className="mt-1 text-[11.5px] text-rose-600">{errors.txnDate}</p>}
              </div>

              {/* ── From bucket (transfer only) ──────────── */}
              {form.type === "transfer" && (
                <div>
                  <label className="block text-[11.5px] font-semibold text-slate-500 uppercase tracking-wider mb-1.5">
                    From <span className="text-rose-400">*</span>
                  </label>
                  <select
                    value={form.fromAccountId}
                    onChange={e => setField("fromAccountId", e.target.value)}
                    className={inputCls(!!errors.fromAccountId)}
                  >
                    <option value="">— Select source bucket —</option>
                    {accounts.map(a => (
                      <option key={a.id} value={a.id}>{a.name}</option>
                    ))}
                  </select>
                  {errors.fromAccountId && <p className="mt-1 text-[11.5px] text-rose-600">{errors.fromAccountId}</p>}
                </div>
              )}

              {/* ── To bucket ────────────────────────────── */}
              <div>
                <label className="block text-[11.5px] font-semibold text-slate-500 uppercase tracking-wider mb-1.5">
                  To <span className="text-rose-400">*</span>
                </label>
                <select
                  value={form.toAccountId}
                  onChange={e => setField("toAccountId", e.target.value)}
                  className={inputCls(!!errors.toAccountId)}
                >
                  <option value="">— Select destination bucket —</option>
                  {accounts.map(a => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
                {errors.toAccountId && <p className="mt-1 text-[11.5px] text-rose-600">{errors.toAccountId}</p>}
              </div>

              {/* ── Amount (BDT) ─────────────────────────── */}
              <div>
                <label className="block text-[11.5px] font-semibold text-slate-500 uppercase tracking-wider mb-1.5">
                  Amount <span className="text-rose-400">*</span>
                </label>
                <div className={`flex items-stretch border rounded-lg overflow-hidden bg-white transition focus-within:ring-2 focus-within:ring-amber-400 focus-within:border-transparent ${
                  errors.amount ? "border-rose-300 bg-rose-50" : "border-slate-200"
                }`}>
                  <span className="flex items-center justify-center px-3 bg-slate-50 text-slate-500 text-[14px] font-semibold border-r border-slate-200 select-none">৳</span>
                  <input
                    type="number"
                    inputMode="decimal"
                    step="0.01"
                    min="0"
                    value={form.amount}
                    onChange={e => setField("amount", e.target.value)}
                    placeholder="0.00"
                    className="flex-1 px-3.5 py-2.5 text-[13.5px] text-slate-800 bg-transparent placeholder:text-slate-300 focus:outline-none"
                  />
                </div>
                {errors.amount && <p className="mt-1 text-[11.5px] text-rose-600">{errors.amount}</p>}
              </div>

              {/* ── Note ─────────────────────────────────── */}
              <div>
                <label className="block text-[11.5px] font-semibold text-slate-500 uppercase tracking-wider mb-1.5">Note</label>
                <textarea
                  rows={2}
                  value={form.note}
                  onChange={e => setField("note", e.target.value)}
                  placeholder="Optional — what this transaction is for"
                  className={inputCls(false) + " resize-none"}
                />
              </div>
            </div>

            {/* ── Modal footer ──────────────────────────────── */}
            <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-slate-200 bg-slate-50 flex-shrink-0 rounded-b-2xl">
              <button
                type="button"
                onClick={closeModal}
                disabled={saving}
                className="px-4 py-2 rounded-lg text-[13px] font-semibold text-slate-600 hover:bg-slate-200 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSubmit}
                disabled={saving}
                className="px-4 py-2 rounded-lg bg-slate-900 text-white text-[13px] font-semibold hover:bg-slate-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {saving
                  ? (editingId === null ? "Saving…" : "Updating…")
                  : (editingId === null ? "Save Transaction" : "Update Transaction")}
              </button>
            </div>

          </div>
        </div>
      )}
    </div>
  );
}

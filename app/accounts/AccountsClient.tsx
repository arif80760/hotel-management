"use client";

// app/accounts/AccountsClient.tsx
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
  type AccountBalance,
  type Account,
  type AccountTransaction,
  type ManualTxnType,
} from "@/services/accountsService";

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
type FormErrors = Partial<Record<"fromAccountId" | "toAccountId" | "amount" | "txnDate" | "form", string>>;

export default function AccountsClient() {
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

  // ── Success banner ─────────────────────────────────────────
  const [successMsg, setSuccessMsg] = useState("");

  // ── Load on mount — three independent reads in parallel ────
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [bal, accts, txns] = await Promise.all([
          getBalances(),
          getAccounts(),
          getTransactions(),
        ]);
        if (!cancelled) {
          setBalances(bal);
          setAccounts(accts);
          setTransactions(txns);
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

  // ── Open / close ───────────────────────────────────────────
  function openModal() {
    setForm(emptyForm());
    setErrors({});
    setModalOpen(true);
  }
  function closeModal() {
    if (saving) return;
    setModalOpen(false);
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
      const saved = await createTransaction({
        type:          form.type,
        txnDate:       form.txnDate,
        amount:        amountNum,
        fromAccountId: form.type === "injection" ? null : form.fromAccountId,
        toAccountId:   form.toAccountId,
        note:          form.note.trim() ? form.note.trim() : null,
      });

      // Local update — prepend (newest first, matches getTransactions order).
      setTransactions(prev => [saved, ...prev]);

      // Refresh balances only (accounts never change).
      try {
        const bal = await getBalances();
        setBalances(bal);
      } catch {
        // A balance refresh failure shouldn't block the success path —
        // the transaction was saved. The cards will reconcile on next load.
      }

      setSuccessMsg(form.type === "transfer" ? "Transfer recorded." : "Cash injection recorded.");
      setModalOpen(false);
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

      <p className="text-sm text-slate-500">
        Daybook — {transactions.length} transaction(s), {balances.length} buckets loaded.
      </p>

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
                  <h2 className="text-[15px] font-semibold text-slate-800 leading-none">Add Transaction</h2>
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
                {saving ? "Saving…" : "Save Transaction"}
              </button>
            </div>

          </div>
        </div>
      )}
    </div>
  );
}

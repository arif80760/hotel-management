"use client";

// app/accounts/payroll/PayrollClient.tsx
//
// Payroll — records salary / advance / bonus payments to staff.
//
// Payroll is NOT a separate engine. Each payment is an expense_out
// transaction funded from Cash in Hand, tagged with the "Salary" expense
// category, and linked to an employee via employee_id. It routes through
// createExpense(), so it auto-generates an EV-YYYY-NNNN voucher and shows
// up in the Cashbook like any other expense. (Spec: accounts.md §6.)
//
// The payment "kind" (Salary / Advance / Bonus) is stored as a leading
// label in the note — e.g. "Advance — June rent" — so no schema change is
// needed. parseKind() reads it back for display.
// ─────────────────────────────────────────────────────────────

import { useState, useEffect, useMemo } from "react";

import {
  getExpenses,
  createExpense,
  type Expense,
  type NewExpense,
} from "@/services/expensesService";

import {
  getAllEmployees,
  type Employee,
} from "@/services/employeesService";

import {
  getExpenseCategories,
  createExpenseCategory,
} from "@/services/expenseCategoriesService";
import { useReferenceData } from "@/contexts/ReferenceDataContext";

// ── Payment kinds ──────────────────────────────────────────
type PayKind = "Salary" | "Advance" | "Bonus";
const PAY_KINDS: PayKind[] = ["Salary", "Advance", "Bonus"];

// ── Input styling helper (mirrors ExpenseClient) ───────────
function inputCls(hasError = false): string {
  return [
    "w-full px-3.5 py-2.5 text-[13.5px] text-slate-800 bg-white border rounded-lg",
    "placeholder:text-slate-300 focus:outline-none focus:ring-2 focus:ring-amber-400 focus:border-transparent transition",
    hasError ? "border-rose-300 bg-rose-50" : "border-slate-200",
  ].join(" ");
}

// ── Date / money helpers ───────────────────────────────────
function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function currentMonthISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function formatAmount(n: number): string {
  return new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}

function formatDateLabel(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  const weekday = d.toLocaleDateString("en-GB", { weekday: "short" });
  const day = d.getDate();
  const month = d.toLocaleDateString("en-GB", { month: "short" });
  const year = d.getFullYear();
  return `${weekday} ${day} ${month} ${year}`;
}

function formatMonthLabel(monthISO: string): string {
  const d = new Date(monthISO + "-01T00:00:00");
  return d.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
}

// ── Note convention: "<Kind> — <detail>" ──────────────────
function parseKind(note: string | null): { kind: PayKind; detail: string } {
  if (!note) return { kind: "Salary", detail: "" };
  const sep = " — ";
  const idx = note.indexOf(sep);
  const head = (idx >= 0 ? note.slice(0, idx) : note).trim();
  const detail = idx >= 0 ? note.slice(idx + sep.length).trim() : "";
  if ((PAY_KINDS as string[]).includes(head)) return { kind: head as PayKind, detail };
  // Note doesn't follow the payroll convention — show the whole thing as detail.
  return { kind: "Salary", detail: note };
}

function kindBadgeCls(kind: PayKind): string {
  switch (kind) {
    case "Advance": return "bg-sky-50 text-sky-700 border-sky-100";
    case "Bonus":   return "bg-emerald-50 text-emerald-700 border-emerald-100";
    case "Salary":
    default:        return "bg-amber-50 text-amber-700 border-amber-100";
  }
}


export default function PayrollClient() {
  const { expenseCategories } = useReferenceData();
  // ── Data ───────────────────────────────────────────────────
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [salaryCategoryId, setSalaryCategoryId] = useState<string | null>(null);

  // ── Load state ─────────────────────────────────────────────
  const [fetching, setFetching] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // ── Month filter ───────────────────────────────────────────
  const [selectedMonth, setSelectedMonth] = useState<string>(currentMonthISO());

  // ── Record-payment modal ───────────────────────────────────
  const [payEmployee, setPayEmployee] = useState<Employee | null>(null);
  const [payDate, setPayDate] = useState<string>(todayISO());
  const [payAmount, setPayAmount] = useState<string>("");
  const [payKind, setPayKind] = useState<PayKind>("Salary");
  const [payNote, setPayNote] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [amountError, setAmountError] = useState<string | null>(null);

  // ── History modal ──────────────────────────────────────────
  const [historyEmployee, setHistoryEmployee] = useState<Employee | null>(null);

  // ── Success banner ─────────────────────────────────────────
  const [successMsg, setSuccessMsg] = useState("");

  // ── Load on mount ──────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [emps, exps] = await Promise.all([
          getAllEmployees(),
          getExpenses(),
        ]);
        if (cancelled) return;
        setEmployees(emps);
        setExpenses(exps);
        // salaryCategoryId is derived from the cached expense categories (effect below).
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

  // ── Resolve the "Salary" category id from the session cache ──
  // Reacts when the reference cache finishes loading. The write flow
  // (resolveSalaryCategoryId) still creates/refetches it on demand.
  useEffect(() => {
    const salaryCat = expenseCategories.find((c) => c.name.trim().toLowerCase() === "salary") ?? null;
    setSalaryCategoryId(salaryCat ? salaryCat.id : null);
  }, [expenseCategories]);

  // ── Auto-clear success banner ──────────────────────────────
  useEffect(() => {
    if (!successMsg) return;
    const t = setTimeout(() => setSuccessMsg(""), 4000);
    return () => clearTimeout(t);
  }, [successMsg]);

  // ── Escape closes modals ───────────────────────────────────
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (payEmployee && !saving) closePayModal();
      else if (historyEmployee) setHistoryEmployee(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payEmployee, historyEmployee, saving]);

  // ── Derived data ───────────────────────────────────────────
  const activeEmployees = useMemo(
    () => employees.filter((e) => e.isActive),
    [employees],
  );

  // Payroll rows = employee-linked expenses tagged with the Salary category.
  const payrollTxns = useMemo(() => {
    if (!salaryCategoryId) return [] as Expense[];
    return expenses.filter((e) => e.employeeId && e.categoryId === salaryCategoryId);
  }, [expenses, salaryCategoryId]);

  const monthTxns = useMemo(
    () => payrollTxns.filter((e) => e.txnDate.startsWith(selectedMonth)),
    [payrollTxns, selectedMonth],
  );

  const monthTotal = useMemo(
    () => monthTxns.reduce((sum, e) => sum + e.amount, 0),
    [monthTxns],
  );

  const monthKindTotals = useMemo(() => {
    const totals: Record<PayKind, number> = { Salary: 0, Advance: 0, Bonus: 0 };
    for (const e of monthTxns) totals[parseKind(e.note).kind] += e.amount;
    return totals;
  }, [monthTxns]);

  const monthTotalByEmployee = useMemo(() => {
    const map = new Map<string, number>();
    for (const e of monthTxns) {
      if (!e.employeeId) continue;
      map.set(e.employeeId, (map.get(e.employeeId) ?? 0) + e.amount);
    }
    return map;
  }, [monthTxns]);

  const historyTxns = useMemo(() => {
    if (!historyEmployee) return [] as Expense[];
    return payrollTxns.filter((e) => e.employeeId === historyEmployee.id);
  }, [payrollTxns, historyEmployee]);

  // ── Modal helpers ──────────────────────────────────────────
  function openPayModal(emp: Employee) {
    setPayEmployee(emp);
    setPayDate(todayISO());
    setPayAmount("");
    setPayKind("Salary");
    setPayNote("");
    setSaveError(null);
    setAmountError(null);
  }
  function closePayModal() {
    if (saving) return;
    setPayEmployee(null);
  }

  // ── Resolve the Salary category id (find-or-create) ────────
  async function resolveSalaryCategoryId(): Promise<string> {
    if (salaryCategoryId) return salaryCategoryId;
    const cats = await getExpenseCategories();
    const found = cats.find((c) => c.name.trim().toLowerCase() === "salary");
    if (found) { setSalaryCategoryId(found.id); return found.id; }
    try {
      const created = await createExpenseCategory("Salary");
      setSalaryCategoryId(created.id);
      return created.id;
    } catch {
      // Another writer may have created it concurrently — re-fetch.
      const again = (await getExpenseCategories()).find(
        (c) => c.name.trim().toLowerCase() === "salary",
      );
      if (!again) throw new Error("Could not resolve the Salary category.");
      setSalaryCategoryId(again.id);
      return again.id;
    }
  }

  // ── Record a payment ───────────────────────────────────────
  async function handleRecordPayment() {
    if (!payEmployee) return;

    const amt = parseFloat(payAmount);
    if (!payAmount.trim() || isNaN(amt) || amt <= 0) {
      setAmountError("Amount must be a positive number.");
      return;
    }
    setAmountError(null);
    setSaveError(null);
    setSaving(true);

    try {
      const categoryId = await resolveSalaryCategoryId();
      const detail = payNote.trim();
      const note = detail ? `${payKind} — ${detail}` : payKind;

      const input: NewExpense = {
        txnDate:    payDate,
        amount:     amt,
        categoryId,
        payeeMode:  "employee",
        employeeId: payEmployee.id,
        note,
      };
      const created = await createExpense(input);

      const exps = await getExpenses();
      setExpenses(exps);

      setSuccessMsg(`${payKind} of ৳${formatAmount(amt)} to ${payEmployee.fullName} recorded — voucher ${created.voucherNumber}.`);
      setPayEmployee(null);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to record payment.");
    } finally {
      setSaving(false);
    }
  }

  // ── Loading / error ────────────────────────────────────────
  if (fetching) {
    return (
      <div className="p-8">
        <h1 className="text-2xl font-semibold text-slate-800">Payroll</h1>
        <div className="mt-8 rounded-xl border border-dashed border-slate-200 bg-white px-6 py-12 flex items-center justify-center text-[13px] text-slate-400">
          Loading…
        </div>
      </div>
    );
  }
  if (fetchError) {
    return (
      <div className="p-8">
        <h1 className="text-2xl font-semibold text-slate-800">Payroll</h1>
        <div className="mt-8 rounded-xl border border-rose-200 bg-rose-50 px-6 py-4 text-[13px] text-rose-700">
          {fetchError}
        </div>
      </div>
    );
  }

  // ── Render ─────────────────────────────────────────────────
  return (
    <div className="p-8 space-y-5">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-800">Payroll</h1>
          <p className="mt-1 text-[13px] text-slate-500">
            Record salary, advance, and bonus payments. Each is paid from Cash in Hand and generates a voucher.
          </p>
        </div>
      </div>

      {/* Month filter + total */}
      <div className="flex items-center gap-3 bg-white border border-slate-200 rounded-xl px-4 py-3">
        <span className="text-[12px] font-semibold text-slate-500 uppercase tracking-wider">Month</span>
        <input
          type="month"
          value={selectedMonth}
          max={currentMonthISO()}
          onChange={(e) => setSelectedMonth(e.target.value)}
          className="px-2.5 py-1.5 text-[13px] text-slate-800 bg-white border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-amber-400"
        />
        <button
          type="button"
          onClick={() => setSelectedMonth(currentMonthISO())}
          className="ml-1 px-3 py-1.5 text-[12.5px] text-slate-600 hover:bg-slate-100 rounded-md font-medium transition-colors"
        >
          This month
        </button>
        <div className="ml-auto text-[12.5px] text-slate-500">
          {monthTxns.length} {monthTxns.length === 1 ? "payment" : "payments"} ·{" "}
          <span className="font-semibold text-slate-700 tabular-nums">৳{formatAmount(monthTotal)}</span>
        </div>
      </div>

      {/* Success banner */}
      {successMsg && (
        <div className="flex items-center gap-3 bg-emerald-50 border border-emerald-200 rounded-xl px-5 py-3.5">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-5 h-5 text-emerald-600 flex-shrink-0">
            <path d="M22 11.08V12a10 10 0 11-5.93-9.14" />
            <path d="M22 4L12 14.01l-3-3" />
          </svg>
          <p className="text-[13px] font-medium text-emerald-800">{successMsg}</p>
        </div>
      )}

      {/* Per-type totals for the month */}
      <div className="grid grid-cols-3 gap-4">
        {PAY_KINDS.map((k) => (
          <div key={k} className="rounded-xl border border-slate-200 bg-white px-5 py-4">
            <div className="flex items-center gap-2">
              <span className={`px-2 py-0.5 rounded-full text-[11px] font-semibold uppercase tracking-wider border ${kindBadgeCls(k)}`}>{k}</span>
              <span className="text-[12px] text-slate-400">{formatMonthLabel(selectedMonth)}</span>
            </div>
            <p className="mt-2 text-[20px] font-semibold text-slate-800 tabular-nums">৳{formatAmount(monthKindTotals[k])}</p>
          </div>
        ))}
      </div>

      {/* Staff roster */}
      <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3 bg-slate-50 border-b border-slate-200">
          <h3 className="text-[13.5px] font-semibold text-slate-700">Staff</h3>
          <span className="text-[12.5px] text-slate-500">{activeEmployees.length} active</span>
        </div>

        {activeEmployees.length === 0 ? (
          <div className="px-6 py-12 flex flex-col items-center justify-center text-center">
            <p className="text-[14px] font-semibold text-slate-600 mb-1">No active employees</p>
            <p className="text-[12.5px] text-slate-400 max-w-md">
              Add staff on the Employees page, then come back to record their payments.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {activeEmployees.map((emp) => {
              const paidThisMonth = monthTotalByEmployee.get(emp.id) ?? 0;
              return (
                <li key={emp.id} className="px-5 py-3.5 flex items-center gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2.5">
                      <span className="text-[14px] font-semibold text-slate-800 truncate">{emp.fullName}</span>
                      <span className="text-[11.5px] text-slate-400">{emp.designation}</span>
                    </div>
                    <p className="mt-0.5 text-[12px] text-slate-500">
                      Paid in {formatMonthLabel(selectedMonth)}:{" "}
                      <span className="font-semibold text-slate-700 tabular-nums">৳{formatAmount(paidThisMonth)}</span>
                    </p>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <button
                      type="button"
                      onClick={() => setHistoryEmployee(emp)}
                      className="px-3 py-1.5 rounded-md bg-slate-100 hover:bg-slate-200 text-slate-700 text-[11.5px] font-semibold uppercase tracking-wider transition-colors"
                    >
                      History
                    </button>
                    <button
                      type="button"
                      onClick={() => openPayModal(emp)}
                      className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-md bg-slate-900 text-white text-[12.5px] font-semibold hover:bg-slate-800 transition-colors"
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" className="w-3.5 h-3.5">
                        <path d="M12 5v14M5 12h14" />
                      </svg>
                      Record payment
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* ── RECORD PAYMENT MODAL ─────────────────────────────── */}
      {payEmployee && (
        <div
          className="fixed inset-0 bg-slate-900/40 flex items-center justify-center z-50 p-6"
          onClick={closePayModal}
        >
          <div
            className="bg-white rounded-xl shadow-xl w-full max-w-md max-h-[90vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
              <div>
                <h2 className="text-[15px] font-semibold text-slate-800">Record payment</h2>
                <p className="text-[12px] text-slate-500 mt-0.5">{payEmployee.fullName} · {payEmployee.designation}</p>
              </div>
              <button
                type="button"
                onClick={closePayModal}
                disabled={saving}
                className="text-slate-400 hover:text-slate-700 disabled:opacity-40 disabled:cursor-not-allowed"
                aria-label="Close"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-5 h-5">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">

              {/* Payment type */}
              <div className="space-y-1">
                <label className="block text-[12px] font-semibold text-slate-500 uppercase tracking-wider">Payment type</label>
                <div className="flex gap-2">
                  {PAY_KINDS.map((k) => (
                    <button
                      key={k}
                      type="button"
                      onClick={() => setPayKind(k)}
                      disabled={saving}
                      className={[
                        "flex-1 px-3 py-2 rounded-lg text-[13px] font-semibold transition-colors disabled:opacity-40",
                        payKind === k
                          ? "bg-amber-100 text-amber-800 border border-amber-300"
                          : "bg-slate-50 text-slate-600 border border-slate-200 hover:bg-slate-100",
                      ].join(" ")}
                    >
                      {k}
                    </button>
                  ))}
                </div>
              </div>

              {/* Date + Amount */}
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="block text-[12px] font-semibold text-slate-500 uppercase tracking-wider">Date</label>
                  <input
                    type="date"
                    value={payDate}
                    max={todayISO()}
                    onChange={(e) => setPayDate(e.target.value)}
                    disabled={saving}
                    className={inputCls(false)}
                  />
                </div>
                <div className="space-y-1">
                  <label className="block text-[12px] font-semibold text-slate-500 uppercase tracking-wider">Amount (৳)</label>
                  <input
                    type="number"
                    inputMode="decimal"
                    step="0.01"
                    min="0.01"
                    value={payAmount}
                    onChange={(e) => setPayAmount(e.target.value)}
                    placeholder="0.00"
                    disabled={saving}
                    className={inputCls(!!amountError)}
                  />
                  {amountError && <p className="text-[11.5px] text-rose-600">{amountError}</p>}
                </div>
              </div>

              {/* Note */}
              <div className="space-y-1">
                <label className="block text-[12px] font-semibold text-slate-500 uppercase tracking-wider">Note (optional)</label>
                <input
                  type="text"
                  value={payNote}
                  onChange={(e) => setPayNote(e.target.value)}
                  placeholder="e.g. May salary, advance against June"
                  disabled={saving}
                  className={inputCls(false)}
                />
              </div>

              {/* Funding notice */}
              <div className="bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-[11.5px] text-slate-500">
                Paid from <span className="font-semibold text-slate-700">Cash in Hand</span>, tagged{" "}
                <span className="font-semibold text-slate-700">Salary</span>. A voucher is generated automatically.
              </div>

              {saveError && (
                <div className="bg-rose-50 border border-rose-200 rounded-lg px-3 py-2 text-[12px] text-rose-700">
                  {saveError}
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-slate-200">
              <button
                type="button"
                onClick={closePayModal}
                disabled={saving}
                className="px-4 py-2 rounded-lg text-slate-600 hover:bg-slate-100 text-[13px] font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleRecordPayment}
                disabled={saving}
                className="px-4 py-2 rounded-lg bg-slate-900 text-white text-[13px] font-semibold hover:bg-slate-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {saving ? "Saving…" : "Record payment"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── HISTORY MODAL ────────────────────────────────────── */}
      {historyEmployee && (
        <div
          className="fixed inset-0 bg-slate-900/40 flex items-center justify-center z-50 p-6"
          onClick={() => setHistoryEmployee(null)}
        >
          <div
            className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[85vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
              <div>
                <h2 className="text-[15px] font-semibold text-slate-800">Payment history</h2>
                <p className="text-[12px] text-slate-500 mt-0.5">{historyEmployee.fullName} · {historyEmployee.designation}</p>
              </div>
              <button
                type="button"
                onClick={() => setHistoryEmployee(null)}
                className="text-slate-400 hover:text-slate-700"
                aria-label="Close"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-5 h-5">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-5 py-3">
              {historyTxns.length === 0 ? (
                <div className="py-10 text-center text-[13px] text-slate-400 italic">
                  No payments recorded yet.
                </div>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {historyTxns.map((e) => {
                    const { kind, detail } = parseKind(e.note);
                    return (
                      <li key={e.id} className="py-3 flex items-center gap-3">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2.5">
                            <span className="text-[14px] font-semibold text-slate-800 tabular-nums">৳{formatAmount(e.amount)}</span>
                            <span className={`px-2 py-0.5 rounded-full text-[11px] font-semibold uppercase tracking-wider border ${kindBadgeCls(kind)}`}>{kind}</span>
                            <span className="text-[12px] text-slate-400">{formatDateLabel(e.txnDate)}</span>
                          </div>
                          {detail && <p className="mt-0.5 text-[12px] text-slate-400 truncate">{detail}</p>}
                        </div>
                        <div className="flex items-center gap-3 flex-shrink-0">
                          <span className="font-mono text-[11.5px] text-slate-400">{e.voucherNumber}</span>
                          <a
                            href={`/accounts/voucher/${e.id}`}
                            className="px-3 py-1.5 rounded-md bg-slate-100 hover:bg-slate-200 text-slate-700 text-[11.5px] font-semibold uppercase tracking-wider transition-colors"
                            title="View voucher"
                          >
                            Voucher
                          </a>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <div className="flex items-center justify-between px-5 py-3 border-t border-slate-200">
              <span className="text-[12.5px] text-slate-500">
                {historyTxns.length} {historyTxns.length === 1 ? "payment" : "payments"} ·{" "}
                <span className="font-semibold text-slate-700 tabular-nums">
                  ৳{formatAmount(historyTxns.reduce((s, e) => s + e.amount, 0))}
                </span>{" "}
                total
              </span>
              <button
                type="button"
                onClick={() => setHistoryEmployee(null)}
                className="px-4 py-2 rounded-lg text-slate-600 hover:bg-slate-100 text-[13px] font-semibold transition-colors"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

"use client";

// app/accounts/expense/ExpenseClient.tsx
//
// Expense Management page — Phase 4C ships the expense entry modal and
// a daybook-style list view grouped by date.
//
// Layout:
//   - Header: "Expense" title + two top-right buttons
//     (Manage Categories, Add Expense)
//   - Date filter row (default: today)
//   - Body: daybook-style list grouped by txn_date, newest first
//   - Manage Categories modal (Phase 4B, unchanged)
//   - Add Expense modal (Phase 4C, NEW)
//
// Service-layer pattern: this page fetches expenses, categories, and
// employees separately on mount, then resolves category/employee names
// in the UI via lookup maps. (The service layer returns flat IDs to keep
// the Supabase queries simple and avoid PostgREST nested-select typing
// issues.)
//
// ─────────────────────────────────────────────────────────────

import { useState, useEffect } from "react";

import {
  getExpenseCategories,
  createExpenseCategory,
  updateExpenseCategoryName,
  setExpenseCategoryActive,
  type ExpenseCategory,
} from "@/services/expenseCategoriesService";

import {
  getExpenses,
  getDistinctPayees,
  createExpense,
  type Expense,
  type NewExpense,
} from "@/services/expensesService";

import {
  getAllEmployees,
  type Employee,
} from "@/services/employeesService";

import {
  getInventoryItems,
  createPurchaseMovement,
  type InventoryItem,
} from "@/services/inventoryService";


// ── Input styling helper ───────────────────────────────────
function inputCls(hasError = false): string {
  return [
    "w-full px-3.5 py-2.5 text-[13.5px] text-slate-800 bg-white border rounded-lg",
    "placeholder:text-slate-300 focus:outline-none focus:ring-2 focus:ring-amber-400 focus:border-transparent transition",
    hasError ? "border-rose-300 bg-rose-50" : "border-slate-200",
  ].join(" ");
}

// ── Date helpers ───────────────────────────────────────────

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatDateLabel(iso: string): string {
  // Returns a human-friendly grouping label.
  // Today => "Today, Sat 30 May 2026"
  // Yesterday => "Yesterday, Fri 29 May 2026"
  // Otherwise => "Wed 28 May 2026"
  const today = todayISO();
  const d = new Date(iso + "T00:00:00");
  const weekday  = d.toLocaleDateString("en-GB", { weekday: "short" });
  const day      = d.getDate();
  const month    = d.toLocaleDateString("en-GB", { month: "short" });
  const year     = d.getFullYear();
  const base = `${weekday} ${day} ${month} ${year}`;

  if (iso === today) return `Today, ${base}`;

  // Yesterday check
  const yest = new Date();
  yest.setDate(yest.getDate() - 1);
  const yISO = `${yest.getFullYear()}-${String(yest.getMonth() + 1).padStart(2, "0")}-${String(yest.getDate()).padStart(2, "0")}`;
  if (iso === yISO) return `Yesterday, ${base}`;

  return base;
}

function formatAmount(n: number): string {
  // Bangladeshi locale grouping (1,23,456.78). Cashbook uses en-IN; keep consistent.
  return new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}


export default function ExpenseClient() {
  // ── Data ───────────────────────────────────────────────────
  const [expenses,        setExpenses]        = useState<Expense[]>([]);
  const [categories,      setCategories]      = useState<ExpenseCategory[]>([]);
  const [employees,       setEmployees]       = useState<Employee[]>([]);
  const [payeesHistory,   setPayeesHistory]   = useState<string[]>([]);
  const [inventoryItems,  setInventoryItems]  = useState<InventoryItem[]>([]);

  // ── Load state ─────────────────────────────────────────────
  const [fetching,   setFetching]   = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // ── Filter state ───────────────────────────────────────────
  const [filterFromDate, setFilterFromDate] = useState<string>(todayISO());
  const [filterToDate,   setFilterToDate]   = useState<string>(todayISO());

  // ── Manage Categories modal (Phase 4B, unchanged) ──────────
  const [categoryModalOpen, setCategoryModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const [newCategoryName, setNewCategoryName] = useState("");
  const [creatingCategory, setCreatingCategory] = useState(false);
  const [createCategoryError, setCreateCategoryError] = useState<string | null>(null);

  const [togglingId, setTogglingId] = useState<string | null>(null);

  // ── Add Expense modal (Phase 4C, NEW) ──────────────────────
  const [expenseModalOpen, setExpenseModalOpen] = useState(false);
  const [exTxnDate,     setExTxnDate]     = useState<string>(todayISO());
  const [exAmount,      setExAmount]      = useState<string>("");
  const [exCategoryId,  setExCategoryId]  = useState<string>("");
  const [exPayeeMode,   setExPayeeMode]   = useState<"employee" | "vendor">("employee");
  const [exEmployeeId,  setExEmployeeId]  = useState<string>("");
  const [exPayeeText,   setExPayeeText]   = useState<string>("");
  const [exNote,        setExNote]        = useState<string>("");
  // ── Inventory purchase toggle state ───────────────────────
  const [exIsInventory,   setExIsInventory]   = useState<boolean>(false);
  const [exInvItemId,     setExInvItemId]     = useState<string>("");
  const [exInvItemSearch, setExInvItemSearch] = useState<string>("");
  const [exInvQuantity,   setExInvQuantity]   = useState<string>("");
  const [exInvUnitPrice,  setExInvUnitPrice]  = useState<string>("");

  const [creatingExpense, setCreatingExpense] = useState(false);
  const [createExpenseError, setCreateExpenseError] = useState<string | null>(null);
  const [createExpenseFieldErrors, setCreateExpenseFieldErrors] = useState<{
    amount?: string;
    category?: string;
    payee?: string;
  }>({});

  // ── Success banner ─────────────────────────────────────────
  const [successMsg, setSuccessMsg] = useState("");

  // ── Load on mount ──────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [exps, cats, emps, payeesH, invItems] = await Promise.all([
          getExpenses({ fromDate: filterFromDate, toDate: filterToDate }),
          getExpenseCategories(),
          getAllEmployees(),
          getDistinctPayees(),
          getInventoryItems({ activeOnly: false }),
        ]);
        if (cancelled) return;
        setExpenses(exps);
        setCategories(cats);
        setEmployees(emps);
        setPayeesHistory(payeesH);
        setInventoryItems(invItems);
      } catch (err) {
        if (!cancelled) {
          setFetchError(err instanceof Error ? err.message : "Failed to load.");
        }
      } finally {
        if (!cancelled) setFetching(false);
      }
    }
    load();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Refetch expenses when filter changes ───────────────────
  useEffect(() => {
    if (fetching) return; // initial load handles its own range
    let cancelled = false;
    (async () => {
      try {
        const exps = await getExpenses({ fromDate: filterFromDate, toDate: filterToDate });
        if (!cancelled) setExpenses(exps);
      } catch (err) {
        console.error("[ExpenseClient] refilter failed:", err);
      }
    })();
    return () => { cancelled = true; };
  }, [filterFromDate, filterToDate, fetching]);

  // ── Auto-clear success banner ──────────────────────────────
  useEffect(() => {
    if (!successMsg) return;
    const t = setTimeout(() => setSuccessMsg(""), 4000);
    return () => clearTimeout(t);
  }, [successMsg]);

  // ── Escape closes modals (when nothing is saving) ──────────
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (categoryModalOpen && !savingEdit && !creatingCategory && !togglingId) {
        closeCategoryModal();
      } else if (expenseModalOpen && !creatingExpense) {
        closeExpenseModal();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [categoryModalOpen, expenseModalOpen, savingEdit, creatingCategory, togglingId, creatingExpense]);

  // ── Lookup maps ────────────────────────────────────────────
  const categoryById = new Map(categories.map(c => [c.id, c]));
  const employeeById = new Map(employees.map(e => [e.id, e]));

  const activeCategories = categories.filter(c => c.isActive);
  const activeEmployees  = employees.filter(e => e.isActive);

  // ── Category Modal helpers ─────────────────────────────────
  function openCategoryModal() {
    setCategoryModalOpen(true);
    setEditingId(null);
    setEditingValue("");
    setEditError(null);
    setNewCategoryName("");
    setCreateCategoryError(null);
  }
  function closeCategoryModal() {
    if (savingEdit || creatingCategory || togglingId) return;
    setCategoryModalOpen(false);
  }

  // ── Expense Modal helpers ──────────────────────────────────
  function openExpenseModal() {
    setExpenseModalOpen(true);
    setExTxnDate(todayISO());
    setExAmount("");
    setExCategoryId("");
    setExPayeeMode("employee");
    setExEmployeeId("");
    setExPayeeText("");
    setExNote("");
    setCreateExpenseError(null);
    setCreateExpenseFieldErrors({});
    setExIsInventory(false);
    setExInvItemId("");
    setExInvItemSearch("");
    setExInvQuantity("");
    setExInvUnitPrice("");
  }
  function closeExpenseModal() {
    if (creatingExpense) return;
    setExpenseModalOpen(false);
  }

  // ── Reload helpers ─────────────────────────────────────────
  async function reloadCategories() {
    try {
      const cats = await getExpenseCategories();
      setCategories(cats);
    } catch (err) {
      console.error("[ExpenseClient] reloadCategories failed:", err);
    }
  }
  async function reloadExpenses() {
    try {
      const [exps, payeesH] = await Promise.all([
        getExpenses({ fromDate: filterFromDate, toDate: filterToDate }),
        getDistinctPayees(),
      ]);
      setExpenses(exps);
      setPayeesHistory(payeesH);
    } catch (err) {
      console.error("[ExpenseClient] reloadExpenses failed:", err);
    }
  }

  // ── Category Handlers (4B, unchanged behavior) ─────────────
  async function handleCreateCategory() {
    const trimmed = newCategoryName.trim();
    if (!trimmed) { setCreateCategoryError("Name is required."); return; }
    setCreateCategoryError(null);
    setCreatingCategory(true);
    try {
      await createExpenseCategory(trimmed);
      setNewCategoryName("");
      setSuccessMsg(`Category "${trimmed}" created.`);
      await reloadCategories();
    } catch (err) {
      setCreateCategoryError(err instanceof Error ? err.message : "Create failed.");
    } finally {
      setCreatingCategory(false);
    }
  }
  function startEdit(c: ExpenseCategory) {
    setEditingId(c.id);
    setEditingValue(c.name);
    setEditError(null);
  }
  function cancelEdit() {
    setEditingId(null);
    setEditingValue("");
    setEditError(null);
  }
  async function handleSaveEdit() {
    if (!editingId) return;
    const trimmed = editingValue.trim();
    if (!trimmed) { setEditError("Name is required."); return; }
    setEditError(null);
    setSavingEdit(true);
    try {
      await updateExpenseCategoryName(editingId, trimmed);
      setSuccessMsg(`Category renamed to "${trimmed}".`);
      setEditingId(null);
      setEditingValue("");
      await reloadCategories();
    } catch (err) {
      setEditError(err instanceof Error ? err.message : "Rename failed.");
    } finally {
      setSavingEdit(false);
    }
  }
  async function handleToggleActive(c: ExpenseCategory) {
    setTogglingId(c.id);
    try {
      await setExpenseCategoryActive(c.id, !c.isActive);
      setSuccessMsg(`Category "${c.name}" ${c.isActive ? "deactivated" : "reactivated"}.`);
      await reloadCategories();
    } catch (err) {
      console.error("[ExpenseClient] toggle failed:", err);
    } finally {
      setTogglingId(null);
    }
  }

  // ── Expense Handler ────────────────────────────────────────
  async function handleCreateExpense() {
    // Field-level validation
    const fieldErrors: { amount?: string; category?: string; payee?: string; invItem?: string; invQty?: string } = {};
    const amountNum = parseFloat(exAmount);
    if (!exAmount.trim() || isNaN(amountNum) || amountNum <= 0) {
      fieldErrors.amount = "Amount must be a positive number.";
    }
    if (!exCategoryId) fieldErrors.category = "Category is required.";
    if (exPayeeMode === "employee" && !exEmployeeId) fieldErrors.payee = "Select an employee.";
    if (exPayeeMode === "vendor"   && !exPayeeText.trim()) fieldErrors.payee = "Payee name is required.";
    // Inventory sub-form validation (only when toggle is ON)
    if (exIsInventory) {
      if (!exInvItemId) fieldErrors.invItem = "Select a valid inventory item from the list.";
      const invQtyNum = parseFloat(exInvQuantity);
      if (!exInvQuantity.trim() || isNaN(invQtyNum) || invQtyNum <= 0) {
        fieldErrors.invQty = "Quantity must be a positive number.";
      }
    }

    if (Object.keys(fieldErrors).length > 0) {
      setCreateExpenseFieldErrors(fieldErrors);
      return;
    }
    setCreateExpenseFieldErrors({});
    setCreateExpenseError(null);
    setCreatingExpense(true);

    try {
      const input: NewExpense = {
        txnDate:     exTxnDate,
        amount:      amountNum,
        categoryId:  exCategoryId,
        payeeMode:   exPayeeMode,
        employeeId:  exPayeeMode === "employee" ? exEmployeeId : undefined,
        payee:       exPayeeMode === "vendor"   ? exPayeeText.trim() : undefined,
        note:        exNote.trim() || undefined,
      };
      const newExpense = await createExpense(input);

      // Inventory seam (Phase I-D): when toggle is ON, write the
      // purchase movement immediately after the expense row, linking
      // them via source_account_transaction_id.
      if (exIsInventory && exInvItemId) {
        const invQtyNum = parseFloat(exInvQuantity);
        const invUpNum  = exInvUnitPrice.trim()
          ? parseFloat(exInvUnitPrice)
          : amountNum / invQtyNum;
        await createPurchaseMovement({
          itemId:                      exInvItemId,
          quantity:                    invQtyNum,
          unitPrice:                   isFinite(invUpNum) ? invUpNum : amountNum,
          happenedAt:                  new Date(exTxnDate + "T12:00:00").toISOString(),
          sourceAccountTransactionId:  newExpense.id,
        });
      }

      setSuccessMsg(`Expense ${newExpense.voucherNumber} created.`);
      closeExpenseModal();
      await reloadExpenses();
    } catch (err) {
      setCreateExpenseError(err instanceof Error ? err.message : "Create failed.");
    } finally {
      setCreatingExpense(false);
    }
  }

  // ── Group expenses by date for daybook layout ──────────────
  function groupByDate(list: Expense[]): Array<{ date: string; rows: Expense[]; total: number }> {
    const byDate = new Map<string, Expense[]>();
    for (const e of list) {
      if (!byDate.has(e.txnDate)) byDate.set(e.txnDate, []);
      byDate.get(e.txnDate)!.push(e);
    }
    // Sort dates descending (newest first)
    return Array.from(byDate.entries())
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([date, rows]) => ({
        date,
        rows,
        total: rows.reduce((sum, r) => sum + r.amount, 0),
      }));
  }
  const groups = groupByDate(expenses);

  // ── Loading state ──────────────────────────────────────────
  if (fetching) {
    return (
      <div className="p-8">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold text-slate-800">Expense</h1>
        </div>
        <div className="mt-8 rounded-xl border border-dashed border-slate-200 bg-white px-6 py-12 flex items-center justify-center text-[13px] text-slate-400">
          Loading…
        </div>
      </div>
    );
  }
  if (fetchError) {
    return (
      <div className="p-8">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold text-slate-800">Expense</h1>
        </div>
        <div className="mt-8 rounded-xl border border-rose-200 bg-rose-50 px-6 py-4 text-[13px] text-rose-700">
          {fetchError}
        </div>
      </div>
    );
  }

  // ── Render ─────────────────────────────────────────────────
  return (
    <div className="p-8 space-y-5">

      {/* ── Header ──────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-slate-800">Expense</h1>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={openCategoryModal}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-white border border-slate-200 text-slate-700 text-[13px] font-semibold hover:bg-slate-50 hover:border-slate-300 transition-colors"
            title="Manage expense categories"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
              <line x1="8" y1="6" x2="21" y2="6" />
              <line x1="8" y1="12" x2="21" y2="12" />
              <line x1="8" y1="18" x2="21" y2="18" />
              <circle cx="4" cy="6" r="0.75" fill="currentColor" />
              <circle cx="4" cy="12" r="0.75" fill="currentColor" />
              <circle cx="4" cy="18" r="0.75" fill="currentColor" />
            </svg>
            Manage Categories
          </button>
          <button
            type="button"
            onClick={openExpenseModal}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-900 text-white text-[13px] font-semibold hover:bg-slate-800 transition-colors"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" className="w-4 h-4">
              <path d="M12 5v14M5 12h14" />
            </svg>
            Add Expense
          </button>
        </div>
      </div>

      {/* ── Date filter ─────────────────────────────────────── */}
      <div className="flex items-center gap-3 bg-white border border-slate-200 rounded-xl px-4 py-3">
        <span className="text-[12px] font-semibold text-slate-500 uppercase tracking-wider">From</span>
        <input
          type="date"
          value={filterFromDate}
          max={filterToDate}
          onChange={(e) => setFilterFromDate(e.target.value)}
          className="px-2.5 py-1.5 text-[13px] text-slate-800 bg-white border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-amber-400"
        />
        <span className="text-[12px] font-semibold text-slate-500 uppercase tracking-wider">To</span>
        <input
          type="date"
          value={filterToDate}
          min={filterFromDate}
          onChange={(e) => setFilterToDate(e.target.value)}
          className="px-2.5 py-1.5 text-[13px] text-slate-800 bg-white border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-amber-400"
        />
        <button
          type="button"
          onClick={() => { const t = todayISO(); setFilterFromDate(t); setFilterToDate(t); }}
          className="ml-2 px-3 py-1.5 text-[12.5px] text-slate-600 hover:bg-slate-100 rounded-md font-medium transition-colors"
        >
          Today
        </button>
        <div className="ml-auto text-[12.5px] text-slate-500">
          {expenses.length} {expenses.length === 1 ? "expense" : "expenses"}
        </div>
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

      {/* ── Daybook list ────────────────────────────────────── */}
      {groups.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-200 bg-white px-6 py-12 flex flex-col items-center justify-center text-center">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="w-8 h-8 text-slate-300 mb-3">
            <rect x="3" y="6" width="18" height="14" rx="2" />
            <path d="M3 10h18" />
            <path d="M7 14h4" />
            <path d="M7 17h7" />
          </svg>
          <p className="text-[14px] font-semibold text-slate-600 mb-1">No expenses in this date range</p>
          <p className="text-[12.5px] text-slate-400 max-w-md">
            Click <span className="font-semibold text-slate-600">Add Expense</span> to record one,
            or widen the date filter above.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {groups.map((g) => (
            <div key={g.date} className="rounded-xl border border-slate-200 bg-white overflow-hidden">
              {/* Date header */}
              <div className="flex items-center justify-between px-5 py-3 bg-slate-50 border-b border-slate-200">
                <h3 className="text-[13.5px] font-semibold text-slate-700">{formatDateLabel(g.date)}</h3>
                <span className="text-[12.5px] text-slate-500">
                  <span className="font-semibold text-slate-700">৳{formatAmount(g.total)}</span>{" "}
                  · {g.rows.length} {g.rows.length === 1 ? "expense" : "expenses"}
                </span>
              </div>
              {/* Rows */}
              <ul className="divide-y divide-slate-100">
                {g.rows.map((e) => {
                  const cat = e.categoryId ? categoryById.get(e.categoryId) : undefined;
                  const emp = e.employeeId ? employeeById.get(e.employeeId) : undefined;
                  const payeeDisplay = emp ? emp.fullName : (e.payee ?? "—");
                  return (
                    <li key={e.id} className="px-5 py-3.5 flex items-center gap-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-3">
                          <span className="text-[14px] font-semibold text-slate-800">৳{formatAmount(e.amount)}</span>
                          <span className="px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 text-[11px] font-semibold uppercase tracking-wider border border-amber-100">
                            {cat?.name ?? "—"}
                          </span>
                          <span className="text-[12.5px] text-slate-500 truncate">{payeeDisplay}</span>
                        </div>
                        {e.note && (
                          <p className="mt-1 text-[12px] text-slate-400 truncate">{e.note}</p>
                        )}
                      </div>
                      <div className="flex items-center gap-3 flex-shrink-0">
                        <span className="font-mono text-[11.5px] text-slate-400">{e.voucherNumber}</span>
                        <a
                          href={`/accounts/voucher/${e.id}`}
                          className="px-3 py-1.5 rounded-md bg-slate-100 hover:bg-slate-200 text-slate-700 text-[11.5px] font-semibold uppercase tracking-wider transition-colors"
                          title="View voucher (Phase 4D)"
                        >
                          Voucher
                        </a>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}

      {/* ────────────────────────────────────────────────────── */}
      {/* MANAGE CATEGORIES MODAL (Phase 4B)                     */}
      {/* ────────────────────────────────────────────────────── */}
      {categoryModalOpen && (
        <div className="fixed inset-0 bg-slate-900/40 flex items-center justify-center z-50 p-6" onClick={closeCategoryModal}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
              <h2 className="text-[15px] font-semibold text-slate-800">Manage Categories</h2>
              <button
                type="button"
                onClick={closeCategoryModal}
                disabled={!!(savingEdit || creatingCategory || togglingId)}
                className="text-slate-400 hover:text-slate-700 disabled:opacity-40 disabled:cursor-not-allowed"
                aria-label="Close"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-5 h-5"><path d="M18 6L6 18M6 6l12 12" /></svg>
              </button>
            </div>
            <div className="px-5 py-4 border-b border-slate-200 space-y-2">
              <label className="block text-[12px] font-semibold text-slate-500 uppercase tracking-wider">Add category</label>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={newCategoryName}
                  onChange={(e) => setNewCategoryName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") handleCreateCategory(); }}
                  placeholder="e.g. Room Supplies"
                  disabled={creatingCategory}
                  className={inputCls(!!createCategoryError)}
                />
                <button
                  type="button"
                  onClick={handleCreateCategory}
                  disabled={creatingCategory || !newCategoryName.trim()}
                  className="px-4 py-2.5 rounded-lg bg-slate-900 text-white text-[13px] font-semibold hover:bg-slate-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap"
                >
                  {creatingCategory ? "Adding…" : "Add"}
                </button>
              </div>
              {createCategoryError && (<p className="text-[12px] text-rose-600">{createCategoryError}</p>)}
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-3">
              {categories.length === 0 ? (
                <div className="py-8 text-center text-[13px] text-slate-400 italic">
                  No categories yet. Create one above to get started.
                </div>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {categories.map((c) => {
                    const isEditing = editingId === c.id;
                    const isToggling = togglingId === c.id;
                    return (
                      <li key={c.id} className={`py-3 flex items-center gap-3 ${c.isActive ? "" : "opacity-60"}`}>
                        {isEditing ? (
                          <>
                            <input
                              type="text"
                              autoFocus
                              value={editingValue}
                              onChange={(e) => setEditingValue(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") handleSaveEdit();
                                if (e.key === "Escape") cancelEdit();
                              }}
                              disabled={savingEdit}
                              className={inputCls(!!editError)}
                            />
                            <button type="button" onClick={handleSaveEdit} disabled={savingEdit || !editingValue.trim()} className="px-3 py-2 rounded-lg bg-slate-900 text-white text-[12.5px] font-semibold hover:bg-slate-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap">
                              {savingEdit ? "Saving…" : "Save"}
                            </button>
                            <button type="button" onClick={cancelEdit} disabled={savingEdit} className="px-3 py-2 rounded-lg text-slate-500 hover:bg-slate-100 text-[12.5px] font-medium transition-colors disabled:opacity-40">
                              Cancel
                            </button>
                          </>
                        ) : (
                          <>
                            <button type="button" onClick={() => startEdit(c)} className="flex-1 text-left text-[13.5px] font-medium text-slate-800 hover:text-amber-700 transition-colors" title="Click to rename">
                              {c.name}
                            </button>
                            {!c.isActive && (
                              <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 text-[10.5px] font-semibold uppercase tracking-wider">Inactive</span>
                            )}
                            <button
                              type="button"
                              onClick={() => handleToggleActive(c)}
                              disabled={isToggling}
                              className={`px-3 py-1.5 rounded-md text-[11.5px] font-semibold uppercase tracking-wider transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${c.isActive ? "bg-slate-100 text-slate-600 hover:bg-slate-200" : "bg-emerald-50 text-emerald-700 hover:bg-emerald-100"}`}
                            >
                              {isToggling ? "…" : c.isActive ? "Deactivate" : "Reactivate"}
                            </button>
                          </>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
              {editError && editingId && (<p className="mt-2 text-[12px] text-rose-600">{editError}</p>)}
            </div>
            <div className="flex items-center justify-end px-5 py-3 border-t border-slate-200">
              <button type="button" onClick={closeCategoryModal} disabled={!!(savingEdit || creatingCategory || togglingId)} className="px-4 py-2 rounded-lg text-slate-600 hover:bg-slate-100 text-[13px] font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ────────────────────────────────────────────────────── */}
      {/* ADD EXPENSE MODAL (Phase 4C — NEW)                      */}
      {/* ────────────────────────────────────────────────────── */}
      {expenseModalOpen && (
        <div className="fixed inset-0 bg-slate-900/40 flex items-center justify-center z-50 p-6" onClick={closeExpenseModal}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-xl max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>

            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
              <h2 className="text-[15px] font-semibold text-slate-800">Add Expense</h2>
              <button
                type="button"
                onClick={closeExpenseModal}
                disabled={creatingExpense}
                className="text-slate-400 hover:text-slate-700 disabled:opacity-40 disabled:cursor-not-allowed"
                aria-label="Close"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-5 h-5"><path d="M18 6L6 18M6 6l12 12" /></svg>
              </button>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">

              {/* Date + Amount */}
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="block text-[12px] font-semibold text-slate-500 uppercase tracking-wider">Date</label>
                  <input
                    type="date"
                    value={exTxnDate}
                    max={todayISO()}
                    onChange={(e) => setExTxnDate(e.target.value)}
                    disabled={creatingExpense}
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
                    value={exAmount}
                    onChange={(e) => setExAmount(e.target.value)}
                    placeholder="0.00"
                    disabled={creatingExpense}
                    className={inputCls(!!createExpenseFieldErrors.amount)}
                  />
                  {createExpenseFieldErrors.amount && (
                    <p className="text-[11.5px] text-rose-600">{createExpenseFieldErrors.amount}</p>
                  )}
                </div>
              </div>

              {/* Category */}
              <div className="space-y-1">
                <label className="block text-[12px] font-semibold text-slate-500 uppercase tracking-wider">Category</label>
                <select
                  value={exCategoryId}
                  onChange={(e) => setExCategoryId(e.target.value)}
                  disabled={creatingExpense}
                  className={inputCls(!!createExpenseFieldErrors.category)}
                >
                  <option value="">Select a category…</option>
                  {activeCategories.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
                {activeCategories.length === 0 && (
                  <p className="text-[11.5px] text-amber-700">No active categories. Add one via "Manage Categories" first.</p>
                )}
                {createExpenseFieldErrors.category && (
                  <p className="text-[11.5px] text-rose-600">{createExpenseFieldErrors.category}</p>
                )}
              </div>

              {/* Payee mode toggle */}
              <div className="space-y-1">
                <label className="block text-[12px] font-semibold text-slate-500 uppercase tracking-wider">Paid to</label>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => { setExPayeeMode("employee"); setExPayeeText(""); }}
                    disabled={creatingExpense}
                    className={`flex-1 px-4 py-2 rounded-lg text-[13px] font-semibold transition-colors disabled:opacity-40 ${exPayeeMode === "employee" ? "bg-amber-100 text-amber-800 border border-amber-300" : "bg-slate-50 text-slate-600 border border-slate-200 hover:bg-slate-100"}`}
                  >
                    Staff member
                  </button>
                  <button
                    type="button"
                    onClick={() => { setExPayeeMode("vendor"); setExEmployeeId(""); }}
                    disabled={creatingExpense}
                    className={`flex-1 px-4 py-2 rounded-lg text-[13px] font-semibold transition-colors disabled:opacity-40 ${exPayeeMode === "vendor" ? "bg-amber-100 text-amber-800 border border-amber-300" : "bg-slate-50 text-slate-600 border border-slate-200 hover:bg-slate-100"}`}
                  >
                    Other (vendor)
                  </button>
                </div>
              </div>

              {/* Payee value (employee select or free-text input) */}
              {exPayeeMode === "employee" ? (
                <div className="space-y-1">
                  <label className="block text-[12px] font-semibold text-slate-500 uppercase tracking-wider">Employee</label>
                  <select
                    value={exEmployeeId}
                    onChange={(e) => setExEmployeeId(e.target.value)}
                    disabled={creatingExpense}
                    className={inputCls(!!createExpenseFieldErrors.payee)}
                  >
                    <option value="">Select an employee…</option>
                    {activeEmployees.map((e) => (
                      <option key={e.id} value={e.id}>{e.fullName}</option>
                    ))}
                  </select>
                  {activeEmployees.length === 0 && (
                    <p className="text-[11.5px] text-amber-700">No active employees. Add one via the Employees page.</p>
                  )}
                  {createExpenseFieldErrors.payee && (
                    <p className="text-[11.5px] text-rose-600">{createExpenseFieldErrors.payee}</p>
                  )}
                </div>
              ) : (
                <div className="space-y-1">
                  <label className="block text-[12px] font-semibold text-slate-500 uppercase tracking-wider">Payee name</label>
                  <input
                    type="text"
                    value={exPayeeText}
                    onChange={(e) => setExPayeeText(e.target.value)}
                    list="expense-payee-suggestions"
                    placeholder="e.g. DESCO, Local Plumbing Store"
                    disabled={creatingExpense}
                    className={inputCls(!!createExpenseFieldErrors.payee)}
                  />
                  <datalist id="expense-payee-suggestions">
                    {payeesHistory.map((p) => (<option key={p} value={p} />))}
                  </datalist>
                  {createExpenseFieldErrors.payee && (
                    <p className="text-[11.5px] text-rose-600">{createExpenseFieldErrors.payee}</p>
                  )}
                </div>
              )}

              {/* Note */}
              <div className="space-y-1">
                <label className="block text-[12px] font-semibold text-slate-500 uppercase tracking-wider">Item description (optional)</label>
                <input
                  type="text"
                  value={exNote}
                  onChange={(e) => setExNote(e.target.value)}
                  placeholder="e.g. 4 aerosols for rooms"
                  disabled={creatingExpense}
                  className={inputCls(false)}
                />
              </div>

              {/* ── Inventory purchase toggle (Phase I-D) ─────────── */}
              <div className="flex items-center justify-between bg-indigo-50 border border-indigo-200 rounded-lg px-3 py-2.5">
                <div>
                  <p className="text-[13px] font-semibold text-indigo-800">This is an inventory purchase</p>
                  <p className="text-[11.5px] text-indigo-500 mt-0.5">Links this expense to an inventory item stock entry.</p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setExIsInventory(!exIsInventory);
                    setExInvItemId(""); setExInvItemSearch(""); setExInvQuantity(""); setExInvUnitPrice("");
                  }}
                  disabled={creatingExpense}
                  className={`relative flex-shrink-0 w-11 h-6 rounded-full transition-colors disabled:opacity-40 ${exIsInventory ? "bg-indigo-600" : "bg-slate-300"}`}
                  aria-pressed={exIsInventory}
                  aria-label="Toggle inventory purchase"
                >
                  <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${exIsInventory ? "translate-x-5" : "translate-x-0"}`} />
                </button>
              </div>

              {/* Inventory sub-form (visible when toggle is ON) */}
              {exIsInventory && (
                <div className="space-y-3 rounded-lg border border-indigo-200 bg-indigo-50/50 px-3 py-3">

                  {/* Item picker */}
                  <div className="space-y-1">
                    <label className="block text-[12px] font-semibold text-slate-500 uppercase tracking-wider">Inventory item</label>
                    <input
                      type="text"
                      list="inv-item-datalist"
                      value={exInvItemSearch}
                      onChange={(e) => {
                        const val = e.target.value;
                        setExInvItemSearch(val);
                        const match = inventoryItems.find((it) => it.name === val);
                        setExInvItemId(match ? match.id : "");
                        // auto-compute unit price when qty already entered
                        if (match && exInvQuantity) {
                          const qty = parseFloat(exInvQuantity);
                          const amt = parseFloat(exAmount) || 0;
                          if (qty > 0 && amt > 0) setExInvUnitPrice((amt / qty).toFixed(2));
                        }
                      }}
                      placeholder="Type to search items…"
                      disabled={creatingExpense}
                      className={inputCls(!!(createExpenseFieldErrors as Record<string,string>).invItem)}
                    />
                    <datalist id="inv-item-datalist">
                      {inventoryItems.filter((it) => it.isActive).map((it) => (
                        <option key={it.id} value={it.name} />
                      ))}
                    </datalist>
                    {(createExpenseFieldErrors as Record<string,string>).invItem && (
                      <p className="text-[11.5px] text-rose-600">{(createExpenseFieldErrors as Record<string,string>).invItem}</p>
                    )}
                    {!exInvItemId && exInvItemSearch.length > 0 && !(createExpenseFieldErrors as Record<string,string>).invItem && (
                      <p className="text-[11.5px] text-amber-700">No matching item — add it on the Inventory page first.</p>
                    )}
                  </div>

                  {/* Quantity + Unit price */}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <label className="block text-[12px] font-semibold text-slate-500 uppercase tracking-wider">Quantity</label>
                      <input
                        type="number"
                        inputMode="decimal"
                        step="0.01"
                        min="0.01"
                        value={exInvQuantity}
                        onChange={(e) => {
                          setExInvQuantity(e.target.value);
                          const qty = parseFloat(e.target.value);
                          const amt = parseFloat(exAmount) || 0;
                          if (qty > 0 && amt > 0) setExInvUnitPrice((amt / qty).toFixed(2));
                        }}
                        placeholder="e.g. 50"
                        disabled={creatingExpense}
                        className={inputCls(!!(createExpenseFieldErrors as Record<string,string>).invQty)}
                      />
                      {(createExpenseFieldErrors as Record<string,string>).invQty && (
                        <p className="text-[11.5px] text-rose-600">{(createExpenseFieldErrors as Record<string,string>).invQty}</p>
                      )}
                    </div>
                    <div className="space-y-1">
                      <label className="block text-[12px] font-semibold text-slate-500 uppercase tracking-wider">Unit price (৳)</label>
                      <input
                        type="number"
                        inputMode="decimal"
                        step="0.01"
                        min="0.01"
                        value={exInvUnitPrice}
                        onChange={(e) => setExInvUnitPrice(e.target.value)}
                        placeholder="auto"
                        disabled={creatingExpense}
                        className={inputCls(false)}
                      />
                    </div>
                  </div>

                  {/* Mismatch warning */}
                  {(() => {
                    const qty = parseFloat(exInvQuantity);
                    const up  = parseFloat(exInvUnitPrice);
                    const amt = parseFloat(exAmount) || 0;
                    if (qty > 0 && up > 0 && Math.abs(qty * up - amt) > 0.01) {
                      return (
                        <p className="text-[11.5px] text-amber-700">
                          Qty × unit price = ৳{(qty * up).toFixed(2)} — differs from expense amount ৳{amt.toFixed(2)}. This is allowed.
                        </p>
                      );
                    }
                    return null;
                  })()}
                </div>
              )}

              {/* Funding source notice */}
              <div className="bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-[11.5px] text-slate-500">
                Funded from <span className="font-semibold text-slate-700">Cash in Hand</span> (per accounts policy).
              </div>

              {/* Top-level error */}
              {createExpenseError && (
                <div className="bg-rose-50 border border-rose-200 rounded-lg px-3 py-2 text-[12px] text-rose-700">
                  {createExpenseError}
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-slate-200">
              <button
                type="button"
                onClick={closeExpenseModal}
                disabled={creatingExpense}
                className="px-4 py-2 rounded-lg text-slate-600 hover:bg-slate-100 text-[13px] font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleCreateExpense}
                disabled={creatingExpense}
                className="px-4 py-2 rounded-lg bg-slate-900 text-white text-[13px] font-semibold hover:bg-slate-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {creatingExpense ? "Saving…" : "Save Expense"}
              </button>
            </div>

          </div>
        </div>
      )}

    </div>
  );
}

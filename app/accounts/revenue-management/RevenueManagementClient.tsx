"use client";

// app/accounts/revenue-management/RevenueManagementClient.tsx
//
// Revenue Management page — Phase R-C ships the revenue entry modal
// and a daybook-style list view grouped by date.
//
// Mirror of Phase 4C ExpenseClient.tsx with differences:
//   - Default date filter: ALL-TIME newest-first (revenue is monthly;
//     today's revenue is usually empty). Expense defaults to today.
//   - Modal: bucket picker (4 accounts) instead of hardcoded Cash.
//   - Modal: no employee/vendor toggle — just a single required payee
//     free-text field with browser datalist autocomplete from history.
//   - Modal: no voucher generation; receipts (Phase R-D) are optional
//     and not built today.
//   - Theming: emerald (revenue = money in) vs expense's amber.
//
// State patterns copied from ExpenseClient for consistency.
//
// ─────────────────────────────────────────────────────────────

import { useState, useEffect } from "react";

import {
  createRevenueCategory,
  updateRevenueCategoryName,
  setRevenueCategoryActive,
  type RevenueCategory,
} from "@/services/revenueCategoriesService";

import {
  getRevenues,
  getDistinctRevenuePayees,
  createRevenue,
  type Revenue,
  type NewRevenue,
} from "@/services/revenueService";

import { type Account } from "@/services/accountsService";
import { useReferenceData } from "@/contexts/ReferenceDataContext";


// ── Input styling helper ───────────────────────────────────
function inputCls(hasError = false): string {
  return [
    "w-full px-3.5 py-2.5 text-[13.5px] text-slate-800 bg-white border rounded-lg",
    "placeholder:text-slate-300 focus:outline-none focus:ring-2 focus:ring-emerald-400 focus:border-transparent transition",
    hasError ? "border-rose-300 bg-rose-50" : "border-slate-200",
  ].join(" ");
}

// ── Date helpers ───────────────────────────────────────────

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatDateLabel(iso: string): string {
  const today = todayISO();
  const d = new Date(iso + "T00:00:00");
  const weekday  = d.toLocaleDateString("en-GB", { weekday: "short" });
  const day      = d.getDate();
  const month    = d.toLocaleDateString("en-GB", { month: "short" });
  const year     = d.getFullYear();
  const base = `${weekday} ${day} ${month} ${year}`;

  if (iso === today) return `Today, ${base}`;

  const yest = new Date();
  yest.setDate(yest.getDate() - 1);
  const yISO = `${yest.getFullYear()}-${String(yest.getMonth() + 1).padStart(2, "0")}-${String(yest.getDate()).padStart(2, "0")}`;
  if (iso === yISO) return `Yesterday, ${base}`;

  return base;
}

function formatAmount(n: number): string {
  return new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}


export default function RevenueManagementClient() {
  // ── Data ───────────────────────────────────────────────────
  // Revenue categories + account definitions come from the session-level
  // reference cache. `categories` is aliased so existing reads are unchanged;
  // category mutations call refreshRevenueCategories() to propagate edits.
  const { revenueCategories: categories, accountDefs: accounts, refreshRevenueCategories } = useReferenceData();
  const [revenues,       setRevenues]       = useState<Revenue[]>([]);
  const [payeesHistory,  setPayeesHistory]  = useState<string[]>([]);

  // ── Load state ─────────────────────────────────────────────
  const [fetching,   setFetching]   = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // ── Filter state ───────────────────────────────────────────
  // Default: all-time, newest-first. User can narrow.
  const [filterFromDate, setFilterFromDate] = useState<string>("");
  const [filterToDate,   setFilterToDate]   = useState<string>("");

  // ── Manage Categories modal (Phase R-B, unchanged) ─────────
  const [categoryModalOpen, setCategoryModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const [newCategoryName, setNewCategoryName] = useState("");
  const [creatingCategory, setCreatingCategory] = useState(false);
  const [createCategoryError, setCreateCategoryError] = useState<string | null>(null);

  const [togglingId, setTogglingId] = useState<string | null>(null);

  // ── Add Revenue modal (Phase R-C, NEW) ─────────────────────
  const [revenueModalOpen, setRevenueModalOpen] = useState(false);
  const [rvTxnDate,     setRvTxnDate]     = useState<string>(todayISO());
  const [rvAmount,      setRvAmount]      = useState<string>("");
  const [rvAccountId,   setRvAccountId]   = useState<string>("");
  const [rvCategoryId,  setRvCategoryId]  = useState<string>("");
  const [rvPayee,       setRvPayee]       = useState<string>("");
  const [rvNote,        setRvNote]        = useState<string>("");

  const [creatingRevenue, setCreatingRevenue] = useState(false);
  const [createRevenueError, setCreateRevenueError] = useState<string | null>(null);
  const [createRevenueFieldErrors, setCreateRevenueFieldErrors] = useState<{
    amount?:   string;
    account?:  string;
    category?: string;
    payee?:    string;
  }>({});

  // ── Success banner ─────────────────────────────────────────
  const [successMsg, setSuccessMsg] = useState("");

  // ── Load on mount ──────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [revs, payeesH] = await Promise.all([
          getRevenues({}),
          getDistinctRevenuePayees(),
        ]);
        if (cancelled) return;
        setRevenues(revs);
        // categories + accounts come from the reference cache (no per-mount fetch).
        setPayeesHistory(payeesH);
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
  }, []);

  // ── Refetch revenues when filter changes ───────────────────
  useEffect(() => {
    if (fetching) return;
    let cancelled = false;
    (async () => {
      try {
        const revs = await getRevenues({
          fromDate: filterFromDate || undefined,
          toDate:   filterToDate   || undefined,
        });
        if (!cancelled) setRevenues(revs);
      } catch (err) {
        console.error("[RevenueManagementClient] refilter failed:", err);
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
      } else if (revenueModalOpen && !creatingRevenue) {
        closeRevenueModal();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categoryModalOpen, revenueModalOpen, savingEdit, creatingCategory, togglingId, creatingRevenue]);

  // ── Lookup maps ────────────────────────────────────────────
  const categoryById = new Map(categories.map(c => [c.id, c]));
  const accountById  = new Map(accounts.map(a => [a.id, a]));

  const activeCategories = categories.filter(c => c.isActive);
  const spendableAccounts = accounts; // for revenue, all accounts are valid receivers
                                       // (is_spendable applies to expense source only)

  // ── Category Modal helpers (Phase R-B logic, unchanged) ────
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

  // ── Revenue Modal helpers ──────────────────────────────────
  function openRevenueModal() {
    setRevenueModalOpen(true);
    setRvTxnDate(todayISO());
    setRvAmount("");
    setRvAccountId("");
    setRvCategoryId("");
    setRvPayee("");
    setRvNote("");
    setCreateRevenueError(null);
    setCreateRevenueFieldErrors({});
  }
  function closeRevenueModal() {
    if (creatingRevenue) return;
    setRevenueModalOpen(false);
  }

  // ── Reload helpers ─────────────────────────────────────────
  // Re-pull the shared revenue-category cache (read-only). The aliased
  // `categories` updates from the cache, propagating the edit to every page.
  async function reloadCategories() {
    await refreshRevenueCategories();
  }
  async function reloadRevenues() {
    try {
      const [revs, payeesH] = await Promise.all([
        getRevenues({
          fromDate: filterFromDate || undefined,
          toDate:   filterToDate   || undefined,
        }),
        getDistinctRevenuePayees(),
      ]);
      setRevenues(revs);
      setPayeesHistory(payeesH);
    } catch (err) {
      console.error("[RevenueManagementClient] reloadRevenues failed:", err);
    }
  }

  // ── Category Handlers (R-B logic, unchanged behavior) ──────
  async function handleCreateCategory() {
    const trimmed = newCategoryName.trim();
    if (!trimmed) { setCreateCategoryError("Name is required."); return; }
    setCreateCategoryError(null);
    setCreatingCategory(true);
    try {
      await createRevenueCategory(trimmed);
      setNewCategoryName("");
      setSuccessMsg(`Category "${trimmed}" created.`);
      await reloadCategories();
    } catch (err) {
      setCreateCategoryError(err instanceof Error ? err.message : "Create failed.");
    } finally {
      setCreatingCategory(false);
    }
  }
  function startEdit(c: RevenueCategory) {
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
      await updateRevenueCategoryName(editingId, trimmed);
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
  async function handleToggleActive(c: RevenueCategory) {
    setTogglingId(c.id);
    try {
      await setRevenueCategoryActive(c.id, !c.isActive);
      setSuccessMsg(`Category "${c.name}" ${c.isActive ? "deactivated" : "reactivated"}.`);
      await reloadCategories();
    } catch (err) {
      console.error("[RevenueManagementClient] toggle failed:", err);
    } finally {
      setTogglingId(null);
    }
  }

  // ── Revenue Handler ────────────────────────────────────────
  async function handleCreateRevenue() {
    const fieldErrors: { amount?: string; account?: string; category?: string; payee?: string } = {};
    const amountNum = parseFloat(rvAmount);
    if (!rvAmount.trim() || isNaN(amountNum) || amountNum <= 0) {
      fieldErrors.amount = "Amount must be a positive number.";
    }
    if (!rvAccountId)   fieldErrors.account  = "Choose where the money was received.";
    if (!rvCategoryId)  fieldErrors.category = "Category is required.";
    if (!rvPayee.trim()) fieldErrors.payee   = "Payee is required.";

    if (Object.keys(fieldErrors).length > 0) {
      setCreateRevenueFieldErrors(fieldErrors);
      return;
    }
    setCreateRevenueFieldErrors({});
    setCreateRevenueError(null);
    setCreatingRevenue(true);

    try {
      const input: NewRevenue = {
        txnDate:           rvTxnDate,
        amount:            amountNum,
        toAccountId:       rvAccountId,
        revenueCategoryId: rvCategoryId,
        payee:             rvPayee.trim(),
        note:              rvNote.trim() || undefined,
      };
      await createRevenue(input);
      setSuccessMsg(`Revenue from "${rvPayee.trim()}" recorded.`);
      closeRevenueModal();
      await reloadRevenues();
    } catch (err) {
      setCreateRevenueError(err instanceof Error ? err.message : "Create failed.");
    } finally {
      setCreatingRevenue(false);
    }
  }

  // ── Group revenues by date for daybook layout ──────────────
  function groupByDate(list: Revenue[]): Array<{ date: string; rows: Revenue[]; total: number }> {
    const byDate = new Map<string, Revenue[]>();
    for (const r of list) {
      if (!byDate.has(r.txnDate)) byDate.set(r.txnDate, []);
      byDate.get(r.txnDate)!.push(r);
    }
    return Array.from(byDate.entries())
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([date, rows]) => ({
        date,
        rows,
        total: rows.reduce((sum, r) => sum + r.amount, 0),
      }));
  }
  const groups = groupByDate(revenues);

  // ── Loading / Error states ─────────────────────────────────
  if (fetching) {
    return (
      <div className="p-8">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold text-slate-800">Revenue Management</h1>
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
          <h1 className="text-2xl font-semibold text-slate-800">Revenue Management</h1>
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
        <h1 className="text-2xl font-semibold text-slate-800">Revenue Management</h1>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={openCategoryModal}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-white border border-slate-200 text-slate-700 text-[13px] font-semibold hover:bg-slate-50 hover:border-slate-300 transition-colors"
            title="Manage revenue categories"
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
            onClick={openRevenueModal}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-700 text-white text-[13px] font-semibold hover:bg-emerald-800 transition-colors"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" className="w-4 h-4">
              <path d="M12 5v14M5 12h14" />
            </svg>
            Add Revenue
          </button>
        </div>
      </div>

      {/* ── Date filter ─────────────────────────────────────── */}
      <div className="flex items-center gap-3 bg-white border border-slate-200 rounded-xl px-4 py-3">
        <span className="text-[12px] font-semibold text-slate-500 uppercase tracking-wider">From</span>
        <input
          type="date"
          value={filterFromDate}
          max={filterToDate || undefined}
          onChange={(e) => setFilterFromDate(e.target.value)}
          className="px-2.5 py-1.5 text-[13px] text-slate-800 bg-white border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-400"
        />
        <span className="text-[12px] font-semibold text-slate-500 uppercase tracking-wider">To</span>
        <input
          type="date"
          value={filterToDate}
          min={filterFromDate || undefined}
          onChange={(e) => setFilterToDate(e.target.value)}
          className="px-2.5 py-1.5 text-[13px] text-slate-800 bg-white border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-emerald-400"
        />
        <button
          type="button"
          onClick={() => { setFilterFromDate(""); setFilterToDate(""); }}
          className="ml-2 px-3 py-1.5 text-[12.5px] text-slate-600 hover:bg-slate-100 rounded-md font-medium transition-colors"
          title="Clear the filter to see all-time"
        >
          All time
        </button>
        <div className="ml-auto text-[12.5px] text-slate-500">
          {revenues.length} {revenues.length === 1 ? "entry" : "entries"}
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
            <path d="M12 2v20M5 9l7-7 7 7M5 15l7 7 7-7"/>
          </svg>
          <p className="text-[14px] font-semibold text-slate-600 mb-1">No revenue in this date range</p>
          <p className="text-[12.5px] text-slate-400 max-w-md">
            Click <span className="font-semibold text-slate-600">Add Revenue</span> to record one,
            or widen the date filter.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {groups.map((g) => (
            <div key={g.date} className="rounded-xl border border-slate-200 bg-white overflow-hidden">
              <div className="flex items-center justify-between px-5 py-3 bg-slate-50 border-b border-slate-200">
                <h3 className="text-[13.5px] font-semibold text-slate-700">{formatDateLabel(g.date)}</h3>
                <span className="text-[12.5px] text-slate-500">
                  <span className="font-semibold text-emerald-700">৳{formatAmount(g.total)}</span>{" "}
                  · {g.rows.length} {g.rows.length === 1 ? "entry" : "entries"}
                </span>
              </div>
              <ul className="divide-y divide-slate-100">
                {g.rows.map((r) => {
                  const cat = r.revenueCategoryId ? categoryById.get(r.revenueCategoryId) : undefined;
                  const acct = r.toAccountId ? accountById.get(r.toAccountId) : undefined;
                  return (
                    <li key={r.id} className="px-5 py-3.5 flex items-center gap-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-3">
                          <span className="text-[14px] font-semibold text-emerald-700">+ ৳{formatAmount(r.amount)}</span>
                          <span className="px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 text-[11px] font-semibold uppercase tracking-wider border border-emerald-100">
                            {cat?.name ?? "—"}
                          </span>
                          <span className="text-[12.5px] text-slate-600 font-medium truncate">{r.payee}</span>
                          <span className="text-[11px] text-slate-400">
                            → {acct?.name ?? "—"}
                          </span>
                        </div>
                        {r.note && (
                          <p className="mt-1 text-[12px] text-slate-400 truncate">{r.note}</p>
                        )}
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
      {/* MANAGE CATEGORIES MODAL (Phase R-B, unchanged)          */}
      {/* ────────────────────────────────────────────────────── */}
      {categoryModalOpen && (
        <div className="fixed inset-0 bg-slate-900/40 flex items-center justify-center z-50 p-6" onClick={closeCategoryModal}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
              <h2 className="text-[15px] font-semibold text-slate-800">Manage Revenue Categories</h2>
              <button type="button" onClick={closeCategoryModal} disabled={!!(savingEdit || creatingCategory || togglingId)} className="text-slate-400 hover:text-slate-700 disabled:opacity-40 disabled:cursor-not-allowed" aria-label="Close">
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
                  placeholder="e.g. Shop Rent"
                  disabled={creatingCategory}
                  className={inputCls(!!createCategoryError)}
                />
                <button
                  type="button"
                  onClick={handleCreateCategory}
                  disabled={creatingCategory || !newCategoryName.trim()}
                  className="px-4 py-2.5 rounded-lg bg-emerald-700 text-white text-[13px] font-semibold hover:bg-emerald-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap"
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
                            <button type="button" onClick={handleSaveEdit} disabled={savingEdit || !editingValue.trim()} className="px-3 py-2 rounded-lg bg-emerald-700 text-white text-[12.5px] font-semibold hover:bg-emerald-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap">
                              {savingEdit ? "Saving…" : "Save"}
                            </button>
                            <button type="button" onClick={cancelEdit} disabled={savingEdit} className="px-3 py-2 rounded-lg text-slate-500 hover:bg-slate-100 text-[12.5px] font-medium transition-colors disabled:opacity-40">
                              Cancel
                            </button>
                          </>
                        ) : (
                          <>
                            <button type="button" onClick={() => startEdit(c)} className="flex-1 text-left text-[13.5px] font-medium text-slate-800 hover:text-emerald-700 transition-colors" title="Click to rename">
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
      {/* ADD REVENUE MODAL (Phase R-C, NEW)                      */}
      {/* ────────────────────────────────────────────────────── */}
      {revenueModalOpen && (
        <div className="fixed inset-0 bg-slate-900/40 flex items-center justify-center z-50 p-6" onClick={closeRevenueModal}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-xl max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>

            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
              <h2 className="text-[15px] font-semibold text-slate-800">Add Revenue</h2>
              <button type="button" onClick={closeRevenueModal} disabled={creatingRevenue} className="text-slate-400 hover:text-slate-700 disabled:opacity-40 disabled:cursor-not-allowed" aria-label="Close">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-5 h-5"><path d="M18 6L6 18M6 6l12 12" /></svg>
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">

              {/* Date + Amount */}
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="block text-[12px] font-semibold text-slate-500 uppercase tracking-wider">Date</label>
                  <input
                    type="date"
                    value={rvTxnDate}
                    max={todayISO()}
                    onChange={(e) => setRvTxnDate(e.target.value)}
                    disabled={creatingRevenue}
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
                    value={rvAmount}
                    onChange={(e) => setRvAmount(e.target.value)}
                    placeholder="0.00"
                    disabled={creatingRevenue}
                    className={inputCls(!!createRevenueFieldErrors.amount)}
                  />
                  {createRevenueFieldErrors.amount && (
                    <p className="text-[11.5px] text-rose-600">{createRevenueFieldErrors.amount}</p>
                  )}
                </div>
              </div>

              {/* Received to (bucket) */}
              <div className="space-y-1">
                <label className="block text-[12px] font-semibold text-slate-500 uppercase tracking-wider">Received in</label>
                <select
                  value={rvAccountId}
                  onChange={(e) => setRvAccountId(e.target.value)}
                  disabled={creatingRevenue}
                  className={inputCls(!!createRevenueFieldErrors.account)}
                >
                  <option value="">Select bucket…</option>
                  {spendableAccounts.map((a) => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
                {createRevenueFieldErrors.account && (
                  <p className="text-[11.5px] text-rose-600">{createRevenueFieldErrors.account}</p>
                )}
              </div>

              {/* Category */}
              <div className="space-y-1">
                <label className="block text-[12px] font-semibold text-slate-500 uppercase tracking-wider">Category</label>
                <select
                  value={rvCategoryId}
                  onChange={(e) => setRvCategoryId(e.target.value)}
                  disabled={creatingRevenue}
                  className={inputCls(!!createRevenueFieldErrors.category)}
                >
                  <option value="">Select a category…</option>
                  {activeCategories.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
                {activeCategories.length === 0 && (
                  <p className="text-[11.5px] text-amber-700">No active categories. Add one via "Manage Categories" first.</p>
                )}
                {createRevenueFieldErrors.category && (
                  <p className="text-[11.5px] text-rose-600">{createRevenueFieldErrors.category}</p>
                )}
              </div>

              {/* Payee */}
              <div className="space-y-1">
                <label className="block text-[12px] font-semibold text-slate-500 uppercase tracking-wider">Payee (tenant / source)</label>
                <input
                  type="text"
                  value={rvPayee}
                  onChange={(e) => setRvPayee(e.target.value)}
                  list="revenue-payee-suggestions"
                  placeholder="e.g. ABC Restaurant, XYZ Telecom"
                  disabled={creatingRevenue}
                  className={inputCls(!!createRevenueFieldErrors.payee)}
                />
                <datalist id="revenue-payee-suggestions">
                  {payeesHistory.map((p) => (<option key={p} value={p} />))}
                </datalist>
                {createRevenueFieldErrors.payee && (
                  <p className="text-[11.5px] text-rose-600">{createRevenueFieldErrors.payee}</p>
                )}
              </div>

              {/* Note */}
              <div className="space-y-1">
                <label className="block text-[12px] font-semibold text-slate-500 uppercase tracking-wider">Description (optional)</label>
                <input
                  type="text"
                  value={rvNote}
                  onChange={(e) => setRvNote(e.target.value)}
                  placeholder="e.g. May rent, Q2 advance"
                  disabled={creatingRevenue}
                  className={inputCls(false)}
                />
              </div>

              {/* Top-level error */}
              {createRevenueError && (
                <div className="bg-rose-50 border border-rose-200 rounded-lg px-3 py-2 text-[12px] text-rose-700">
                  {createRevenueError}
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-slate-200">
              <button type="button" onClick={closeRevenueModal} disabled={creatingRevenue} className="px-4 py-2 rounded-lg text-slate-600 hover:bg-slate-100 text-[13px] font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                Cancel
              </button>
              <button type="button" onClick={handleCreateRevenue} disabled={creatingRevenue} className="px-4 py-2 rounded-lg bg-emerald-700 text-white text-[13px] font-semibold hover:bg-emerald-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                {creatingRevenue ? "Saving…" : "Save Revenue"}
              </button>
            </div>

          </div>
        </div>
      )}

    </div>
  );
}

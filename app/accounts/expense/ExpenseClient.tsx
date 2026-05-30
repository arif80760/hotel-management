"use client";

// app/accounts/expense/ExpenseClient.tsx
//
// Expense Management page — Phase 4B (categories admin) ships first.
// 4C wires the "Add Expense" button. 4D adds the voucher route.
//
// Layout:
//   - Header: "Expense" title + two buttons (Manage Categories, Add Expense)
//   - Body: placeholder for the expense list (built in 4C)
//   - Manage Categories modal: list, inline rename, active toggle, create
//
// State patterns copied from app/accounts/cashbook/CashbookClient.tsx:
//   - useState declarations grouped by concern
//   - Modal pattern: open/close + saving + errors
//   - Inline editing via per-row editingId state
//   - Escape closes the modal when not saving
//
// ─────────────────────────────────────────────────────────────

import { useState, useEffect, useRef } from "react";
import {
  getExpenseCategories,
  createExpenseCategory,
  updateExpenseCategoryName,
  setExpenseCategoryActive,
  type ExpenseCategory,
} from "@/services/expenseCategoriesService";

// ── Input styling helper (copied from CashbookClient — same convention) ──
function inputCls(hasError = false): string {
  return [
    "w-full px-3.5 py-2.5 text-[13.5px] text-slate-800 bg-white border rounded-lg",
    "placeholder:text-slate-300 focus:outline-none focus:ring-2 focus:ring-amber-400 focus:border-transparent transition",
    hasError ? "border-rose-300 bg-rose-50" : "border-slate-200",
  ].join(" ");
}


export default function ExpenseClient() {
  // ── Data ───────────────────────────────────────────────────
  const [categories, setCategories] = useState<ExpenseCategory[]>([]);

  // ── Load state ─────────────────────────────────────────────
  const [fetching,   setFetching]   = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // ── Manage Categories modal ────────────────────────────────
  const [categoryModalOpen, setCategoryModalOpen] = useState(false);
  // editingId: null = no inline edit; UUID = the row currently in edit mode.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  // ── Create category (inline-input at top of modal) ─────────
  const [newCategoryName, setNewCategoryName] = useState("");
  const [creatingCategory, setCreatingCategory] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // ── Per-row toggle state (active/inactive flip) ────────────
  // togglingId: UUID of the row whose toggle is currently in flight.
  const [togglingId, setTogglingId] = useState<string | null>(null);

  // ── Success banner ─────────────────────────────────────────
  const [successMsg, setSuccessMsg] = useState("");

  // ── Load on mount ──────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const cats = await getExpenseCategories();
        if (!cancelled) setCategories(cats);
      } catch (err) {
        if (!cancelled) {
          setFetchError(err instanceof Error ? err.message : "Failed to load categories.");
        }
      } finally {
        if (!cancelled) setFetching(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  // ── Auto-clear success banner ──────────────────────────────
  useEffect(() => {
    if (!successMsg) return;
    const t = setTimeout(() => setSuccessMsg(""), 4000);
    return () => clearTimeout(t);
  }, [successMsg]);

  // ── Escape closes the modal (when nothing is saving) ───────
  useEffect(() => {
    if (!categoryModalOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !savingEdit && !creatingCategory && !togglingId) {
        closeModal();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [categoryModalOpen, savingEdit, creatingCategory, togglingId]);

  // ── Modal helpers ──────────────────────────────────────────
  function openModal() {
    setCategoryModalOpen(true);
    setEditingId(null);
    setEditingValue("");
    setEditError(null);
    setNewCategoryName("");
    setCreateError(null);
  }
  function closeModal() {
    if (savingEdit || creatingCategory || togglingId) return;
    setCategoryModalOpen(false);
  }

  // ── Refresh categories from server ─────────────────────────
  async function reloadCategories() {
    try {
      const cats = await getExpenseCategories();
      setCategories(cats);
    } catch (err) {
      console.error("[ExpenseClient] reload failed:", err);
    }
  }

  // ── Handlers ───────────────────────────────────────────────
  async function handleCreate() {
    const trimmed = newCategoryName.trim();
    if (!trimmed) {
      setCreateError("Name is required.");
      return;
    }
    setCreateError(null);
    setCreatingCategory(true);
    try {
      await createExpenseCategory(trimmed);
      setNewCategoryName("");
      setSuccessMsg(`Category "${trimmed}" created.`);
      await reloadCategories();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Create failed.");
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
    if (!trimmed) {
      setEditError("Name is required.");
      return;
    }
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
      setSuccessMsg(""); // suppress success when failed
    } finally {
      setTogglingId(null);
    }
  }

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

  // ── Loaded ─────────────────────────────────────────────────
  return (
    <div className="p-8 space-y-5">

      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-slate-800">Expense</h1>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={openModal}
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
            disabled
            title="Coming in Phase 4C"
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-900 text-white text-[13px] font-semibold hover:bg-slate-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" className="w-4 h-4">
              <path d="M12 5v14M5 12h14" />
            </svg>
            Add Expense
          </button>
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

      {/* ── Body placeholder (4C will replace this with expense list) ──── */}
      <div className="rounded-xl border border-dashed border-slate-200 bg-white px-6 py-12 flex flex-col items-center justify-center text-center">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="w-8 h-8 text-slate-300 mb-3">
          <rect x="3" y="6" width="18" height="14" rx="2" />
          <path d="M3 10h18" />
          <path d="M7 14h4" />
          <path d="M7 17h7" />
        </svg>
        <p className="text-[14px] font-semibold text-slate-600 mb-1">Expense entries</p>
        <p className="text-[12.5px] text-slate-400 max-w-md">
          The Add Expense flow ships in the next phase. Categories are managed via the button above.
        </p>
      </div>

      {/* ── Manage Categories modal ─────────────────────────── */}
      {categoryModalOpen && (
        <div
          className="fixed inset-0 bg-slate-900/40 flex items-center justify-center z-50 p-6"
          onClick={closeModal}
        >
          <div
            className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[85vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
              <h2 className="text-[15px] font-semibold text-slate-800">Manage Categories</h2>
              <button
                type="button"
                onClick={closeModal}
                disabled={!!(savingEdit || creatingCategory || togglingId)}
                className="text-slate-400 hover:text-slate-700 disabled:opacity-40 disabled:cursor-not-allowed"
                aria-label="Close"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-5 h-5">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Create new category */}
            <div className="px-5 py-4 border-b border-slate-200 space-y-2">
              <label className="block text-[12px] font-semibold text-slate-500 uppercase tracking-wider">Add category</label>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={newCategoryName}
                  onChange={(e) => setNewCategoryName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") handleCreate(); }}
                  placeholder="e.g. Room Supplies"
                  disabled={creatingCategory}
                  className={inputCls(!!createError)}
                />
                <button
                  type="button"
                  onClick={handleCreate}
                  disabled={creatingCategory || !newCategoryName.trim()}
                  className="px-4 py-2.5 rounded-lg bg-slate-900 text-white text-[13px] font-semibold hover:bg-slate-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap"
                >
                  {creatingCategory ? "Adding…" : "Add"}
                </button>
              </div>
              {createError && (
                <p className="text-[12px] text-rose-600">{createError}</p>
              )}
            </div>

            {/* Category list */}
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
                      <li
                        key={c.id}
                        className={`py-3 flex items-center gap-3 ${c.isActive ? "" : "opacity-60"}`}
                      >
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
                            <button
                              type="button"
                              onClick={handleSaveEdit}
                              disabled={savingEdit || !editingValue.trim()}
                              className="px-3 py-2 rounded-lg bg-slate-900 text-white text-[12.5px] font-semibold hover:bg-slate-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap"
                            >
                              {savingEdit ? "Saving…" : "Save"}
                            </button>
                            <button
                              type="button"
                              onClick={cancelEdit}
                              disabled={savingEdit}
                              className="px-3 py-2 rounded-lg text-slate-500 hover:bg-slate-100 text-[12.5px] font-medium transition-colors disabled:opacity-40"
                            >
                              Cancel
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              type="button"
                              onClick={() => startEdit(c)}
                              className="flex-1 text-left text-[13.5px] font-medium text-slate-800 hover:text-amber-700 transition-colors"
                              title="Click to rename"
                            >
                              {c.name}
                            </button>
                            {!c.isActive && (
                              <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 text-[10.5px] font-semibold uppercase tracking-wider">
                                Inactive
                              </span>
                            )}
                            <button
                              type="button"
                              onClick={() => handleToggleActive(c)}
                              disabled={isToggling}
                              className={`px-3 py-1.5 rounded-md text-[11.5px] font-semibold uppercase tracking-wider transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                                c.isActive
                                  ? "bg-slate-100 text-slate-600 hover:bg-slate-200"
                                  : "bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
                              }`}
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
              {editError && editingId && (
                <p className="mt-2 text-[12px] text-rose-600">{editError}</p>
              )}
            </div>

            {/* Modal footer */}
            <div className="flex items-center justify-end px-5 py-3 border-t border-slate-200">
              <button
                type="button"
                onClick={closeModal}
                disabled={!!(savingEdit || creatingCategory || togglingId)}
                className="px-4 py-2 rounded-lg text-slate-600 hover:bg-slate-100 text-[13px] font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
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

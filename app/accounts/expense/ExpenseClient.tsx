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

import { useState, useEffect, useRef } from "react";

import {
  createExpenseCategory,
  updateExpenseCategoryName,
  updateExpenseCategoryKind,
  setExpenseCategoryActive,
  resolveRemunerationCategoryId,
  type ExpenseCategory,
} from "@/services/expenseCategoriesService";
import { useReferenceData } from "@/contexts/ReferenceDataContext";

import {
  getExpenseItems,
  createExpenseItem,
  updateExpenseItemName,
  updateExpenseItemCategory,
  updateExpenseItemInventoryLink,
  setExpenseItemActive,
  type ExpenseItem,
} from "@/services/expenseItemsService";

import {
  getExpenses,
  getDistinctPayees,
  createExpense,
  editExpense,
  type Expense,
  type NewExpense,
} from "@/services/expensesService";

import { getDayCloseStatus } from "@/services/dayCloseService";

import {
  getAllEmployees,
  type Employee,
} from "@/services/employeesService";

import {
  getInventoryItems,
  createInventoryItem,
  createPurchaseMovement,
  type InventoryItem,
  type InventoryItemType,
  type InventoryItemUnit,
  type NewInventoryItem,
} from "@/services/inventoryService";

import {
  getInventoryCategories,
  type InventoryCategory,
} from "@/services/inventoryCategoriesService";


// ── Input styling helper ───────────────────────────────────
function inputCls(hasError = false): string {
  return [
    "w-full px-3.5 py-2.5 text-[13.5px] text-slate-800 bg-white border rounded-lg",
    "placeholder:text-slate-300 focus:outline-none focus:ring-2 focus:ring-amber-400 focus:border-transparent transition",
    hasError ? "border-rose-300 bg-rose-50" : "border-slate-200",
  ].join(" ");
}

// ── Date helpers ───────────────────────────────────────────

// pad/isoDate copied from ProfitLossClient — SAME plain-local date semantics
// as the Revenue Report and P&L (no new date maths).
function pad(n: number): string { return String(n).padStart(2, "0"); }
function isoDate(y: number, m: number, d: number): string { return `${y}-${pad(m)}-${pad(d)}`; }

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


// Categories whose expenses never carry an item: resolved by system_key /
// kind ONLY (names are user-renameable and must never be matched).
// 'commission' is reserved — tag the Commission category with
// system_key='commission' live for it to take effect.
const NO_ITEM_PICKER_KEYS = new Set(["salary", "remuneration", "commission"]);

// ── ItemCombobox ─────────────────────────────────────────────
// Styled replacement for the OS-native <datalist> pickers in the Add
// Expense modal. Fully controlled: the parent owns both the selected id
// and the free-typed query (the inventory picker's "create new item"
// flow needs the typed text after the panel closes). The options panel
// is position:fixed so the modal body's overflow can't clip it — safe
// here because the expense modal overlay has no backdrop-blur (a
// backdrop-filter would make the overlay the containing block for
// fixed descendants; see CLAUDE.md). z-[60] = above the z-50 modal.
type ComboOption = { id: string; label: string };

function ItemCombobox({
  options,
  valueId,
  query,
  placeholder,
  disabled,
  invalid,
  emptyText,
  onQueryChange,
  onSelect,
}: {
  options: ComboOption[];
  valueId: string;                      // "" = nothing selected
  query: string;                        // free-typed filter text
  placeholder: string;
  disabled?: boolean;
  invalid?: boolean;
  emptyText: string;                    // shown when options is empty
  onQueryChange: (q: string) => void;   // typing (parent clears valueId)
  onSelect: (opt: ComboOption | null) => void; // null = cleared via ✕
}) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [rect, setRect] = useState<{ top: number; left: number; width: number } | null>(null);
  const wrapRef  = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const selected = valueId ? options.find((o) => o.id === valueId) ?? null : null;
  const q = query.trim().toLowerCase();
  // With a selection the field shows its label, so don't filter by it —
  // the full list stays visible for re-picking.
  const filtered = selected || !q ? options : options.filter((o) => o.label.toLowerCase().includes(q));

  const openPanel = () => {
    if (disabled) return;
    const r = wrapRef.current?.getBoundingClientRect();
    if (r) setRect({ top: r.bottom + 6, left: r.left, width: r.width });
    setHighlight(0);
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (wrapRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    // The panel is fixed, so any outer scroll would detach it from the
    // field — close instead. Scrolls inside the panel itself are fine.
    const onScroll = (e: Event) => {
      if (panelRef.current && e.target instanceof Node && panelRef.current.contains(e.target)) return;
      setOpen(false);
    };
    const onResize = () => setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  useEffect(() => { setHighlight(0); }, [query]);

  useEffect(() => {
    if (!open) return;
    const el = panelRef.current?.children[highlight] as HTMLElement | undefined;
    el?.scrollIntoView?.({ block: "nearest" });
  }, [highlight, open]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) openPanel();
      else setHighlight((h) => Math.min(h + 1, Math.max(filtered.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (open) setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      if (open) {
        e.preventDefault(); // don't submit the form while picking
        const o = filtered[highlight];
        if (o) { onSelect(o); setOpen(false); }
      }
    } else if (e.key === "Escape") {
      if (open) {
        e.stopPropagation(); // close the panel, not the modal
        setOpen(false);
      }
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  };

  return (
    <div ref={wrapRef} className="relative">
      <input
        type="text"
        value={selected ? selected.label : query}
        onChange={(e) => { onQueryChange(e.target.value); if (!open) openPanel(); }}
        onClick={openPanel}
        onFocus={openPanel}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete="off"
        role="combobox"
        aria-expanded={open}
        className={inputCls(!!invalid) + (selected || query.length > 0 ? " pr-14" : " pr-9")}
      />
      {/* Chevron — decorative; clicks fall through to the input */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-slate-400"
      >
        <svg
          viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          strokeLinecap="round" strokeLinejoin="round"
          className={`w-4 h-4 transition-transform duration-150 ${open ? "rotate-180" : ""}`}
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </span>
      {(selected || query.length > 0) && !disabled && (
        <button
          type="button"
          aria-label="Clear selection"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => { onSelect(null); onQueryChange(""); setOpen(false); }}
          className="absolute right-8 top-1/2 -translate-y-1/2 p-0.5 rounded text-slate-300 hover:text-slate-500 transition-colors"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="w-3.5 h-3.5">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      )}
      {open && rect && (
        <>
          <style>{`@keyframes ex-combo-in { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }`}</style>
          <div
            ref={panelRef}
            style={{
              position: "fixed", top: rect.top, left: rect.left, width: rect.width, zIndex: 60,
              animation: "ex-combo-in 130ms ease-out",
            }}
            className="max-h-60 overflow-y-auto rounded-xl border border-slate-300 bg-white shadow-xl p-1.5"
          >
            {options.length === 0 ? (
              <div className="px-3 py-2.5 text-[13px] text-slate-400 italic">{emptyText}</div>
            ) : filtered.length === 0 ? (
              <div className="px-3 py-2.5 text-[13px] text-slate-400 italic">No matches.</div>
            ) : (
              filtered.map((o, idx) => (
                <button
                  key={o.id}
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => { onSelect(o); setOpen(false); }}
                  onMouseEnter={() => setHighlight(idx)}
                  className={`flex items-center gap-2 w-full text-left px-3 py-2.5 text-[13px] rounded-lg transition-colors duration-100 ${
                    idx === highlight
                      ? "bg-amber-500 text-white font-medium"
                      : o.id === valueId
                        ? "bg-amber-50 text-amber-900 font-semibold"
                        : "text-slate-700"
                  }`}
                >
                  <span className="flex-1 min-w-0 truncate">{o.label}</span>
                  {o.id === valueId && (
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={`w-4 h-4 shrink-0 ${idx === highlight ? "text-white" : "text-amber-600"}`}>
                      <path d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                </button>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}

export default function ExpenseClient() {
  // ── Data ───────────────────────────────────────────────────
  // Expense categories come from the session-level reference cache; aliased to
  // `categories` so existing reads are unchanged. Category mutations below call
  // refreshExpenseCategories() so edits propagate here and to other pages.
  const { expenseCategories: categories, refreshExpenseCategories } = useReferenceData();
  const [expenses,        setExpenses]        = useState<Expense[]>([]);
  const [employees,       setEmployees]       = useState<Employee[]>([]);
  const [payeesHistory,   setPayeesHistory]   = useState<string[]>([]);
  const [inventoryItems,  setInventoryItems]  = useState<InventoryItem[]>([]);

  // ── Load state ─────────────────────────────────────────────
  const [fetching,   setFetching]   = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // ── Filter state ───────────────────────────────────────────
  const [filterFromDate, setFilterFromDate] = useState<string>(todayISO());
  const [filterToDate,   setFilterToDate]   = useState<string>(todayISO());

  // ── Period selector + search (STEP 4) ──────────────────────
  const [periodMode,  setPeriodMode]  = useState<"daily" | "monthly" | "yearly" | "custom">("daily");
  const [periodDay,   setPeriodDay]   = useState<string>(todayISO());
  const [periodMonth, setPeriodMonth] = useState<string>(todayISO().slice(0, 7));  // "YYYY-MM"
  const [periodYear,  setPeriodYear]  = useState<string>(todayISO().slice(0, 4));  // "YYYY"
  const [searchTerm,      setSearchTerm]      = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  // ── Manage Categories modal (Phase 4B, unchanged) ──────────
  const [categoryModalOpen, setCategoryModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const [newCategoryName, setNewCategoryName] = useState("");
  const [newCategoryKind, setNewCategoryKind] = useState<"operating" | "remuneration">("operating");
  const [creatingCategory, setCreatingCategory] = useState(false);
  const [createCategoryError, setCreateCategoryError] = useState<string | null>(null);

  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [kindUpdatingId, setKindUpdatingId] = useState<string | null>(null);

  // ── Manage Items modal (mirrors Manage Categories) ─────────
  const [expenseItems, setExpenseItems] = useState<ExpenseItem[]>([]);
  const [itemModalOpen, setItemModalOpen] = useState(false);
  const [newItemName, setNewItemName] = useState("");
  const [newItemCategoryId, setNewItemCategoryId] = useState("");
  const [newItemInventoryId, setNewItemInventoryId] = useState("");   // "" = no link
  const [creatingItem, setCreatingItem] = useState(false);
  const [createItemError, setCreateItemError] = useState<string | null>(null);
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [editingItemValue, setEditingItemValue] = useState("");
  const [savingItemEdit, setSavingItemEdit] = useState(false);
  const [itemEditError, setItemEditError] = useState<string | null>(null);
  const [itemTogglingId, setItemTogglingId] = useState<string | null>(null);
  const [itemCatUpdatingId, setItemCatUpdatingId] = useState<string | null>(null);
  const [itemInvUpdatingId, setItemInvUpdatingId] = useState<string | null>(null);

  // ── View toggle: operating Expenses vs Remuneration ─────────
  const [view, setView] = useState<"expenses" | "remuneration">("expenses");

  // ── Edit mode: when set, the matching modal edits this row (in place) ──
  const [editingExpenseId, setEditingExpenseId] = useState<string | null>(null);
  const [editingRemunId,   setEditingRemunId]   = useState<string | null>(null);
  const [editingRemunCategoryId, setEditingRemunCategoryId] = useState<string | null>(null);

  // ── Day-close: a row whose txn_date <= lastClosedDate can't be edited ──
  const [lastClosedDate, setLastClosedDate] = useState<string | null>(null);

  // ── Add Remuneration modal ──────────────────────────────────
  const [remunModalOpen, setRemunModalOpen] = useState(false);
  const [remunRecipientId, setRemunRecipientId] = useState<string>("");
  const [remunAmount, setRemunAmount] = useState<string>("");
  const [remunDate, setRemunDate] = useState<string>(todayISO());
  const [remunNote, setRemunNote] = useState<string>("");
  const [savingRemun, setSavingRemun] = useState(false);
  const [remunError, setRemunError] = useState<string | null>(null);

  const REMUN_DESIGNATIONS = ["Chairman", "Managing Director", "Director"];
  const remunRecipients = employees.filter(
    e => e.isActive && REMUN_DESIGNATIONS.includes(e.designation),
  );

  // ── Add Expense modal (Phase 4C, NEW) ──────────────────────
  const [expenseModalOpen, setExpenseModalOpen] = useState(false);
  const [exTxnDate,     setExTxnDate]     = useState<string>(todayISO());
  const [exAmount,      setExAmount]      = useState<string>("");
  const [exCategoryId,  setExCategoryId]  = useState<string>("");
  const [exPayeeMode,   setExPayeeMode]   = useState<"employee" | "vendor">("employee");
  const [exEmployeeId,  setExEmployeeId]  = useState<string>("");
  const [exPayeeText,   setExPayeeText]   = useState<string>("");
  const [exNote,        setExNote]        = useState<string>("");
  // Optional expense-item picker (ItemCombobox: click-to-open list + type-to-filter)
  const [exExpItemId,     setExExpItemId]     = useState<string>("");
  const [exExpItemSearch, setExExpItemSearch] = useState<string>("");
  // ── Inventory purchase toggle state ───────────────────────
  const [exIsInventory,   setExIsInventory]   = useState<boolean>(false);
  const [exInvItemId,     setExInvItemId]     = useState<string>("");
  const [exInvItemSearch, setExInvItemSearch] = useState<string>("");
  const [exInvQuantity,   setExInvQuantity]   = useState<string>("");
  const [exInvUnitPrice,  setExInvUnitPrice]  = useState<string>("");
  const [exInvUnit,       setExInvUnit]       = useState<"pack" | "base">("pack");
  const toBaseQty = (packQty: number): number => {
    const it = inventoryItems.find((i) => i.id === exInvItemId);
    const upp = it?.unitsPerPack ?? null;
    return upp != null && exInvUnit === "pack" ? packQty * upp : packQty;
  };

  // ── Inline item creation state (mini-form, shows when typed name doesn't match) ──
  const [inventoryCategories, setInventoryCategories] = useState<InventoryCategory[]>([]);
  const [exInvCreateMode,     setExInvCreateMode]     = useState<boolean>(false);
  const [exInvNewType,        setExInvNewType]        = useState<InventoryItemType>("consumable");
  const [exInvNewUnit,        setExInvNewUnit]        = useState<InventoryItemUnit>("piece");
  const [exInvNewCategoryId,  setExInvNewCategoryId]  = useState<string>("");
  const [exInvNewNotes,       setExInvNewNotes]       = useState<string>("");
  const [creatingInvItem,     setCreatingInvItem]     = useState<boolean>(false);
  const [createInvItemError,  setCreateInvItemError]  = useState<string | null>(null);

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
        const [exps, emps, payeesH, invItems, invCats, dayClose, expItems] = await Promise.all([
          getExpenses({ fromDate: filterFromDate, toDate: filterToDate }),
          getAllEmployees(),
          getDistinctPayees(),
          getInventoryItems({ activeOnly: false }),
          getInventoryCategories(),
          getDayCloseStatus().catch(() => null),
          getExpenseItems(),
        ]);
        if (cancelled) return;
        setExpenses(exps);
        // categories come from the reference cache (no per-mount fetch here).
        setEmployees(emps);
        setPayeesHistory(payeesH);
        setInventoryItems(invItems);
        setInventoryCategories(invCats);
        setExpenseItems(expItems);
        setLastClosedDate(dayClose?.lastClosedDate ?? null);
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

  // Debounce the search box (same pattern as the Activity Log).
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchTerm), 300);
    return () => clearTimeout(t);
  }, [searchTerm]);

  // Period → from/to. Daily = one day; Monthly = 1st..last day of the month
  // (new Date(y, m, 0) — the P&L last_month pattern); Yearly = Jan 1..Dec 31;
  // Custom leaves the two date inputs directly editable. The existing
  // [filterFromDate, filterToDate] refetch effect then loads the period, so
  // the drill-down list always contains every expense inside it.
  useEffect(() => {
    if (periodMode === "custom") return;
    if (periodMode === "daily") {
      if (!periodDay) return;
      setFilterFromDate(periodDay);
      setFilterToDate(periodDay);
    } else if (periodMode === "monthly") {
      const [y, m] = periodMonth.split("-").map(Number);
      if (!y || !m) return;
      setFilterFromDate(isoDate(y, m, 1));
      setFilterToDate(isoDate(y, m, new Date(y, m, 0).getDate()));
    } else {
      const y = parseInt(periodYear, 10);
      if (!y || y < 2000 || y > 2100) return;
      setFilterFromDate(isoDate(y, 1, 1));
      setFilterToDate(isoDate(y, 12, 31));
    }
  }, [periodMode, periodDay, periodMonth, periodYear]);

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
    setEditingExpenseId(null);
    setExpenseModalOpen(true);
    setExTxnDate(todayISO());
    setExAmount("");
    setExCategoryId("");
    setExPayeeMode("employee");
    setExEmployeeId("");
    setExPayeeText("");
    setExNote("");
    setExExpItemId("");
    setExExpItemSearch("");
    setCreateExpenseError(null);
    setCreateExpenseFieldErrors({});
    setExIsInventory(false);
    setExInvItemId("");
    setExInvItemSearch("");
    setExInvQuantity("");
    setExInvUnitPrice("");
    setExInvUnit("pack");
    setExInvCreateMode(false);
    setExInvNewType("consumable");
    setExInvNewUnit("piece");
    setExInvNewCategoryId("");
    setExInvNewNotes("");
    setCreateInvItemError(null);
  }
  function closeExpenseModal() {
    if (creatingExpense) return;
    setExpenseModalOpen(false);
    setEditingExpenseId(null);
  }

  // A row is locked once its day is closed (day-close immutability trigger
  // would reject the edit anyway; we disable the button to avoid the error).
  function isRowClosed(e: Expense): boolean {
    return lastClosedDate !== null && e.txnDate <= lastClosedDate;
  }

  // Open the Add Expense modal in EDIT mode, pre-filled from an operating row.
  function openEditExpense(e: Expense) {
    setEditingExpenseId(e.id);
    setExTxnDate(e.txnDate);
    setExAmount(String(e.amount));
    setExCategoryId(e.categoryId);
    if (e.employeeId) { setExPayeeMode("employee"); setExEmployeeId(e.employeeId); setExPayeeText(""); }
    else              { setExPayeeMode("vendor");   setExPayeeText(e.payee ?? ""); setExEmployeeId(""); }
    setExNote(e.note ?? "");
    setExExpItemId(e.expenseItemId ?? "");
    setExExpItemSearch(e.expenseItemId ? (expenseItems.find((i) => i.id === e.expenseItemId)?.name ?? "") : "");
    setCreateExpenseError(null);
    setCreateExpenseFieldErrors({});
    // Inventory seam is create-only — never re-applied on edit.
    setExIsInventory(false);
    setExInvItemId(""); setExInvItemSearch(""); setExInvQuantity(""); setExInvUnitPrice("");
    setExInvUnit("pack"); setExInvCreateMode(false); setCreateInvItemError(null);
    setExpenseModalOpen(true);
  }

  // Open the Add Remuneration modal in EDIT mode, pre-filled from a remuneration row.
  function openEditRemun(e: Expense) {
    setEditingRemunId(e.id);
    setEditingRemunCategoryId(e.categoryId);
    setRemunRecipientId(e.employeeId ?? "");
    setRemunAmount(String(e.amount));
    setRemunDate(e.txnDate);
    setRemunNote(e.note ?? "");
    setRemunError(null);
    setRemunModalOpen(true);
  }

  // ── Manage Items handlers (mirrors Manage Categories) ─────
  function openItemModal() {
    setCreateItemError(null);
    setItemEditError(null);
    if (!newItemCategoryId) setNewItemCategoryId(categories.find((c) => c.isActive)?.id ?? "");
    setItemModalOpen(true);
  }
  function closeItemModal() {
    if (creatingItem || savingItemEdit || itemTogglingId) return;
    setItemModalOpen(false);
    setEditingItemId(null); setEditingItemValue("");
    setNewItemName(""); setNewItemInventoryId("");
    setCreateItemError(null); setItemEditError(null);
  }
  async function reloadItems() {
    try {
      setExpenseItems(await getExpenseItems());
    } catch (err) {
      console.error("[ExpenseClient] reloadItems failed:", err);
    }
  }
  async function handleCreateItem() {
    const trimmed = newItemName.trim();
    if (!trimmed || !newItemCategoryId) return;
    setCreatingItem(true);
    setCreateItemError(null);
    try {
      await createExpenseItem(trimmed, newItemCategoryId, newItemInventoryId || null);
      await reloadItems();
      setNewItemName("");
      setNewItemInventoryId("");
      setSuccessMsg(`Item "${trimmed}" added.`);
    } catch (err) {
      setCreateItemError(err instanceof Error ? err.message : "Failed to create item.");
    } finally {
      setCreatingItem(false);
    }
  }
  function startItemEdit(it: ExpenseItem) {
    setEditingItemId(it.id);
    setEditingItemValue(it.name);
    setItemEditError(null);
  }
  function cancelItemEdit() {
    setEditingItemId(null);
    setEditingItemValue("");
    setItemEditError(null);
  }
  async function handleSaveItemEdit() {
    if (!editingItemId || !editingItemValue.trim()) return;
    setSavingItemEdit(true);
    setItemEditError(null);
    try {
      await updateExpenseItemName(editingItemId, editingItemValue);
      await reloadItems();
      setEditingItemId(null);
      setEditingItemValue("");
    } catch (err) {
      setItemEditError(err instanceof Error ? err.message : "Rename failed.");
    } finally {
      setSavingItemEdit(false);
    }
  }
  async function handleChangeItemCategory(it: ExpenseItem, categoryId: string) {
    if (!categoryId || categoryId === it.categoryId) return;
    setItemCatUpdatingId(it.id);
    setItemEditError(null);
    try {
      await updateExpenseItemCategory(it.id, categoryId);
      await reloadItems();
    } catch (err) {
      setItemEditError(err instanceof Error ? err.message : "Category change failed.");
    } finally {
      setItemCatUpdatingId(null);
    }
  }
  async function handleChangeItemInventoryLink(it: ExpenseItem, inventoryItemId: string) {
    setItemInvUpdatingId(it.id);
    setItemEditError(null);
    try {
      await updateExpenseItemInventoryLink(it.id, inventoryItemId || null);
      await reloadItems();
    } catch (err) {
      setItemEditError(err instanceof Error ? err.message : "Inventory link update failed.");
    } finally {
      setItemInvUpdatingId(null);
    }
  }
  async function handleToggleItemActive(it: ExpenseItem) {
    setItemTogglingId(it.id);
    try {
      await setExpenseItemActive(it.id, !it.isActive);
      setSuccessMsg(`Item "${it.name}" ${it.isActive ? "deactivated" : "reactivated"}.`);
      await reloadItems();
    } catch (err) {
      setItemEditError(err instanceof Error ? err.message : "Toggle failed.");
    } finally {
      setItemTogglingId(null);
    }
  }

  // ── Reload helpers ─────────────────────────────────────────
  // Re-pull the shared expense-category cache (read-only). The aliased
  // `categories` updates from the cache, propagating the edit to every page.
  async function reloadCategories() {
    await refreshExpenseCategories();
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
      await createExpenseCategory(trimmed, newCategoryKind);
      setNewCategoryName("");
      setNewCategoryKind("operating");
      setSuccessMsg(`Category "${trimmed}" created.`);
      await reloadCategories();
    } catch (err) {
      setCreateCategoryError(err instanceof Error ? err.message : "Create failed.");
    } finally {
      setCreatingCategory(false);
    }
  }
  async function handleChangeKind(c: ExpenseCategory, kind: "operating" | "remuneration") {
    if (kind === c.kind) return;
    setKindUpdatingId(c.id);
    try {
      await updateExpenseCategoryKind(c.id, kind);
      setSuccessMsg(`"${c.name}" set to ${kind === "remuneration" ? "Remuneration" : "Operating expense"}.`);
      await reloadCategories();
    } catch (err) {
      console.error("[ExpenseClient] kind change failed:", err);
      setSuccessMsg(err instanceof Error ? err.message : "Could not change category type.");
    } finally {
      setKindUpdatingId(null);
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
  /**
   * Inline item creation — called from the mini-form inside the inventory
   * sub-form. Validates inputs, calls createInventoryItem, on success
   * selects the new item (populates exInvItemId, sets the search field
   * to the new name) and exits create mode.
   *
   * Orphan-tolerant: if the user later cancels or the expense save fails,
   * the inventory_items row stays. Zero stock; no harm. Per Day 22 design.
   */
  async function handleCreateInventoryItemInline() {
    const name = exInvItemSearch.trim();
    if (!name) {
      setCreateInvItemError("Type an item name in the picker first.");
      return;
    }
    setCreateInvItemError(null);
    setCreatingInvItem(true);
    try {
      const input: NewInventoryItem = {
        name,
        type: exInvNewType,
        unit: exInvNewUnit,
        categoryId: exInvNewCategoryId || undefined,
        notes:      exInvNewNotes.trim() || undefined,
      };
      const created = await createInventoryItem(input);
      // Refresh the items list so the new item appears in the picker
      const refreshed = await getInventoryItems({ activeOnly: false });
      setInventoryItems(refreshed);
      // Select the new item and exit create mode
      setExInvItemId(created.id);
      setExInvItemSearch(created.name);
      setExInvCreateMode(false);
      // Don't reset type/unit/category/notes here — keep them in case the
      // user immediately creates another item in the same modal session.
    } catch (err) {
      setCreateInvItemError(err instanceof Error ? err.message : "Create failed.");
    } finally {
      setCreatingInvItem(false);
    }
  }

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
      const selCatForItem = categories.find((c) => c.id === exCategoryId);
      const itemAllowed = !!selCatForItem
        && selCatForItem.kind !== "remuneration"
        && !(selCatForItem.systemKey && NO_ITEM_PICKER_KEYS.has(selCatForItem.systemKey));
      const input: NewExpense = {
        txnDate:     exTxnDate,
        amount:      amountNum,
        categoryId:  exCategoryId,
        expenseItemId: itemAllowed && exExpItemId ? exExpItemId : null,
        payeeMode:   exPayeeMode,
        employeeId:  exPayeeMode === "employee" ? exEmployeeId : undefined,
        payee:       exPayeeMode === "vendor"   ? exPayeeText.trim() : undefined,
        note:        exNote.trim() || undefined,
      };

      // ── EDIT mode: in-place update, no inventory seam ──
      if (editingExpenseId) {
        const updated = await editExpense(editingExpenseId, input);
        setSuccessMsg(`Expense ${updated.voucherNumber} updated.`);
        closeExpenseModal();
        await reloadExpenses();
        return;
      }

      const newExpense = await createExpense(input);

      // Inventory seam (Phase I-D): when toggle is ON, write the
      // purchase movement immediately after the expense row, linking
      // them via source_account_transaction_id.
      if (exIsInventory && exInvItemId) {
        const invQtyNum = parseFloat(exInvQuantity);
        const invBaseQty = toBaseQty(invQtyNum);
        const invUpNum  = exInvUnitPrice.trim()
          ? parseFloat(exInvUnitPrice)
          : amountNum / invBaseQty;
        await createPurchaseMovement({
          itemId:                      exInvItemId,
          quantity:                    invBaseQty,
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
  function openRemunModal() {
    setEditingRemunId(null);
    setEditingRemunCategoryId(null);
    setRemunRecipientId("");
    setRemunAmount("");
    setRemunDate(todayISO());
    setRemunNote("");
    setRemunError(null);
    setRemunModalOpen(true);
  }

  async function handleRecordRemuneration() {
    const amt = parseFloat(remunAmount);
    if (!remunRecipientId)              { setRemunError("Select a recipient."); return; }
    if (!remunAmount.trim() || isNaN(amt) || amt <= 0) { setRemunError("Amount must be a positive number."); return; }
    setRemunError(null);
    setSavingRemun(true);
    try {
      const recipient = remunRecipients.find(e => e.id === remunRecipientId);

      // ── EDIT mode: in-place update, preserve the row's remuneration category ──
      if (editingRemunId) {
        await editExpense(editingRemunId, {
          txnDate:    remunDate,
          amount:     amt,
          categoryId: editingRemunCategoryId ?? await resolveRemunerationCategoryId(),
          payeeMode:  "employee",
          employeeId: remunRecipientId,
          note:       remunNote.trim() || undefined,
        });
        const exps = await getExpenses();
        setExpenses(exps);
        await refreshExpenseCategories();   // remuneration may auto-create its category
        setSuccessMsg(`Remuneration to ${recipient?.fullName ?? "recipient"} updated.`);
        setRemunModalOpen(false);
        setEditingRemunId(null);
        setEditingRemunCategoryId(null);
        return;
      }

      const categoryId = await resolveRemunerationCategoryId();
      await createExpense({
        txnDate:    remunDate,
        amount:     amt,
        categoryId,
        payeeMode:  "employee",
        employeeId: remunRecipientId,
        note:       remunNote.trim() || undefined,
      });
      const exps = await getExpenses();
      setExpenses(exps);
      await refreshExpenseCategories();   // remuneration may auto-create its category
      setSuccessMsg(`Remuneration of ৳${formatAmount(amt)} to ${recipient?.fullName ?? "recipient"} recorded.`);
      setRemunModalOpen(false);
    } catch (err) {
      setRemunError(err instanceof Error ? err.message : "Failed to record remuneration.");
    } finally {
      setSavingRemun(false);
    }
  }

  // Classify each expense row by its category kind so remuneration is never
  // counted as an operating expense. Unknown/missing kind → operating.
  const kindById = new Map(categories.map(c => [c.id, c.kind]));
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
  const visibleExpenses = expenses.filter(e => {
    const k = kindById.get(e.categoryId) ?? "operating";
    if (view === "remuneration" ? k !== "remuneration" : k !== "operating") return false;
    // Search across item name, note, payee/employee name, and category name.
    const q = debouncedSearch.trim().toLowerCase();
    if (!q) return true;
    const itemName = e.expenseItemId ? (expenseItems.find((i) => i.id === e.expenseItemId)?.name ?? "") : "";
    const empName  = e.employeeId   ? (employees.find((x) => x.id === e.employeeId)?.fullName ?? "") : "";
    const catName  = categoryById.get(e.categoryId)?.name ?? "";
    return (
      itemName.toLowerCase().includes(q) ||
      (e.note ?? "").toLowerCase().includes(q) ||
      (e.payee ?? "").toLowerCase().includes(q) ||
      empName.toLowerCase().includes(q) ||
      catName.toLowerCase().includes(q)
    );
  });
  const groups = groupByDate(visibleExpenses);

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
            onClick={openItemModal}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-white border border-slate-200 text-slate-700 text-[13px] font-semibold hover:bg-slate-50 hover:border-slate-300 transition-colors"
            title="Manage expense items (grouped under categories)"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
              <path d="M20 7h-9M20 12h-9M20 17h-9" />
              <path d="M4 5.5h2v3H4zM4 10.5h2v3H4zM4 15.5h2v3H4z" />
            </svg>
            Manage Items
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
          <button
            type="button"
            onClick={openRemunModal}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-amber-500 text-white text-[13px] font-semibold hover:bg-amber-600 transition-colors"
            title="Record a director/MD/chairman remuneration (appropriation of profit)"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" className="w-4 h-4">
              <path d="M12 5v14M5 12h14" />
            </svg>
            Add Remuneration
          </button>
        </div>
      </div>

      {/* ── View toggle: Expenses vs Remuneration ───────────── */}
      <div className="inline-flex rounded-lg bg-slate-100 p-0.5">
        {([["expenses", "Expenses"], ["remuneration", "Remuneration"]] as const).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setView(key)}
            className={`px-4 py-1.5 rounded-md text-[12.5px] font-semibold transition-colors ${
              view === key ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* ── Period + search filter ──────────────────────────── */}
      <div className="flex flex-wrap items-center gap-3 bg-white border border-slate-200 rounded-xl px-4 py-3">
        <div className="inline-flex rounded-lg bg-slate-100 p-0.5">
          {(["daily", "monthly", "yearly", "custom"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setPeriodMode(m)}
              className={`px-3 py-1.5 rounded-md text-[12.5px] font-semibold capitalize transition-colors ${
                periodMode === m ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"
              }`}
            >
              {m}
            </button>
          ))}
        </div>
        {periodMode === "daily" && (
          <input
            type="date"
            value={periodDay}
            onChange={(e) => setPeriodDay(e.target.value)}
            className="px-2.5 py-1.5 text-[13px] text-slate-800 bg-white border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-amber-400"
          />
        )}
        {periodMode === "monthly" && (
          <input
            type="month"
            value={periodMonth}
            onChange={(e) => setPeriodMonth(e.target.value)}
            className="px-2.5 py-1.5 text-[13px] text-slate-800 bg-white border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-amber-400"
          />
        )}
        {periodMode === "yearly" && (
          <input
            type="number"
            min={2000}
            max={2100}
            value={periodYear}
            onChange={(e) => setPeriodYear(e.target.value)}
            className="w-24 px-2.5 py-1.5 text-[13px] text-slate-800 bg-white border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-amber-400"
          />
        )}
        {periodMode === "custom" && (
          <>
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
              className="px-3 py-1.5 text-[12.5px] text-slate-600 hover:bg-slate-100 rounded-md font-medium transition-colors"
            >
              Today
            </button>
          </>
        )}
        <input
          type="search"
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          placeholder="Search item, note, payee, category…"
          className="ml-auto w-64 px-3 py-1.5 text-[13px] text-slate-800 bg-white border border-slate-200 rounded-md placeholder:text-slate-300 focus:outline-none focus:ring-2 focus:ring-amber-400"
        />
      </div>

      {/* ── Period summary — total of everything listed below ── */}
      <div className="flex items-center justify-between bg-white border border-slate-200 rounded-xl px-4 py-3">
        <div className="text-[12.5px] text-slate-500">
          <span className="font-semibold text-slate-700">
            {view === "remuneration" ? "Remuneration" : "Operating expenses"}
          </span>
          {" · "}
          {filterFromDate === filterToDate ? filterFromDate : `${filterFromDate} → ${filterToDate}`}
          {" · "}
          {visibleExpenses.length} {visibleExpenses.length === 1 ? "expense" : "expenses"}
          {debouncedSearch.trim() && <span className="text-amber-600"> · filtered by “{debouncedSearch.trim()}”</span>}
        </div>
        <div className="text-[15px] font-semibold text-slate-900 tabular-nums">
          ৳{formatAmount(visibleExpenses.reduce((sum, e) => sum + e.amount, 0))}
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
                        {(() => {
                          const itemName = e.expenseItemId
                            ? expenseItems.find((i) => i.id === e.expenseItemId)?.name
                            : undefined;
                          const label = itemName ?? e.note;
                          return label ? (
                            <p className="mt-1 text-[12px] text-slate-400 truncate">{label}</p>
                          ) : null;
                        })()}
                      </div>
                      <div className="flex items-center gap-3 flex-shrink-0">
                        <span className="font-mono text-[11.5px] text-slate-400">{e.voucherNumber}</span>
                        {(() => {
                          const closed = isRowClosed(e);
                          const rowKind = kindById.get(e.categoryId) ?? "operating";
                          return (
                            <button
                              type="button"
                              onClick={() => rowKind === "remuneration" ? openEditRemun(e) : openEditExpense(e)}
                              disabled={closed}
                              title={closed ? "This day is closed — editing is locked" : "Edit"}
                              className="px-3 py-1.5 rounded-md bg-slate-100 hover:bg-slate-200 text-slate-700 text-[11.5px] font-semibold uppercase tracking-wider transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                              Edit
                            </button>
                          );
                        })()}
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
                <select
                  value={newCategoryKind}
                  onChange={(e) => setNewCategoryKind(e.target.value as "operating" | "remuneration")}
                  disabled={creatingCategory}
                  className="px-3 py-2.5 rounded-lg border border-slate-200 bg-white text-[13px] text-slate-700 focus:outline-none focus:ring-2 focus:ring-amber-400 disabled:opacity-40 whitespace-nowrap"
                >
                  <option value="operating">Operating expense</option>
                  <option value="remuneration">Remuneration</option>
                </select>
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
              <p className="text-[11.5px] text-slate-400">Remuneration (director/MD/chairman payments) records as cash out but is kept out of operating expenses and profit.</p>
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
                            {c.kind === "remuneration" && (
                              <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 ring-1 ring-amber-200 text-[10.5px] font-semibold uppercase tracking-wider">Remuneration</span>
                            )}
                            {!c.isActive && (
                              <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 text-[10.5px] font-semibold uppercase tracking-wider">Inactive</span>
                            )}
                            <select
                              value={c.kind}
                              onChange={(e) => handleChangeKind(c, e.target.value as "operating" | "remuneration")}
                              disabled={kindUpdatingId === c.id}
                              title="Classification"
                              className="px-2 py-1.5 rounded-md border border-slate-200 bg-white text-[11.5px] text-slate-600 focus:outline-none focus:ring-2 focus:ring-amber-400 disabled:opacity-40"
                            >
                              <option value="operating">Operating</option>
                              <option value="remuneration">Remuneration</option>
                            </select>
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
      {/* MANAGE ITEMS MODAL (mirrors Manage Categories)          */}
      {/* ────────────────────────────────────────────────────── */}
      {itemModalOpen && (
        <div className="fixed inset-0 bg-slate-900/40 flex items-center justify-center z-50 p-6" onClick={closeItemModal}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
              <h2 className="text-[15px] font-semibold text-slate-800">Manage Items</h2>
              <button
                type="button"
                onClick={closeItemModal}
                disabled={!!(savingItemEdit || creatingItem || itemTogglingId)}
                className="text-slate-400 hover:text-slate-700 disabled:opacity-40 disabled:cursor-not-allowed"
                aria-label="Close"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-5 h-5"><path d="M18 6L6 18M6 6l12 12" /></svg>
              </button>
            </div>
            <div className="px-5 py-4 border-b border-slate-200 space-y-2">
              <label className="block text-[12px] font-semibold text-slate-500 uppercase tracking-wider">Add item</label>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={newItemName}
                  onChange={(e) => setNewItemName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") handleCreateItem(); }}
                  placeholder="e.g. Aerosol"
                  disabled={creatingItem}
                  className={inputCls(!!createItemError)}
                />
                <select
                  value={newItemCategoryId}
                  onChange={(e) => setNewItemCategoryId(e.target.value)}
                  disabled={creatingItem}
                  className="px-3 py-2.5 rounded-lg border border-slate-200 bg-white text-[13px] text-slate-700 focus:outline-none focus:ring-2 focus:ring-amber-400 disabled:opacity-40 whitespace-nowrap"
                >
                  <option value="">Category…</option>
                  {categories.filter((c) => c.isActive).map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={handleCreateItem}
                  disabled={creatingItem || !newItemName.trim() || !newItemCategoryId}
                  className="px-4 py-2.5 rounded-lg bg-slate-900 text-white text-[13px] font-semibold hover:bg-slate-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap"
                >
                  {creatingItem ? "Adding…" : "Add"}
                </button>
              </div>
              <select
                value={newItemInventoryId}
                onChange={(e) => setNewItemInventoryId(e.target.value)}
                disabled={creatingItem}
                className="w-full px-3 py-2.5 rounded-lg border border-slate-200 bg-white text-[13px] text-slate-700 focus:outline-none focus:ring-2 focus:ring-amber-400 disabled:opacity-40"
                title="Optional inventory link"
              >
                <option value="">No inventory link (optional)</option>
                {inventoryItems.filter((i) => i.isActive).map((i) => (
                  <option key={i.id} value={i.id}>{i.name}</option>
                ))}
              </select>
              {createItemError && (<p className="text-[12px] text-rose-600">{createItemError}</p>)}
              <p className="text-[11.5px] text-slate-400">Items are grouped under their category. The inventory link is informational — recording stock still uses the inventory purchase toggle on the expense.</p>
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-3">
              {expenseItems.length === 0 ? (
                <div className="py-8 text-center text-[13px] text-slate-400 italic">
                  No items yet. Create one above to get started.
                </div>
              ) : (
                categories.map((cat) => {
                  const catItems = expenseItems.filter((i) => i.categoryId === cat.id);
                  if (catItems.length === 0) return null;
                  return (
                    <div key={cat.id} className="mb-3">
                      <p className="pt-1.5 pb-0.5 text-[11px] font-semibold text-slate-400 uppercase tracking-wider">{cat.name}</p>
                      <ul className="divide-y divide-slate-100">
                        {catItems.map((it) => {
                          const isEditing = editingItemId === it.id;
                          const isToggling = itemTogglingId === it.id;
                          const linkedInv = it.inventoryItemId ? inventoryItems.find((i) => i.id === it.inventoryItemId) : undefined;
                          return (
                            <li key={it.id} className={`py-3 flex items-center gap-3 ${it.isActive ? "" : "opacity-60"}`}>
                              {isEditing ? (
                                <>
                                  <input
                                    type="text"
                                    autoFocus
                                    value={editingItemValue}
                                    onChange={(e) => setEditingItemValue(e.target.value)}
                                    onKeyDown={(e) => {
                                      if (e.key === "Enter") handleSaveItemEdit();
                                      if (e.key === "Escape") cancelItemEdit();
                                    }}
                                    disabled={savingItemEdit}
                                    className={inputCls(!!itemEditError)}
                                  />
                                  <button type="button" onClick={handleSaveItemEdit} disabled={savingItemEdit || !editingItemValue.trim()} className="px-3 py-2 rounded-lg bg-slate-900 text-white text-[12.5px] font-semibold hover:bg-slate-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap">
                                    {savingItemEdit ? "Saving…" : "Save"}
                                  </button>
                                  <button type="button" onClick={cancelItemEdit} disabled={savingItemEdit} className="px-3 py-2 rounded-lg text-slate-500 hover:bg-slate-100 text-[12.5px] font-medium transition-colors disabled:opacity-40">
                                    Cancel
                                  </button>
                                </>
                              ) : (
                                <>
                                  <button type="button" onClick={() => startItemEdit(it)} className="flex-1 text-left text-[13.5px] font-medium text-slate-800 hover:text-amber-700 transition-colors" title="Click to rename">
                                    {it.name}
                                  </button>
                                  {linkedInv && (
                                    <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700 ring-1 ring-indigo-200 text-[10.5px] font-semibold uppercase tracking-wider" title={`Linked to inventory: ${linkedInv.name}`}>Inventory</span>
                                  )}
                                  {!it.isActive && (
                                    <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 text-[10.5px] font-semibold uppercase tracking-wider">Inactive</span>
                                  )}
                                  <select
                                    value={it.categoryId}
                                    onChange={(e) => handleChangeItemCategory(it, e.target.value)}
                                    disabled={itemCatUpdatingId === it.id}
                                    title="Category"
                                    className="max-w-[110px] px-2 py-1.5 rounded-md border border-slate-200 bg-white text-[11.5px] text-slate-600 focus:outline-none focus:ring-2 focus:ring-amber-400 disabled:opacity-40"
                                  >
                                    {categories.map((c) => (
                                      <option key={c.id} value={c.id}>{c.name}</option>
                                    ))}
                                  </select>
                                  <select
                                    value={it.inventoryItemId ?? ""}
                                    onChange={(e) => handleChangeItemInventoryLink(it, e.target.value)}
                                    disabled={itemInvUpdatingId === it.id}
                                    title="Inventory link (optional)"
                                    className="max-w-[110px] px-2 py-1.5 rounded-md border border-slate-200 bg-white text-[11.5px] text-slate-600 focus:outline-none focus:ring-2 focus:ring-amber-400 disabled:opacity-40"
                                  >
                                    <option value="">No link</option>
                                    {inventoryItems.filter((i) => i.isActive || i.id === it.inventoryItemId).map((i) => (
                                      <option key={i.id} value={i.id}>{i.name}</option>
                                    ))}
                                  </select>
                                  <button
                                    type="button"
                                    onClick={() => handleToggleItemActive(it)}
                                    disabled={isToggling}
                                    className={`px-3 py-1.5 rounded-md text-[11.5px] font-semibold uppercase tracking-wider transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${it.isActive ? "bg-slate-100 text-slate-600 hover:bg-slate-200" : "bg-emerald-50 text-emerald-700 hover:bg-emerald-100"}`}
                                  >
                                    {isToggling ? "…" : it.isActive ? "Deactivate" : "Reactivate"}
                                  </button>
                                </>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  );
                })
              )}
              {itemEditError && (<p className="mt-2 text-[12px] text-rose-600">{itemEditError}</p>)}
            </div>
            <div className="flex items-center justify-end px-5 py-3 border-t border-slate-200">
              <button type="button" onClick={closeItemModal} disabled={!!(savingItemEdit || creatingItem || itemTogglingId)} className="px-4 py-2 rounded-lg text-slate-600 hover:bg-slate-100 text-[13px] font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
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
              <h2 className="text-[15px] font-semibold text-slate-800">{editingExpenseId ? "Edit Expense" : "Add Expense"}</h2>
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
                  onChange={(e) => { setExCategoryId(e.target.value); setExExpItemId(""); setExExpItemSearch(""); }}
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

              {/* ── Item picker (optional) — active items of the selected category.
                    Hidden for remuneration-kind and system-keyed salary /
                    remuneration / commission categories. Purely a tag on the
                    expense row; the free-text description below is unchanged. */}
              {(() => {
                const selCat = categories.find((c) => c.id === exCategoryId);
                const allowed = !!selCat
                  && selCat.kind !== "remuneration"
                  && !(selCat.systemKey && NO_ITEM_PICKER_KEYS.has(selCat.systemKey));
                if (!allowed) return null;
                const catItems = expenseItems.filter((i) => i.isActive && i.categoryId === exCategoryId);
                return (
                  <div className="space-y-1">
                    <label className="block text-[12px] font-semibold text-slate-500 uppercase tracking-wider">Item (optional)</label>
                    <ItemCombobox
                      options={catItems.map((i) => ({ id: i.id, label: i.name }))}
                      valueId={exExpItemId}
                      query={exExpItemSearch}
                      placeholder="Select an item (optional)…"
                      disabled={creatingExpense}
                      emptyText="No items in this category"
                      onQueryChange={(v) => { setExExpItemSearch(v); setExExpItemId(""); }}
                      onSelect={(o) => { setExExpItemId(o?.id ?? ""); setExExpItemSearch(o?.label ?? ""); }}
                    />
                    <p className="text-[11.5px] text-slate-400">
                      {catItems.length > 0
                        ? "Pick from the list or leave blank."
                        : "Define items via Manage Items — or leave blank."}
                    </p>
                  </div>
                );
              })()}

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
                    <ItemCombobox
                      options={inventoryItems.filter((it) => it.isActive).map((it) => ({ id: it.id, label: it.name }))}
                      valueId={exInvItemId}
                      query={exInvItemSearch}
                      placeholder="Search inventory items…"
                      disabled={creatingExpense}
                      invalid={!!(createExpenseFieldErrors as Record<string,string>).invItem}
                      emptyText="No active inventory items"
                      onQueryChange={(val) => { setExInvItemSearch(val); setExInvItemId(""); }}
                      onSelect={(o) => {
                        setExInvItemId(o?.id ?? "");
                        setExInvItemSearch(o?.label ?? "");
                        const match = o ? inventoryItems.find((it) => it.id === o.id) : undefined;
                        // auto-compute unit price when qty already entered
                        if (match && exInvQuantity) {
                          const upp = match.unitsPerPack ?? null;
                          const baseQty = upp != null && exInvUnit === "pack" ? parseFloat(exInvQuantity) * upp : parseFloat(exInvQuantity);
                          const amt = parseFloat(exAmount) || 0;
                          if (baseQty > 0 && amt > 0) setExInvUnitPrice((amt / baseQty).toFixed(2));
                        }
                      }}
                    />
                    {(createExpenseFieldErrors as Record<string,string>).invItem && (
                      <p className="text-[11.5px] text-rose-600">{(createExpenseFieldErrors as Record<string,string>).invItem}</p>
                    )}
                    {!exInvItemId && exInvItemSearch.length > 0 && !exInvCreateMode && !(createExpenseFieldErrors as Record<string,string>).invItem && (
                      <div className="space-y-1">
                        <p className="text-[11.5px] text-amber-700">No matching item.</p>
                        <button
                          type="button"
                          onClick={() => { setExInvCreateMode(true); setCreateInvItemError(null); }}
                          disabled={creatingExpense}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-indigo-600 text-white text-[12px] font-semibold hover:bg-indigo-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" className="w-3.5 h-3.5">
                            <path d="M12 5v14M5 12h14" />
                          </svg>
                          Create "{exInvItemSearch}" as new inventory item
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Inline mini-form: create new item ──────────── */}
                  {exInvCreateMode && (
                    <div className="space-y-3 rounded-lg border border-indigo-300 bg-white px-3 py-3">
                      <div className="flex items-center justify-between">
                        <p className="text-[12.5px] font-semibold text-indigo-700">
                          New item: <span className="text-slate-800">{exInvItemSearch || "(type a name in the picker above)"}</span>
                        </p>
                        <button
                          type="button"
                          onClick={() => { setExInvCreateMode(false); setCreateInvItemError(null); }}
                          disabled={creatingInvItem}
                          className="text-[11.5px] text-slate-500 hover:text-slate-700 underline disabled:opacity-40"
                        >
                          cancel
                        </button>
                      </div>

                      <div className="grid grid-cols-2 gap-2">
                        <div className="space-y-1">
                          <label className="block text-[11px] font-semibold text-slate-500 uppercase tracking-wider">Type</label>
                          <select
                            value={exInvNewType}
                            onChange={(e) => setExInvNewType(e.target.value as InventoryItemType)}
                            disabled={creatingInvItem}
                            className="w-full px-2.5 py-1.5 text-[12.5px] text-slate-800 bg-white border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-400"
                          >
                            <option value="consumable">Consumable</option>
                            <option value="durable">Durable</option>
                          </select>
                        </div>
                        <div className="space-y-1">
                          <label className="block text-[11px] font-semibold text-slate-500 uppercase tracking-wider">Unit</label>
                          <select
                            value={exInvNewUnit}
                            onChange={(e) => setExInvNewUnit(e.target.value as InventoryItemUnit)}
                            disabled={creatingInvItem}
                            className="w-full px-2.5 py-1.5 text-[12.5px] text-slate-800 bg-white border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-400"
                          >
                            <option value="piece">piece</option>
                            <option value="kg">kg</option>
                            <option value="gram">gram</option>
                            <option value="litre">litre</option>
                            <option value="millilitre">ml</option>
                            <option value="metre">metre</option>
                            <option value="set">set</option>
                            <option value="box">box</option>
                            <option value="other">other</option>
                          </select>
                        </div>
                      </div>

                      <div className="space-y-1">
                        <label className="block text-[11px] font-semibold text-slate-500 uppercase tracking-wider">Category (optional)</label>
                        <select
                          value={exInvNewCategoryId}
                          onChange={(e) => setExInvNewCategoryId(e.target.value)}
                          disabled={creatingInvItem}
                          className="w-full px-2.5 py-1.5 text-[12.5px] text-slate-800 bg-white border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-400"
                        >
                          <option value="">— uncategorized —</option>
                          {inventoryCategories.filter(c => c.isActive).map((c) => (
                            <option key={c.id} value={c.id}>{c.name}</option>
                          ))}
                        </select>
                      </div>

                      <div className="space-y-1">
                        <label className="block text-[11px] font-semibold text-slate-500 uppercase tracking-wider">Notes (optional)</label>
                        <input
                          type="text"
                          value={exInvNewNotes}
                          onChange={(e) => setExInvNewNotes(e.target.value)}
                          placeholder="brand, supplier, model"
                          disabled={creatingInvItem}
                          className="w-full px-2.5 py-1.5 text-[12.5px] text-slate-800 bg-white border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-400"
                        />
                      </div>

                      {createInvItemError && (
                        <div className="bg-rose-50 border border-rose-200 rounded px-2.5 py-1.5 text-[11.5px] text-rose-700">{createInvItemError}</div>
                      )}

                      <div className="flex justify-end">
                        <button
                          type="button"
                          onClick={handleCreateInventoryItemInline}
                          disabled={creatingInvItem || !exInvItemSearch.trim()}
                          className="px-3 py-1.5 rounded-md bg-indigo-700 text-white text-[12px] font-semibold hover:bg-indigo-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          {creatingInvItem ? "Creating…" : "Create item"}
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Quantity + Unit price */}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <label className="block text-[12px] font-semibold text-slate-500 uppercase tracking-wider">
                        Quantity{inventoryItems.find((i) => i.id === exInvItemId)?.unitsPerPack != null
                          ? exInvUnit === "pack"
                            ? ` (in ${inventoryItems.find((i) => i.id === exInvItemId)?.packLabel ?? "pack"})`
                            : ` (in ${inventoryItems.find((i) => i.id === exInvItemId)?.unit ?? "unit"})`
                          : ""}
                      </label>
                      <div className="flex gap-2">
                        <input
                          type="number"
                          inputMode="decimal"
                          step="0.01"
                          min="0.01"
                          value={exInvQuantity}
                          onChange={(e) => {
                            setExInvQuantity(e.target.value);
                            const qty = toBaseQty(parseFloat(e.target.value));
                            const amt = parseFloat(exAmount) || 0;
                            if (qty > 0 && amt > 0) setExInvUnitPrice((amt / qty).toFixed(2));
                          }}
                          placeholder="e.g. 50"
                          disabled={creatingExpense}
                          className={`${inputCls(!!(createExpenseFieldErrors as Record<string,string>).invQty)} flex-1`}
                        />
                        {inventoryItems.find((i) => i.id === exInvItemId)?.unitsPerPack != null && (
                          <select value={exInvUnit} onChange={(e) => {
                            const u = e.target.value as "pack" | "base";
                            setExInvUnit(u);
                            const it = inventoryItems.find((i) => i.id === exInvItemId);
                            const upp = it?.unitsPerPack ?? null;
                            const baseQty = upp != null && u === "pack" ? parseFloat(exInvQuantity) * upp : parseFloat(exInvQuantity);
                            const amt = parseFloat(exAmount) || 0;
                            if (baseQty > 0 && amt > 0) setExInvUnitPrice((amt / baseQty).toFixed(2));
                          }}
                            disabled={creatingExpense}
                            className="rounded-lg border border-slate-300 bg-white px-2 text-[13px] text-slate-700">
                            <option value="pack">{inventoryItems.find((i) => i.id === exInvItemId)?.packLabel ?? "pack"}</option>
                            <option value="base">{inventoryItems.find((i) => i.id === exInvItemId)?.unit ?? "unit"}</option>
                          </select>
                        )}
                      </div>
                      {(() => {
                        const s = inventoryItems.find((i) => i.id === exInvItemId);
                        const upp = s?.unitsPerPack ?? null;
                        const q = parseFloat(exInvQuantity);
                        if (upp != null && exInvUnit === "pack" && !isNaN(q) && q > 0)
                          return <p className="text-[11.5px] text-slate-500">= {(q * upp).toLocaleString()} {s?.unit ?? "units"}</p>;
                        return null;
                      })()}
                      {(createExpenseFieldErrors as Record<string,string>).invQty && (
                        <p className="text-[11.5px] text-rose-600">{(createExpenseFieldErrors as Record<string,string>).invQty}</p>
                      )}
                    </div>
                    <div className="space-y-1">
                      <label className="block text-[12px] font-semibold text-slate-500 uppercase tracking-wider">{inventoryItems.find((i) => i.id === exInvItemId)?.unitsPerPack != null ? `Price per ${inventoryItems.find((i) => i.id === exInvItemId)?.unit ?? "unit"} (৳)` : "Unit price (৳)"}</label>
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
                    const qty = toBaseQty(parseFloat(exInvQuantity));
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
                {creatingExpense ? "Saving…" : editingExpenseId ? "Save Changes" : "Save Expense"}
              </button>
            </div>

          </div>
        </div>
      )}

      {/* ── ADD REMUNERATION MODAL ──────────────────────────── */}
      {remunModalOpen && (
        <div className="fixed inset-0 bg-slate-900/40 flex items-center justify-center z-50 p-6" onClick={() => { if (!savingRemun) setRemunModalOpen(false); }}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
              <h2 className="text-[15px] font-semibold text-slate-800">{editingRemunId ? "Edit Remuneration" : "Add Remuneration"}</h2>
              <button type="button" onClick={() => { if (!savingRemun) setRemunModalOpen(false); }} disabled={savingRemun} className="text-slate-400 hover:text-slate-700 disabled:opacity-40" aria-label="Close">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-5 h-5"><path d="M18 6L6 18M6 6l12 12" /></svg>
              </button>
            </div>
            <div className="px-5 py-4 space-y-4">
              <p className="text-[11.5px] text-slate-400">
                Director/MD/Chairman payment — paid from <span className="font-semibold text-slate-600">Cash in Hand</span>, recorded as cash out but kept out of operating expenses and profit (appropriation of profit).
              </p>

              <div>
                <label className="block text-[12px] font-semibold text-slate-500 uppercase tracking-wider mb-1.5">Recipient</label>
                <select value={remunRecipientId} onChange={(e) => setRemunRecipientId(e.target.value)} disabled={savingRemun} className={inputCls(false)}>
                  <option value="">Select recipient…</option>
                  {remunRecipients.map(e => (
                    <option key={e.id} value={e.id}>{e.fullName} · {e.designation}</option>
                  ))}
                </select>
                {remunRecipients.length === 0 && (
                  <p className="mt-1 text-[11.5px] text-amber-700">No active Chairman / Managing Director / Director employees found.</p>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[12px] font-semibold text-slate-500 uppercase tracking-wider mb-1.5">Amount (৳)</label>
                  <input type="number" min={0} step="0.01" value={remunAmount} onChange={(e) => setRemunAmount(e.target.value)} onWheel={(e) => (e.target as HTMLInputElement).blur()} disabled={savingRemun} placeholder="0.00" className={inputCls(false)} />
                </div>
                <div>
                  <label className="block text-[12px] font-semibold text-slate-500 uppercase tracking-wider mb-1.5">Date</label>
                  <input type="date" value={remunDate} max={todayISO()} onChange={(e) => setRemunDate(e.target.value)} disabled={savingRemun} className={inputCls(false)} />
                </div>
              </div>

              <div>
                <label className="block text-[12px] font-semibold text-slate-500 uppercase tracking-wider mb-1.5">Note <span className="text-slate-400 normal-case font-normal">(optional)</span></label>
                <input type="text" value={remunNote} onChange={(e) => setRemunNote(e.target.value)} disabled={savingRemun} placeholder="e.g. June remuneration" className={inputCls(false)} />
              </div>

              {remunError && <p className="text-[12px] text-rose-600">{remunError}</p>}
            </div>
            <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-slate-200">
              <button type="button" onClick={() => setRemunModalOpen(false)} disabled={savingRemun} className="px-4 py-2 rounded-lg text-slate-600 text-[13px] font-medium hover:bg-slate-100 transition-colors disabled:opacity-40">Cancel</button>
              <button type="button" onClick={handleRecordRemuneration} disabled={savingRemun || !remunRecipientId || !remunAmount.trim()} className="px-4 py-2 rounded-lg bg-amber-500 text-white text-[13px] font-semibold hover:bg-amber-600 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                {savingRemun ? "Saving…" : editingRemunId ? "Save Changes" : "Record Remuneration"}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

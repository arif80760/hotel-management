"use client";

// app/inventory/InventoryClient.tsx
//
// Inventory home — Phase I-C ships:
//   - Items list with current stock counts (from getStockForAllItems)
//   - Manage Categories modal (mirror of revenue categories admin)
//   - Add Item modal (name, category, type, unit, notes)
//   - Add Stock (manual purchase) modal — for opening stock entries
//     and corrections that don't flow through expense
//
// Deferred to a later phase (Day 23+):
//   - Issue, damage, transfer, adjustment movement UIs
//   - Item detail page with full movement history
//
// Theming: indigo-700 (distinct from expense amber and revenue emerald)
//
// ─────────────────────────────────────────────────────────────

import { useState, useEffect } from "react";

import {
  getInventoryCategories,
  createInventoryCategory,
  updateInventoryCategoryName,
  setInventoryCategoryActive,
  type InventoryCategory,
} from "@/services/inventoryCategoriesService";

import {
  getInventoryItems,
  createInventoryItem,
  setInventoryItemActive,
  updateInventoryItem,
  getMovementCountForItem,
  createPurchaseMovement,
  getStockForAllItems,
  type InventoryItem,
  type InventoryItemType,
  type InventoryItemUnit,
  type NewInventoryItem,
  type UpdateInventoryItem,
} from "@/services/inventoryService";

const ITEM_TYPES: { value: InventoryItemType; label: string }[] = [
  { value: "consumable", label: "Consumable (water bottles, soap, etc.)" },
  { value: "durable",    label: "Durable (TV, AC, furniture, etc.)"      },
];

const ITEM_UNITS: { value: InventoryItemUnit; label: string }[] = [
  { value: "piece",      label: "piece" },
  { value: "kg",         label: "kg" },
  { value: "gram",       label: "gram" },
  { value: "litre",      label: "litre" },
  { value: "millilitre", label: "ml" },
  { value: "metre",      label: "metre" },
  { value: "set",        label: "set" },
  { value: "box",        label: "box" },
  { value: "other",      label: "other" },
];

function inputCls(hasError = false): string {
  return [
    "w-full px-3.5 py-2.5 text-[13.5px] text-slate-800 bg-white border rounded-lg",
    "placeholder:text-slate-300 focus:outline-none focus:ring-2 focus:ring-indigo-400 focus:border-transparent transition",
    hasError ? "border-rose-300 bg-rose-50" : "border-slate-200",
  ].join(" ");
}

function formatNumber(n: number): string {
  if (n === Math.floor(n)) return String(n);
  return n.toFixed(2);
}

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}


export default function InventoryClient() {
  // ── Data ───────────────────────────────────────────────────
  const [items,      setItems]      = useState<InventoryItem[]>([]);
  const [categories, setCategories] = useState<InventoryCategory[]>([]);
  const [stockMap,   setStockMap]   = useState<Map<string, number>>(new Map());

  // ── Load state ─────────────────────────────────────────────
  const [fetching,   setFetching]   = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // ── Filter ─────────────────────────────────────────────────
  const [filterCategory, setFilterCategory] = useState<string>("");
  const [filterType,     setFilterType]     = useState<"" | InventoryItemType>("");
  const [searchText,     setSearchText]     = useState<string>("");

  // ── Manage Categories modal ────────────────────────────────
  const [categoryModalOpen, setCategoryModalOpen] = useState(false);
  const [editingCatId, setEditingCatId] = useState<string | null>(null);
  const [editingCatValue, setEditingCatValue] = useState("");
  const [savingCatEdit, setSavingCatEdit] = useState(false);
  const [catEditError, setCatEditError] = useState<string | null>(null);
  const [newCatName, setNewCatName] = useState("");
  const [creatingCat, setCreatingCat] = useState(false);
  const [createCatError, setCreateCatError] = useState<string | null>(null);
  const [togglingCatId, setTogglingCatId] = useState<string | null>(null);

  // ── Add Item modal ─────────────────────────────────────────
  const [itemModalOpen, setItemModalOpen] = useState(false);
  const [itName,        setItName]        = useState("");
  const [itCategoryId,  setItCategoryId]  = useState("");
  const [itType,        setItType]        = useState<InventoryItemType>("consumable");
  const [itUnit,        setItUnit]        = useState<InventoryItemUnit>("piece");
  const [itNotes,       setItNotes]       = useState("");
  const [creatingItem, setCreatingItem] = useState(false);
  const [createItemError, setCreateItemError] = useState<string | null>(null);
  const [createItemFieldErrors, setCreateItemFieldErrors] = useState<{ name?: string }>({});

  // ── Add Stock (manual purchase) modal ──────────────────────
  const [stockModalOpen, setStockModalOpen] = useState(false);
  const [stockItemId,    setStockItemId]    = useState("");
  const [stockDate,      setStockDate]      = useState<string>(todayISO());
  const [stockQuantity,  setStockQuantity]  = useState("");
  const [stockUnitPrice, setStockUnitPrice] = useState("");
  const [stockReason,    setStockReason]    = useState("");
  const [creatingStock, setCreatingStock] = useState(false);
  const [createStockError, setCreateStockError] = useState<string | null>(null);
  const [createStockFieldErrors, setCreateStockFieldErrors] = useState<{
    itemId?: string; date?: string; quantity?: string; unitPrice?: string; reason?: string;
  }>({});

  // ── Edit Item modal ────────────────────────────────────────
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<InventoryItem | null>(null);
  const [editMovementCount, setEditMovementCount] = useState<number>(0);
  const [edName,       setEdName]       = useState("");
  const [edCategoryId, setEdCategoryId] = useState("");
  const [edType,       setEdType]       = useState<InventoryItemType>("consumable");
  const [edUnit,       setEdUnit]       = useState<InventoryItemUnit>("piece");
  const [edNotes,      setEdNotes]      = useState("");
  const [edIsActive,   setEdIsActive]   = useState(true);
  const [savingEdit, setSavingEdit] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [editFieldErrors, setEditFieldErrors] = useState<{ name?: string }>({});

  // ── Success banner ─────────────────────────────────────────
  const [successMsg, setSuccessMsg] = useState("");

  // ── Load on mount ──────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [it, cats, stk] = await Promise.all([
          getInventoryItems({}),
          getInventoryCategories(),
          getStockForAllItems(),
        ]);
        if (cancelled) return;
        setItems(it);
        setCategories(cats);
        setStockMap(stk);
      } catch (err) {
        if (!cancelled) setFetchError(err instanceof Error ? err.message : "Failed to load.");
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

  // ── Escape closes modals ──────────────────────────────────
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (categoryModalOpen && !savingCatEdit && !creatingCat && !togglingCatId) closeCategoryModal();
      else if (itemModalOpen && !creatingItem) closeItemModal();
      else if (stockModalOpen && !creatingStock) closeStockModal();
      else if (editModalOpen && !savingEdit) closeEditModal();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categoryModalOpen, itemModalOpen, stockModalOpen, editModalOpen, savingCatEdit, creatingCat, togglingCatId, creatingItem, creatingStock, savingEdit]);

  // ── Lookup maps ────────────────────────────────────────────
  const categoryById = new Map(categories.map(c => [c.id, c]));
  const activeCategories = categories.filter(c => c.isActive);

  // ── Filtered items ─────────────────────────────────────────
  const filteredItems = items.filter((it) => {
    if (filterCategory && it.categoryId !== filterCategory) return false;
    if (filterType && it.type !== filterType) return false;
    if (searchText && !it.name.toLowerCase().includes(searchText.toLowerCase())) return false;
    return true;
  });

  // ── Reload helpers ─────────────────────────────────────────
  async function reloadAll() {
    try {
      const [it, cats, stk] = await Promise.all([
        getInventoryItems({}),
        getInventoryCategories(),
        getStockForAllItems(),
      ]);
      setItems(it); setCategories(cats); setStockMap(stk);
    } catch (err) {
      console.error("[InventoryClient] reloadAll failed:", err);
    }
  }
  async function reloadCategories() {
    try { setCategories(await getInventoryCategories()); }
    catch (err) { console.error("[InventoryClient] reloadCategories failed:", err); }
  }

  // ── Categories modal helpers (R-B/4B pattern) ──────────────
  function openCategoryModal() {
    setCategoryModalOpen(true);
    setEditingCatId(null); setEditingCatValue(""); setCatEditError(null);
    setNewCatName(""); setCreateCatError(null);
  }
  function closeCategoryModal() {
    if (savingCatEdit || creatingCat || togglingCatId) return;
    setCategoryModalOpen(false);
  }
  async function handleCreateCategory() {
    const trimmed = newCatName.trim();
    if (!trimmed) { setCreateCatError("Name is required."); return; }
    setCreateCatError(null); setCreatingCat(true);
    try {
      await createInventoryCategory(trimmed);
      setNewCatName(""); setSuccessMsg(`Category "${trimmed}" created.`);
      await reloadCategories();
    } catch (err) {
      setCreateCatError(err instanceof Error ? err.message : "Create failed.");
    } finally { setCreatingCat(false); }
  }
  function startCatEdit(c: InventoryCategory) {
    setEditingCatId(c.id); setEditingCatValue(c.name); setCatEditError(null);
  }
  function cancelCatEdit() { setEditingCatId(null); setEditingCatValue(""); setCatEditError(null); }
  async function handleSaveCatEdit() {
    if (!editingCatId) return;
    const trimmed = editingCatValue.trim();
    if (!trimmed) { setCatEditError("Name is required."); return; }
    setCatEditError(null); setSavingCatEdit(true);
    try {
      await updateInventoryCategoryName(editingCatId, trimmed);
      setSuccessMsg(`Category renamed to "${trimmed}".`);
      setEditingCatId(null); setEditingCatValue("");
      await reloadCategories();
    } catch (err) {
      setCatEditError(err instanceof Error ? err.message : "Rename failed.");
    } finally { setSavingCatEdit(false); }
  }
  async function handleToggleCatActive(c: InventoryCategory) {
    setTogglingCatId(c.id);
    try {
      await setInventoryCategoryActive(c.id, !c.isActive);
      setSuccessMsg(`Category "${c.name}" ${c.isActive ? "deactivated" : "reactivated"}.`);
      await reloadCategories();
    } catch (err) { console.error("[InventoryClient] toggle failed:", err); }
    finally { setTogglingCatId(null); }
  }

  // ── Item modal handlers ────────────────────────────────────
  function openItemModal() {
    setItemModalOpen(true);
    setItName(""); setItCategoryId(""); setItType("consumable");
    setItUnit("piece"); setItNotes("");
    setCreateItemError(null); setCreateItemFieldErrors({});
  }
  function closeItemModal() { if (creatingItem) return; setItemModalOpen(false); }
  async function handleCreateItem() {
    const fieldErrors: { name?: string } = {};
    if (!itName.trim()) fieldErrors.name = "Name is required.";
    if (Object.keys(fieldErrors).length) { setCreateItemFieldErrors(fieldErrors); return; }
    setCreateItemFieldErrors({}); setCreateItemError(null); setCreatingItem(true);
    try {
      const input: NewInventoryItem = {
        name:       itName.trim(),
        categoryId: itCategoryId || undefined,
        type:       itType,
        unit:       itUnit,
        notes:      itNotes.trim() || undefined,
      };
      await createInventoryItem(input);
      setSuccessMsg(`Item "${itName.trim()}" added.`);
      closeItemModal();
      await reloadAll();
    } catch (err) {
      setCreateItemError(err instanceof Error ? err.message : "Create failed.");
    } finally { setCreatingItem(false); }
  }

  // ── Stock (manual purchase) modal handlers ─────────────────
  function openStockModal() {
    setStockModalOpen(true);
    setStockItemId("");
    setStockDate(todayISO());
    setStockQuantity(""); setStockUnitPrice(""); setStockReason("");
    setCreateStockError(null); setCreateStockFieldErrors({});
  }
  function closeStockModal() { if (creatingStock) return; setStockModalOpen(false); }
  async function handleCreateStock() {
    const fieldErrors: { itemId?: string; date?: string; quantity?: string; unitPrice?: string; reason?: string } = {};
    if (!stockItemId) fieldErrors.itemId = "Item is required.";
    if (!stockDate) fieldErrors.date = "Date is required.";
    const qty = parseFloat(stockQuantity);
    if (!stockQuantity.trim() || isNaN(qty) || qty <= 0) fieldErrors.quantity = "Quantity must be > 0.";
    const price = parseFloat(stockUnitPrice);
    if (!stockUnitPrice.trim() || isNaN(price) || price < 0) fieldErrors.unitPrice = "Unit price required (can be 0 if unknown).";
    if (!stockReason.trim()) fieldErrors.reason = "Reason note is required for manual stock add.";
    if (Object.keys(fieldErrors).length) { setCreateStockFieldErrors(fieldErrors); return; }
    setCreateStockFieldErrors({}); setCreateStockError(null); setCreatingStock(true);
    try {
      // Convert the date input (local YYYY-MM-DD) to a UTC ISO string.
      // Anchor to noon local to avoid timezone-driven date drift.
      const happenedAt = new Date(stockDate + "T12:00:00").toISOString();
      await createPurchaseMovement({
        itemId:     stockItemId,
        quantity:   qty,
        unitPrice:  price,
        happenedAt,
        reasonNote: stockReason.trim(),
      });
      setSuccessMsg("Stock added.");
      closeStockModal();
      await reloadAll();
    } catch (err) {
      setCreateStockError(err instanceof Error ? err.message : "Create failed.");
    } finally { setCreatingStock(false); }
  }

  // ── Edit Item modal handlers ───────────────────────────────
  async function openEditModal(item: InventoryItem) {
    setEditingItem(item);
    setEdName(item.name);
    setEdCategoryId(item.categoryId ?? "");
    setEdType(item.type);
    setEdUnit(item.unit);
    setEdNotes(item.notes ?? "");
    setEdIsActive(item.isActive);
    setEditError(null); setEditFieldErrors({});
    setEditMovementCount(0);
    setEditModalOpen(true);
    try {
      const n = await getMovementCountForItem(item.id);
      setEditMovementCount(n);
    } catch (err) {
      console.error("[InventoryClient] movement count load failed:", err);
      // soft-fail: leave at 0, which means fields stay editable.
      // The DB will accept whatever the user submits regardless.
    }
  }
  function closeEditModal() { if (savingEdit) return; setEditModalOpen(false); setEditingItem(null); }
  async function handleSaveEdit() {
    if (!editingItem) return;
    const fieldErrors: { name?: string } = {};
    if (!edName.trim()) fieldErrors.name = "Name is required.";
    if (Object.keys(fieldErrors).length) { setEditFieldErrors(fieldErrors); return; }
    setEditFieldErrors({}); setEditError(null); setSavingEdit(true);
    try {
      const patch: UpdateInventoryItem = {
        name:       edName.trim(),
        categoryId: edCategoryId || null,
        notes:      edNotes.trim() || null,
        isActive:   edIsActive,
      };
      // Only include type/unit in the patch if movements are zero (lock guard).
      if (editMovementCount === 0) {
        patch.type = edType;
        patch.unit = edUnit;
      }
      await updateInventoryItem(editingItem.id, patch);
      setSuccessMsg(`Item "${edName.trim()}" updated.`);
      closeEditModal();
      await reloadAll();
    } catch (err) {
      setEditError(err instanceof Error ? err.message : "Update failed.");
    } finally { setSavingEdit(false); }
  }

  // ── Loading / Error ────────────────────────────────────────
  if (fetching) {
    return (
      <div className="p-8">
        <h1 className="text-2xl font-semibold text-slate-800">Inventory</h1>
        <div className="mt-8 rounded-xl border border-dashed border-slate-200 bg-white px-6 py-12 flex items-center justify-center text-[13px] text-slate-400">Loading…</div>
      </div>
    );
  }
  if (fetchError) {
    return (
      <div className="p-8">
        <h1 className="text-2xl font-semibold text-slate-800">Inventory</h1>
        <div className="mt-8 rounded-xl border border-rose-200 bg-rose-50 px-6 py-4 text-[13px] text-rose-700">{fetchError}</div>
      </div>
    );
  }

  // ── Render ─────────────────────────────────────────────────
  return (
    <div className="p-8 space-y-5">

      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-slate-800">Inventory</h1>
        <div className="flex items-center gap-2">
          <button type="button" onClick={openCategoryModal}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-white border border-slate-200 text-slate-700 text-[13px] font-semibold hover:bg-slate-50 hover:border-slate-300 transition-colors">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
              <line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" />
              <circle cx="4" cy="6" r="0.75" fill="currentColor" /><circle cx="4" cy="12" r="0.75" fill="currentColor" /><circle cx="4" cy="18" r="0.75" fill="currentColor" />
            </svg>
            Manage Categories
          </button>
          <button type="button" onClick={openStockModal}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-white border border-indigo-200 text-indigo-700 text-[13px] font-semibold hover:bg-indigo-50 transition-colors">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" className="w-4 h-4">
              <path d="M12 5v14M5 12h14" />
            </svg>
            Add Stock
          </button>
          <button type="button" onClick={openItemModal}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-700 text-white text-[13px] font-semibold hover:bg-indigo-800 transition-colors">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" className="w-4 h-4">
              <path d="M12 5v14M5 12h14" />
            </svg>
            Add Item
          </button>
        </div>
      </div>

      {/* Filter bar */}
      <div className="flex items-center gap-3 bg-white border border-slate-200 rounded-xl px-4 py-3 flex-wrap">
        <input type="text" placeholder="Search by name…" value={searchText} onChange={(e) => setSearchText(e.target.value)}
          className="px-3 py-1.5 text-[13px] text-slate-800 bg-white border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-400 w-64" />
        <select value={filterCategory} onChange={(e) => setFilterCategory(e.target.value)}
          className="px-2.5 py-1.5 text-[13px] text-slate-700 bg-white border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-400">
          <option value="">All categories</option>
          {categories.map((c) => (<option key={c.id} value={c.id}>{c.name}{c.isActive ? "" : " (inactive)"}</option>))}
        </select>
        <select value={filterType} onChange={(e) => setFilterType(e.target.value as "" | InventoryItemType)}
          className="px-2.5 py-1.5 text-[13px] text-slate-700 bg-white border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-400">
          <option value="">All types</option>
          <option value="consumable">Consumable</option>
          <option value="durable">Durable</option>
        </select>
        <div className="ml-auto text-[12.5px] text-slate-500">
          {filteredItems.length} {filteredItems.length === 1 ? "item" : "items"}
        </div>
      </div>

      {/* Success banner */}
      {successMsg && (
        <div className="flex items-center gap-3 bg-emerald-50 border border-emerald-200 rounded-xl px-5 py-3.5">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-5 h-5 text-emerald-600 flex-shrink-0">
            <path d="M22 11.08V12a10 10 0 11-5.93-9.14" /><path d="M22 4L12 14.01l-3-3" />
          </svg>
          <p className="text-[13px] font-medium text-emerald-800">{successMsg}</p>
        </div>
      )}

      {/* Items list */}
      {filteredItems.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-200 bg-white px-6 py-12 flex flex-col items-center justify-center text-center">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="w-8 h-8 text-slate-300 mb-3">
            <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
            <polyline points="3.27 6.96 12 12.01 20.73 6.96"/>
            <line x1="12" y1="22.08" x2="12" y2="12"/>
          </svg>
          <p className="text-[14px] font-semibold text-slate-600 mb-1">
            {items.length === 0 ? "No inventory items yet" : "No items match the filter"}
          </p>
          <p className="text-[12.5px] text-slate-400 max-w-md">
            {items.length === 0
              ? "Click Add Item to start tracking inventory, or Add Stock to record opening stock."
              : "Try widening the search or clearing the category/type filter."}
          </p>
        </div>
      ) : (
        <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
          <table className="w-full text-[13px]">
            <thead className="bg-slate-50 border-b border-slate-200 text-[11.5px] uppercase tracking-wider text-slate-500">
              <tr>
                <th className="text-left px-5 py-3 font-semibold">Item</th>
                <th className="text-left px-5 py-3 font-semibold">Category</th>
                <th className="text-left px-5 py-3 font-semibold">Type</th>
                <th className="text-right px-5 py-3 font-semibold">Stock</th>
                <th className="text-left px-5 py-3 font-semibold">Unit</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredItems.map((it) => {
                const stock = stockMap.get(it.id) ?? 0;
                const cat = it.categoryId ? categoryById.get(it.categoryId) : null;
                return (
                  <tr key={it.id}
                      onClick={() => openEditModal(it)}
                      className={`cursor-pointer hover:bg-indigo-50/40 transition-colors ${it.isActive ? "" : "opacity-50"}`}
                      title="Click to edit">
                    <td className="px-5 py-3.5">
                      <div className="font-medium text-slate-800">{it.name}</div>
                      {it.notes && <div className="text-[11.5px] text-slate-400 mt-0.5">{it.notes}</div>}
                    </td>
                    <td className="px-5 py-3.5 text-slate-600">{cat?.name ?? "—"}</td>
                    <td className="px-5 py-3.5">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold uppercase tracking-wider ${
                        it.type === "durable"
                          ? "bg-indigo-50 text-indigo-700 border border-indigo-100"
                          : "bg-slate-100 text-slate-600"
                      }`}>{it.type}</span>
                    </td>
                    <td className="px-5 py-3.5 text-right font-semibold text-slate-800">{formatNumber(stock)}</td>
                    <td className="px-5 py-3.5 text-slate-500">{it.unit}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ─── MANAGE CATEGORIES MODAL ──────────────────────── */}
      {categoryModalOpen && (
        <div className="fixed inset-0 bg-slate-900/40 flex items-center justify-center z-50 p-6" onClick={closeCategoryModal}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
              <h2 className="text-[15px] font-semibold text-slate-800">Manage Inventory Categories</h2>
              <button type="button" onClick={closeCategoryModal} disabled={!!(savingCatEdit || creatingCat || togglingCatId)} className="text-slate-400 hover:text-slate-700 disabled:opacity-40 disabled:cursor-not-allowed" aria-label="Close">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-5 h-5"><path d="M18 6L6 18M6 6l12 12" /></svg>
              </button>
            </div>
            <div className="px-5 py-4 border-b border-slate-200 space-y-2">
              <label className="block text-[12px] font-semibold text-slate-500 uppercase tracking-wider">Add category</label>
              <div className="flex items-center gap-2">
                <input type="text" value={newCatName} onChange={(e) => setNewCatName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") handleCreateCategory(); }}
                  placeholder="e.g. Toiletries" disabled={creatingCat} className={inputCls(!!createCatError)} />
                <button type="button" onClick={handleCreateCategory} disabled={creatingCat || !newCatName.trim()}
                  className="px-4 py-2.5 rounded-lg bg-indigo-700 text-white text-[13px] font-semibold hover:bg-indigo-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap">
                  {creatingCat ? "Adding…" : "Add"}
                </button>
              </div>
              {createCatError && <p className="text-[12px] text-rose-600">{createCatError}</p>}
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-3">
              {categories.length === 0 ? (
                <div className="py-8 text-center text-[13px] text-slate-400 italic">No categories yet. Create one above.</div>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {categories.map((c) => {
                    const isEditing = editingCatId === c.id;
                    const isToggling = togglingCatId === c.id;
                    return (
                      <li key={c.id} className={`py-3 flex items-center gap-3 ${c.isActive ? "" : "opacity-60"}`}>
                        {isEditing ? (
                          <>
                            <input type="text" autoFocus value={editingCatValue} onChange={(e) => setEditingCatValue(e.target.value)}
                              onKeyDown={(e) => { if (e.key === "Enter") handleSaveCatEdit(); if (e.key === "Escape") cancelCatEdit(); }}
                              disabled={savingCatEdit} className={inputCls(!!catEditError)} />
                            <button type="button" onClick={handleSaveCatEdit} disabled={savingCatEdit || !editingCatValue.trim()}
                              className="px-3 py-2 rounded-lg bg-indigo-700 text-white text-[12.5px] font-semibold hover:bg-indigo-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap">
                              {savingCatEdit ? "Saving…" : "Save"}
                            </button>
                            <button type="button" onClick={cancelCatEdit} disabled={savingCatEdit}
                              className="px-3 py-2 rounded-lg text-slate-500 hover:bg-slate-100 text-[12.5px] font-medium transition-colors disabled:opacity-40">Cancel</button>
                          </>
                        ) : (
                          <>
                            <button type="button" onClick={() => startCatEdit(c)}
                              className="flex-1 text-left text-[13.5px] font-medium text-slate-800 hover:text-indigo-700 transition-colors" title="Click to rename">{c.name}</button>
                            {!c.isActive && (
                              <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 text-[10.5px] font-semibold uppercase tracking-wider">Inactive</span>
                            )}
                            <button type="button" onClick={() => handleToggleCatActive(c)} disabled={isToggling}
                              className={`px-3 py-1.5 rounded-md text-[11.5px] font-semibold uppercase tracking-wider transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${c.isActive ? "bg-slate-100 text-slate-600 hover:bg-slate-200" : "bg-indigo-50 text-indigo-700 hover:bg-indigo-100"}`}>
                              {isToggling ? "…" : c.isActive ? "Deactivate" : "Reactivate"}
                            </button>
                          </>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
              {catEditError && editingCatId && <p className="mt-2 text-[12px] text-rose-600">{catEditError}</p>}
            </div>
            <div className="flex items-center justify-end px-5 py-3 border-t border-slate-200">
              <button type="button" onClick={closeCategoryModal} disabled={!!(savingCatEdit || creatingCat || togglingCatId)}
                className="px-4 py-2 rounded-lg text-slate-600 hover:bg-slate-100 text-[13px] font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed">Done</button>
            </div>
          </div>
        </div>
      )}

      {/* ─── ADD ITEM MODAL ───────────────────────────────── */}
      {itemModalOpen && (
        <div className="fixed inset-0 bg-slate-900/40 flex items-center justify-center z-50 p-6" onClick={closeItemModal}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-xl max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
              <h2 className="text-[15px] font-semibold text-slate-800">Add Inventory Item</h2>
              <button type="button" onClick={closeItemModal} disabled={creatingItem} className="text-slate-400 hover:text-slate-700 disabled:opacity-40 disabled:cursor-not-allowed" aria-label="Close">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-5 h-5"><path d="M18 6L6 18M6 6l12 12" /></svg>
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
              <div className="space-y-1">
                <label className="block text-[12px] font-semibold text-slate-500 uppercase tracking-wider">Name</label>
                <input type="text" value={itName} onChange={(e) => setItName(e.target.value)}
                  placeholder="e.g. 500ml Water Bottle, Samsung 1.5-ton AC" disabled={creatingItem}
                  className={inputCls(!!createItemFieldErrors.name)} />
                {createItemFieldErrors.name && <p className="text-[11.5px] text-rose-600">{createItemFieldErrors.name}</p>}
              </div>
              <div className="space-y-1">
                <label className="block text-[12px] font-semibold text-slate-500 uppercase tracking-wider">Category (optional)</label>
                <select value={itCategoryId} onChange={(e) => setItCategoryId(e.target.value)} disabled={creatingItem} className={inputCls(false)}>
                  <option value="">— uncategorized —</option>
                  {activeCategories.map((c) => (<option key={c.id} value={c.id}>{c.name}</option>))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="block text-[12px] font-semibold text-slate-500 uppercase tracking-wider">Type</label>
                  <select value={itType} onChange={(e) => setItType(e.target.value as InventoryItemType)} disabled={creatingItem} className={inputCls(false)}>
                    {ITEM_TYPES.map((t) => (<option key={t.value} value={t.value}>{t.label}</option>))}
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="block text-[12px] font-semibold text-slate-500 uppercase tracking-wider">Unit</label>
                  <select value={itUnit} onChange={(e) => setItUnit(e.target.value as InventoryItemUnit)} disabled={creatingItem} className={inputCls(false)}>
                    {ITEM_UNITS.map((u) => (<option key={u.value} value={u.value}>{u.label}</option>))}
                  </select>
                </div>
              </div>
              <div className="space-y-1">
                <label className="block text-[12px] font-semibold text-slate-500 uppercase tracking-wider">Notes (optional)</label>
                <input type="text" value={itNotes} onChange={(e) => setItNotes(e.target.value)}
                  placeholder="e.g. brand, supplier, model" disabled={creatingItem} className={inputCls(false)} />
              </div>
              {createItemError && (
                <div className="bg-rose-50 border border-rose-200 rounded-lg px-3 py-2 text-[12px] text-rose-700">{createItemError}</div>
              )}
            </div>
            <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-slate-200">
              <button type="button" onClick={closeItemModal} disabled={creatingItem}
                className="px-4 py-2 rounded-lg text-slate-600 hover:bg-slate-100 text-[13px] font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed">Cancel</button>
              <button type="button" onClick={handleCreateItem} disabled={creatingItem}
                className="px-4 py-2 rounded-lg bg-indigo-700 text-white text-[13px] font-semibold hover:bg-indigo-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                {creatingItem ? "Saving…" : "Save Item"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── ADD STOCK (MANUAL PURCHASE) MODAL ────────────── */}
      {stockModalOpen && (
        <div className="fixed inset-0 bg-slate-900/40 flex items-center justify-center z-50 p-6" onClick={closeStockModal}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-xl max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
              <h2 className="text-[15px] font-semibold text-slate-800">Add Stock (Manual)</h2>
              <button type="button" onClick={closeStockModal} disabled={creatingStock} className="text-slate-400 hover:text-slate-700 disabled:opacity-40 disabled:cursor-not-allowed" aria-label="Close">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-5 h-5"><path d="M18 6L6 18M6 6l12 12" /></svg>
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
              <p className="text-[12.5px] text-slate-500 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
                Use this only for opening stock or corrections — purchases made through expense should go through the Expense form (the inventory toggle there).
              </p>
              <div className="space-y-1">
                <label className="block text-[12px] font-semibold text-slate-500 uppercase tracking-wider">Date</label>
                <input type="date" value={stockDate} max={todayISO()}
                  onChange={(e) => setStockDate(e.target.value)} disabled={creatingStock}
                  className={inputCls(!!createStockFieldErrors.date)} />
                {createStockFieldErrors.date && <p className="text-[11.5px] text-rose-600">{createStockFieldErrors.date}</p>}
              </div>
              <div className="space-y-1">
                <label className="block text-[12px] font-semibold text-slate-500 uppercase tracking-wider">Item</label>
                <select value={stockItemId} onChange={(e) => setStockItemId(e.target.value)} disabled={creatingStock} className={inputCls(!!createStockFieldErrors.itemId)}>
                  <option value="">Select an item…</option>
                  {items.filter(i => i.isActive).map((i) => (<option key={i.id} value={i.id}>{i.name} ({i.unit})</option>))}
                </select>
                {createStockFieldErrors.itemId && <p className="text-[11.5px] text-rose-600">{createStockFieldErrors.itemId}</p>}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="block text-[12px] font-semibold text-slate-500 uppercase tracking-wider">Quantity</label>
                  <input type="number" inputMode="decimal" step="0.01" min="0.01" value={stockQuantity}
                    onChange={(e) => setStockQuantity(e.target.value)} placeholder="0" disabled={creatingStock}
                    className={inputCls(!!createStockFieldErrors.quantity)} />
                  {createStockFieldErrors.quantity && <p className="text-[11.5px] text-rose-600">{createStockFieldErrors.quantity}</p>}
                </div>
                <div className="space-y-1">
                  <label className="block text-[12px] font-semibold text-slate-500 uppercase tracking-wider">Unit Price (৳)</label>
                  <input type="number" inputMode="decimal" step="0.01" min="0" value={stockUnitPrice}
                    onChange={(e) => setStockUnitPrice(e.target.value)} placeholder="0.00" disabled={creatingStock}
                    className={inputCls(!!createStockFieldErrors.unitPrice)} />
                  {createStockFieldErrors.unitPrice && <p className="text-[11.5px] text-rose-600">{createStockFieldErrors.unitPrice}</p>}
                </div>
              </div>
              <div className="space-y-1">
                <label className="block text-[12px] font-semibold text-slate-500 uppercase tracking-wider">Reason</label>
                <input type="text" value={stockReason} onChange={(e) => setStockReason(e.target.value)}
                  placeholder="e.g. Opening stock, Correction after audit" disabled={creatingStock}
                  className={inputCls(!!createStockFieldErrors.reason)} />
                {createStockFieldErrors.reason && <p className="text-[11.5px] text-rose-600">{createStockFieldErrors.reason}</p>}
              </div>
              {createStockError && (
                <div className="bg-rose-50 border border-rose-200 rounded-lg px-3 py-2 text-[12px] text-rose-700">{createStockError}</div>
              )}
            </div>
            <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-slate-200">
              <button type="button" onClick={closeStockModal} disabled={creatingStock}
                className="px-4 py-2 rounded-lg text-slate-600 hover:bg-slate-100 text-[13px] font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed">Cancel</button>
              <button type="button" onClick={handleCreateStock} disabled={creatingStock}
                className="px-4 py-2 rounded-lg bg-indigo-700 text-white text-[13px] font-semibold hover:bg-indigo-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                {creatingStock ? "Saving…" : "Save Stock"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── EDIT ITEM MODAL ─────────────────────────────── */}
      {editModalOpen && editingItem && (
        <div className="fixed inset-0 bg-slate-900/40 flex items-center justify-center z-50 p-6" onClick={closeEditModal}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-xl max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
              <h2 className="text-[15px] font-semibold text-slate-800">Edit Inventory Item</h2>
              <button type="button" onClick={closeEditModal} disabled={savingEdit} className="text-slate-400 hover:text-slate-700 disabled:opacity-40 disabled:cursor-not-allowed" aria-label="Close">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-5 h-5"><path d="M18 6L6 18M6 6l12 12" /></svg>
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">

              {editMovementCount > 0 && (
                <p className="text-[12px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                  This item has {editMovementCount} stock movement{editMovementCount === 1 ? "" : "s"}. Type and unit are locked to preserve audit integrity. You can still edit name, category, notes, and active status.
                </p>
              )}

              <div className="space-y-1">
                <label className="block text-[12px] font-semibold text-slate-500 uppercase tracking-wider">Name</label>
                <input type="text" value={edName} onChange={(e) => setEdName(e.target.value)}
                  disabled={savingEdit} className={inputCls(!!editFieldErrors.name)} />
                {editFieldErrors.name && <p className="text-[11.5px] text-rose-600">{editFieldErrors.name}</p>}
              </div>

              <div className="space-y-1">
                <label className="block text-[12px] font-semibold text-slate-500 uppercase tracking-wider">Category</label>
                <select value={edCategoryId} onChange={(e) => setEdCategoryId(e.target.value)}
                  disabled={savingEdit} className={inputCls(false)}>
                  <option value="">— uncategorized —</option>
                  {activeCategories.map((c) => (<option key={c.id} value={c.id}>{c.name}</option>))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="block text-[12px] font-semibold text-slate-500 uppercase tracking-wider">
                    Type {editMovementCount > 0 && <span className="text-amber-600 normal-case font-normal">(locked)</span>}
                  </label>
                  <select value={edType} onChange={(e) => setEdType(e.target.value as InventoryItemType)}
                    disabled={savingEdit || editMovementCount > 0} className={inputCls(false)}>
                    {ITEM_TYPES.map((t) => (<option key={t.value} value={t.value}>{t.label}</option>))}
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="block text-[12px] font-semibold text-slate-500 uppercase tracking-wider">
                    Unit {editMovementCount > 0 && <span className="text-amber-600 normal-case font-normal">(locked)</span>}
                  </label>
                  <select value={edUnit} onChange={(e) => setEdUnit(e.target.value as InventoryItemUnit)}
                    disabled={savingEdit || editMovementCount > 0} className={inputCls(false)}>
                    {ITEM_UNITS.map((u) => (<option key={u.value} value={u.value}>{u.label}</option>))}
                  </select>
                </div>
              </div>

              <div className="space-y-1">
                <label className="block text-[12px] font-semibold text-slate-500 uppercase tracking-wider">Notes</label>
                <input type="text" value={edNotes} onChange={(e) => setEdNotes(e.target.value)}
                  disabled={savingEdit} className={inputCls(false)} />
              </div>

              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={edIsActive} onChange={(e) => setEdIsActive(e.target.checked)}
                  disabled={savingEdit} className="w-4 h-4 accent-indigo-600" />
                <span className="text-[13px] text-slate-700">Active (uncheck to hide from new entries)</span>
              </label>

              {editError && (
                <div className="bg-rose-50 border border-rose-200 rounded-lg px-3 py-2 text-[12px] text-rose-700">{editError}</div>
              )}
            </div>
            <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-slate-200">
              <button type="button" onClick={closeEditModal} disabled={savingEdit}
                className="px-4 py-2 rounded-lg text-slate-600 hover:bg-slate-100 text-[13px] font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed">Cancel</button>
              <button type="button" onClick={handleSaveEdit} disabled={savingEdit}
                className="px-4 py-2 rounded-lg bg-indigo-700 text-white text-[13px] font-semibold hover:bg-indigo-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                {savingEdit ? "Saving…" : "Save Changes"}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

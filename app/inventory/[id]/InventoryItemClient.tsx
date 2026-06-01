"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  getInventoryItemById,
  getMovementsByItem,
  getStockForItem,
  type InventoryItem,
  type InventoryMovement,
  type InventoryMovementType,
} from "@/services/inventoryService";
import {
  getInventoryCategories,
  type InventoryCategory,
} from "@/services/inventoryCategoriesService";
import { getAllRooms } from "@/services/roomsService";
import type { MockRoom } from "@/lib/mockData";
import { getAllEmployees, type Employee } from "@/services/employeesService";

const TYPE_LABEL: Record<InventoryMovementType, string> = {
  purchase: "Purchase", issue: "Issue", damage: "Damage", adjustment: "Adjustment", transfer: "Transfer",
};
const TYPE_BADGE: Record<InventoryMovementType, string> = {
  purchase:   "bg-emerald-50 text-emerald-700 border-emerald-200",
  issue:      "bg-sky-50 text-sky-700 border-sky-200",
  damage:     "bg-rose-50 text-rose-700 border-rose-200",
  adjustment: "bg-amber-50 text-amber-700 border-amber-200",
  transfer:   "bg-violet-50 text-violet-700 border-violet-200",
};

// Mirrors getStockForAllItems: purchase +q, issue/damage -q, adjustment signed, transfer 0
function stockDelta(m: InventoryMovement): number {
  switch (m.type) {
    case "purchase":   return +m.quantity;
    case "issue":      return -m.quantity;
    case "damage":     return -m.quantity;
    case "adjustment": return +m.quantity;
    case "transfer":   return 0;
  }
}
function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

export default function InventoryItemClient({ itemId }: { itemId: string }) {
  const [item, setItem]             = useState<InventoryItem | null>(null);
  const [movements, setMovements]   = useState<InventoryMovement[]>([]);
  const [stock, setStock]           = useState<number>(0);
  const [categories, setCategories] = useState<InventoryCategory[]>([]);
  const [rooms, setRooms]           = useState<MockRoom[]>([]);
  const [employees, setEmployees]   = useState<Employee[]>([]);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [it, mv, stk, cats, rms, emps] = await Promise.all([
          getInventoryItemById(itemId),
          getMovementsByItem(itemId),
          getStockForItem(itemId),
          getInventoryCategories(),
          getAllRooms(),
          getAllEmployees(),
        ]);
        if (cancelled) return;
        setItem(it); setMovements(mv); setStock(stk);
        setCategories(cats); setRooms(rms); setEmployees(emps);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load item.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [itemId]);

  const categoryName = (id: string | null) => id ? (categories.find(c => c.id === id)?.name ?? "—") : "—";
  const roomName = (id: string | null) => { if (!id) return null; const r = rooms.find(x => x.id === id); return r ? `Room ${r.roomNumber}` : "Room ?"; };
  const employeeName = (id: string | null) => { if (!id) return null; const e = employees.find(x => x.id === id); return e ? e.fullName : "Employee ?"; };

  if (loading) return <div className="px-6 py-10 text-[13px] text-slate-500">Loading…</div>;
  if (error || !item) return (
    <div className="px-6 py-10 space-y-3">
      <Link href="/inventory" className="text-[13px] text-indigo-700 hover:underline">← Back to inventory</Link>
      <p className="text-[13px] text-rose-600">{error ?? "Item not found."}</p>
    </div>
  );

  const lowStock = item.lowStockThreshold != null && stock <= item.lowStockThreshold;

  return (
    <div className="max-w-4xl mx-auto px-6 py-8 space-y-6">
      <Link href="/inventory" className="inline-flex items-center gap-1 text-[13px] text-indigo-700 hover:underline">← Back to inventory</Link>

      <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-[20px] font-semibold text-slate-800">{item.name}</h1>
            <p className="text-[12.5px] text-slate-500 mt-0.5">
              {item.type === "durable" ? "Durable" : "Consumable"} · {item.unit} · {categoryName(item.categoryId)}
            </p>
          </div>
          <div className="text-right">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Current stock</div>
            <div className={`text-[26px] font-bold leading-tight ${stock < 0 ? "text-rose-600" : "text-slate-800"}`}>{stock}</div>
            {lowStock && <span className="inline-block mt-1 px-2 py-0.5 rounded-full bg-amber-50 border border-amber-200 text-amber-700 text-[11px] font-semibold">Low stock (≤ {item.lowStockThreshold})</span>}
            {!item.isActive && <span className="inline-block mt-1 px-2 py-0.5 rounded-full bg-slate-100 border border-slate-200 text-slate-500 text-[11px] font-semibold">Inactive</span>}
          </div>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-200 flex items-center justify-between">
          <h2 className="text-[14px] font-semibold text-slate-800">Movement history</h2>
          <span className="text-[12px] text-slate-400">{movements.length} record{movements.length === 1 ? "" : "s"}</span>
        </div>
        {movements.length === 0 ? (
          <div className="px-5 py-8 text-[13px] text-slate-500 text-center">No movements recorded for this item yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-left text-[11px] font-semibold uppercase tracking-wider text-slate-400 border-b border-slate-100">
                  <th className="px-5 py-2.5">Date</th><th className="px-5 py-2.5">Type</th>
                  <th className="px-5 py-2.5 text-right">Change</th><th className="px-5 py-2.5">Details</th>
                </tr>
              </thead>
              <tbody>
                {movements.map((m) => {
                  const delta = stockDelta(m);
                  const from = roomName(m.fromRoomId);
                  const to = roomName(m.toRoomId);
                  const emp = employeeName(m.issuedToEmployeeId);
                  const details: string[] = [];
                  if (m.type === "purchase" && m.unitPrice != null) details.push(`@ ৳${m.unitPrice}/unit`);
                  if (m.type === "transfer" && (from || to)) details.push(`${from ?? "?"} → ${to ?? "?"}`);
                  else if (from) details.push(`from ${from}`);
                  if (emp) details.push(`to ${emp}`);
                  if (m.reasonNote) details.push(m.reasonNote);
                  return (
                    <tr key={m.id} className="border-b border-slate-50 last:border-0">
                      <td className="px-5 py-3 text-slate-600 whitespace-nowrap">{fmtDate(m.happenedAt)}</td>
                      <td className="px-5 py-3"><span className={`inline-block px-2 py-0.5 rounded-full border text-[11.5px] font-semibold ${TYPE_BADGE[m.type]}`}>{TYPE_LABEL[m.type]}</span></td>
                      <td className={`px-5 py-3 text-right font-semibold whitespace-nowrap ${delta > 0 ? "text-emerald-700" : delta < 0 ? "text-rose-600" : "text-slate-400"}`}>{delta > 0 ? `+${delta}` : delta < 0 ? `${delta}` : "0"}</td>
                      <td className="px-5 py-3 text-slate-500">{details.join(" · ") || "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

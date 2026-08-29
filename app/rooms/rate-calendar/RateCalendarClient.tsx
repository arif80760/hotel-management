"use client";

// app/rooms/rate-calendar/RateCalendarClient.tsx
//
// Rate Calendar admin UI — list / add / edit / deactivate rate periods
// ("Eid Peak", "December High Season"). Periods change ONLY the booking
// form's prefilled default rate; a manually typed rate always wins and
// existing bookings never recalculate (see ratePeriodsService header).
// Overlap protection is the DB exclusion constraint — a 23P01 arrives as
// the service's friendly message and is shown inline.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  getRatePeriods, createRatePeriod, updateRatePeriod, setRatePeriodActive,
  type RatePeriod,
} from "@/services/ratePeriodsService";
import { getRoomCategories, type RoomCategory } from "@/services/roomCategoriesService";
import { readSessionCache, writeSessionCache } from "@/lib/sessionCache";
import { useSlowWatch } from "@/components/SlowConnectionNotice";

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function fmtDate(iso: string): string {
  return new Date(`${iso}T12:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

type FormState = {
  id: string | null;   // null = adding, id = editing
  category: string;
  label: string;
  startDate: string;
  endDate: string;
  rate: string;
};

const EMPTY_FORM: FormState = { id: null, category: "", label: "", startDate: "", endDate: "", rate: "" };

export default function RateCalendarClient() {
  // Content-first (2026-08-25): seed from session cache; background refresh.
  const cachedRC = readSessionCache<{ p: RatePeriod[]; c: RoomCategory[] }>("rate-calendar-page");
  const hadRCCache = cachedRC !== null;
  const [periods, setPeriods] = useState<RatePeriod[]>(cachedRC?.p ?? []);
  const [categories, setCategories] = useState<RoomCategory[]>(cachedRC?.c ?? []);
  const [loading, setLoading] = useState(!hadRCCache);
  useSlowWatch("rate-calendar-page", loading);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [form, setForm] = useState<FormState | null>(null);   // null = closed
  const [formError, setFormError] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string>("");

  const catName = useMemo(
    () => new Map(categories.map((c) => [c.slug, c.name])),
    [categories],
  );

  async function reload() {
    try {
      const [p, c] = await Promise.all([getRatePeriods(), getRoomCategories()]);
      setPeriods(p);
      const activeCats = c.filter((x) => x.isActive);
      setCategories(activeCats);
      writeSessionCache("rate-calendar-page", { p, c: activeCats });
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { reload(); }, []);

  function openAdd() {
    setFormError("");
    setForm({ ...EMPTY_FORM, category: categories[0]?.slug ?? "" });
  }
  function openEdit(p: RatePeriod) {
    setFormError("");
    setForm({ id: p.id, category: p.category, label: p.label, startDate: p.startDate, endDate: p.endDate, rate: String(p.rate) });
  }

  async function handleSave() {
    if (!form || saving) return;
    const rate = parseFloat(form.rate);
    if (!form.category)                    return setFormError("Choose a category.");
    if (form.label.trim() === "")          return setFormError("Give the period a label (e.g. \"Eid Peak\").");
    if (!form.startDate || !form.endDate)  return setFormError("Set both dates.");
    if (form.endDate < form.startDate)     return setFormError("End date is before start date.");
    if (!Number.isFinite(rate) || rate <= 0) return setFormError("Enter a rate above zero.");
    setSaving(true);
    setFormError("");
    try {
      if (form.id === null) {
        await createRatePeriod({ category: form.category, startDate: form.startDate, endDate: form.endDate, rate, label: form.label });
      } else {
        // Category is fixed once created (change = deactivate + new period).
        await updateRatePeriod(form.id, { startDate: form.startDate, endDate: form.endDate, rate, label: form.label });
      }
      setForm(null);
      await reload();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleToggle(p: RatePeriod) {
    if (togglingId) return;
    setTogglingId(p.id);
    setActionError("");
    try {
      await setRatePeriodActive(p.id, !p.isActive);
      await reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setTogglingId(null);
    }
  }

  const today = todayISO();

  return (
    <div className="max-w-3xl mx-auto">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-bold text-slate-800">Rate Calendar</h1>
          <p className="text-[12.5px] text-slate-500 max-w-xl">
            Seasonal / event rates per category. A period changes only the <b>prefilled</b> rate
            when a room is selected in the booking form — a typed rate always wins, and existing
            bookings are never changed.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/rooms" className="text-[13px] text-slate-500 hover:text-slate-800 px-2 py-2 transition-colors">← Rooms</Link>
          <button
            onClick={openAdd}
            className="flex items-center gap-2 bg-slate-900 hover:bg-slate-800 text-white text-[13px] font-medium px-4 py-2.5 rounded-lg transition-colors shadow-sm min-h-[44px]"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-4 h-4"><path d="M12 5v14M5 12h14"/></svg>
            Add Rate Period
          </button>
        </div>
      </div>

      {loadError && (
        <div className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-[13px] text-rose-700">Couldn&apos;t load: {loadError}</div>
      )}
      {actionError && (
        <div className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-[13px] text-rose-700">{actionError}</div>
      )}

      {/* ── Add / Edit form (inline card) ─────────────────── */}
      {form && (
        <div className="mb-5 rounded-xl border border-slate-200 bg-white p-4">
          <p className="mb-3 text-[13px] font-semibold text-slate-700">{form.id ? "Edit rate period" : "New rate period"}</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-[11.5px] font-semibold text-slate-500 uppercase tracking-wide mb-1.5">Category</label>
              <select
                value={form.category}
                onChange={(e) => setForm({ ...form, category: e.target.value })}
                disabled={form.id !== null}
                className="w-full px-3.5 py-2.5 text-[13.5px] bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-amber-400 disabled:bg-slate-50 disabled:text-slate-500"
              >
                {categories.map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}
              </select>
              {form.id !== null && <p className="mt-1 text-[11px] text-slate-400">Category is fixed — deactivate and add a new period to move it.</p>}
            </div>
            <div>
              <label className="block text-[11.5px] font-semibold text-slate-500 uppercase tracking-wide mb-1.5">Label</label>
              <input
                type="text" value={form.label} placeholder={'e.g. "Eid Peak"'}
                onChange={(e) => setForm({ ...form, label: e.target.value })}
                className="w-full px-3.5 py-2.5 text-[13.5px] bg-white border border-slate-200 rounded-lg placeholder:text-slate-300 focus:outline-none focus:ring-2 focus:ring-amber-400"
              />
            </div>
            <div>
              <label className="block text-[11.5px] font-semibold text-slate-500 uppercase tracking-wide mb-1.5">First night</label>
              <input
                type="date" value={form.startDate} max={form.endDate || undefined}
                onChange={(e) => setForm({ ...form, startDate: e.target.value })}
                className="w-full px-3.5 py-2.5 text-[13.5px] bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-amber-400"
              />
            </div>
            <div>
              <label className="block text-[11.5px] font-semibold text-slate-500 uppercase tracking-wide mb-1.5">Last night (inclusive)</label>
              <input
                type="date" value={form.endDate} min={form.startDate || undefined}
                onChange={(e) => setForm({ ...form, endDate: e.target.value })}
                className="w-full px-3.5 py-2.5 text-[13.5px] bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-amber-400"
              />
            </div>
            <div>
              <label className="block text-[11.5px] font-semibold text-slate-500 uppercase tracking-wide mb-1.5">Rate / night</label>
              <div className="relative">
                <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 font-semibold pointer-events-none text-[13px]">৳</span>
                <input
                  type="number" min={0} step="0.01" value={form.rate}
                  onChange={(e) => setForm({ ...form, rate: e.target.value })}
                  onWheel={(e) => (e.target as HTMLInputElement).blur()}
                  className="w-full pl-7 pr-3.5 py-2.5 text-[13.5px] bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-amber-400 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                />
              </div>
            </div>
          </div>
          {formError && <p className="mt-3 text-[12.5px] text-rose-600">{formError}</p>}
          <div className="mt-4 flex items-center gap-2">
            <button
              onClick={handleSave} disabled={saving}
              className="bg-slate-900 hover:bg-slate-800 text-white text-[13px] font-medium px-4 py-2.5 rounded-lg transition-colors disabled:opacity-50 min-h-[44px]"
            >
              {saving ? "Saving…" : form.id ? "Save changes" : "Add period"}
            </button>
            <button
              onClick={() => setForm(null)} disabled={saving}
              className="text-slate-500 hover:bg-slate-100 text-[13px] font-medium px-4 py-2.5 rounded-lg transition-colors disabled:opacity-40 min-h-[44px]"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* ── Period list ───────────────────────────────────── */}
      <div className="rounded-xl border border-slate-200 bg-white divide-y divide-slate-100">
        {loading && <p className="px-4 py-6 text-[13px] text-slate-400">Loading…</p>}
        {!loading && periods.length === 0 && (
          <p className="px-4 py-6 text-[13px] text-slate-400 italic">No rate periods yet — add the first one for a peak season or event.</p>
        )}
        {periods.map((p) => {
          const past = p.endDate < today;
          return (
            <div key={p.id} className={`flex flex-wrap items-center gap-x-4 gap-y-1.5 px-4 py-3 ${!p.isActive ? "opacity-60" : ""}`}>
              <div className="flex-1 min-w-[180px]">
                <p className="text-[13.5px] font-semibold text-slate-800">
                  {p.label}
                  {!p.isActive && <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 text-[10.5px] font-semibold uppercase tracking-wider">Inactive</span>}
                  {p.isActive && past && <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 text-[10.5px] font-semibold uppercase tracking-wider">Past</span>}
                </p>
                <p className="text-[12px] text-slate-500">
                  {catName.get(p.category) ?? p.category} · {fmtDate(p.startDate)} – {fmtDate(p.endDate)}
                </p>
              </div>
              <p className="text-[14px] font-semibold text-slate-800 tabular-nums">৳{p.rate.toLocaleString()}<span className="text-[11px] font-normal text-slate-400">/night</span></p>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => openEdit(p)}
                  className="px-3 py-1.5 rounded-md text-[11.5px] font-semibold uppercase tracking-wider bg-slate-100 text-slate-600 hover:bg-slate-200 transition-colors min-h-[36px]"
                >
                  Edit
                </button>
                <button
                  onClick={() => handleToggle(p)}
                  disabled={togglingId === p.id}
                  className={`px-3 py-1.5 rounded-md text-[11.5px] font-semibold uppercase tracking-wider transition-colors disabled:opacity-40 min-h-[36px] ${
                    p.isActive ? "bg-slate-100 text-slate-600 hover:bg-slate-200" : "bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
                  }`}
                >
                  {togglingId === p.id ? "…" : p.isActive ? "Deactivate" : "Reactivate"}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

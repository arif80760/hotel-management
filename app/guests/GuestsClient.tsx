"use client";

// app/guests/GuestsClient.tsx
//
// Full CRUD guest management — connected to Supabase.
//
// Features:
//  • Live search by name, email, or nationality
//  • Add guest — modal form, validated
//  • Edit guest — same modal, pre-filled
//  • Delete guest — inline two-step confirmation per row
//  • VIP badge toggle in the form
//  • Success banner, auto-dismisses after 4 s
//
// All data operations go through guestsService (Supabase queries).
// Each handler does an optimistic local-state update first,
// then persists to Supabase in the background.

import { useState, useEffect } from "react";
import type { MockGuest } from "@/lib/mockData";
import * as guestsService from "@/services/guestsService";

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

function initials(name: string): string {
  return name.trim().split(/\s+/).map(w => w[0]).join("").slice(0, 2).toUpperCase();
}

const AVATAR_COLORS = [
  "bg-violet-100 text-violet-700",
  "bg-blue-100   text-blue-700",
  "bg-emerald-100 text-emerald-700",
  "bg-rose-100   text-rose-700",
  "bg-amber-100  text-amber-700",
  "bg-teal-100   text-teal-700",
  "bg-indigo-100 text-indigo-700",
  "bg-pink-100   text-pink-700",
];
function avatarColor(name: string): string {
  return AVATAR_COLORS[(name.charCodeAt(0) || 0) % AVATAR_COLORS.length];
}

// ─────────────────────────────────────────────────────────────
// FORM TYPE  (maps 1-to-1 with the modal fields)
// ─────────────────────────────────────────────────────────────
type GuestForm = {
  name:        string;
  email:       string;
  phone:       string;
  nationality: string;
  notes:       string;
  vip:         boolean;
};

const EMPTY_FORM: GuestForm = {
  name: "", email: "", phone: "", nationality: "", notes: "", vip: false,
};

// ─────────────────────────────────────────────────────────────
// COMPONENT
// ─────────────────────────────────────────────────────────────
export default function GuestsClient() {

  // ── State ──────────────────────────────────────────────────

  // Full guest list — starts empty; populated from Supabase on mount
  const [guests,         setGuests]         = useState<MockGuest[]>([]);

  // Search query — filters the table in real time
  const [search,         setSearch]         = useState("");

  // Modal visibility
  const [modalOpen,      setModalOpen]      = useState(false);

  // null  = adding a new guest
  // "G-X" = editing the guest with that id
  const [editingId,      setEditingId]      = useState<string | null>(null);

  // Controlled form values
  const [form,           setForm]           = useState<GuestForm>(EMPTY_FORM);

  // Validation errors keyed by field name
  const [errors,         setErrors]         = useState<Partial<Record<keyof GuestForm, string>>>({});

  // Which guest id is pending a delete confirmation (null = none)
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  // Transient success message
  const [successMsg,     setSuccessMsg]     = useState("");

  // Auto-increment suffix for new guest IDs
  const [nextId,         setNextId]         = useState(guests.length + 1);

  // ── Derived ────────────────────────────────────────────────
  // Search is delegated to guestsService — returns all guests when query is empty.
  const filteredGuests = guestsService.searchGuests(guests, search);

  const vipCount = guests.filter(g => g.vip).length;

  // ── Effects ────────────────────────────────────────────────

  // Load all guests from Supabase on first render.
  useEffect(() => {
    guestsService.getAllGuests()
      .then(setGuests)
      .catch(err => console.error("[GuestsClient] Failed to load guests:", err));
  }, []);

  useEffect(() => {
    if (!successMsg) return;
    const t = setTimeout(() => setSuccessMsg(""), 4000);
    return () => clearTimeout(t);
  }, [successMsg]);

  // Trap focus / close modal on Escape
  useEffect(() => {
    if (!modalOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") closeModal();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [modalOpen]);

  // ── Modal helpers ──────────────────────────────────────────
  function openAddModal() {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setErrors({});
    setModalOpen(true);
  }

  function openEditModal(guest: MockGuest) {
    setEditingId(guest.id);
    setForm({
      name:        guest.name,
      email:       guest.email,
      phone:       guest.phone,
      nationality: guest.nationality,
      notes:       guest.notes,
      vip:         guest.vip,
    });
    setErrors({});
    setModalOpen(true);
  }

  function closeModal() {
    setModalOpen(false);
    setForm(EMPTY_FORM);
    setErrors({});
  }

  // ── Form helpers ───────────────────────────────────────────
  function setField<K extends keyof GuestForm>(key: K, value: GuestForm[K]) {
    setForm(prev => ({ ...prev, [key]: value }));
    if (errors[key]) setErrors(prev => ({ ...prev, [key]: undefined }));
  }

  function validate(): boolean {
    const e: Partial<Record<keyof GuestForm, string>> = {};
    if (!form.name.trim())  e.name  = "Full name is required.";
    if (!form.phone.trim()) e.phone = "Phone number is required.";
    if (!form.email.trim()) {
      e.email = "Email is required.";
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) {
      e.email = "Enter a valid email address.";
    }
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  // ── CRUD handlers ──────────────────────────────────────────

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validate()) return;

    if (editingId) {
      // ── Update existing guest ───────────────────────────────
      const updates: Partial<Omit<MockGuest, "id">> = {
        name:        form.name.trim(),
        email:       form.email.trim(),
        phone:       form.phone.trim(),
        nationality: form.nationality.trim(),
        notes:       form.notes.trim(),
        vip:         form.vip,
      };
      // Optimistic: update local list immediately
      setGuests(prev =>
        prev.map(g => g.id === editingId ? { ...g, ...updates } : g)
      );
      setSuccessMsg(`Guest profile updated — ${form.name.trim()}`);
      // Persist to Supabase in the background
      guestsService.updateGuest(editingId, updates).catch(err =>
        console.error("[updateGuest] Supabase error:", err)
      );
    } else {
      // ── Add new guest ───────────────────────────────────────
      const optimisticGuest: MockGuest = {
        id:          `pending-${nextId}`,    // temp id; replaced by UUID on refetch
        name:        form.name.trim(),
        email:       form.email.trim(),
        phone:       form.phone.trim(),
        nationality: form.nationality.trim() || "—",
        notes:       form.notes.trim(),
        vip:         form.vip,
      };
      // Optimistic: show in list immediately
      setGuests(prev => [optimisticGuest, ...prev]);
      setNextId(n => n + 1);
      setSuccessMsg(`Guest added — ${optimisticGuest.name}`);
      // Persist to Supabase; replace optimistic entry with real DB record
      guestsService.addGuest(optimisticGuest).then(saved => {
        setGuests(prev =>
          prev.map(g => g.id === optimisticGuest.id ? saved : g)
        );
      }).catch(err => {
        console.error("[addGuest] Supabase error:", err);
        // Remove the failed optimistic entry
        setGuests(prev => prev.filter(g => g.id !== optimisticGuest.id));
      });
    }

    closeModal();
  }

  function handleDeleteClick(id: string) {
    setDeleteConfirmId(id);  // first click → show confirmation
  }

  function confirmDelete(id: string) {
    const target = guests.find(g => g.id === id);
    const name   = target?.name ?? "Guest";
    // Optimistic: remove from list immediately
    setGuests(prev => prev.filter(g => g.id !== id));
    setDeleteConfirmId(null);
    setSuccessMsg(`${name} removed from guest list.`);
    // Persist to Supabase in the background
    guestsService.deleteGuest(id).catch(err => {
      console.error("[deleteGuest] Supabase error:", err);
      // Restore the entry if the delete failed
      if (target) setGuests(prev => [...prev, target]);
    });
  }

  // ── Render ─────────────────────────────────────────────────
  return (
    <div className="p-7 max-w-[1400px]">

      {/* ══════════════════════════════════════════════════════
          PAGE HEADER
      ══════════════════════════════════════════════════════ */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-[22px] font-semibold text-slate-900 tracking-tight">Guests</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            {guests.length} registered guests
            {vipCount > 0 && (
              <> · <span className="text-amber-600 font-medium">{vipCount} VIP</span></>
            )}
          </p>
        </div>
        <button
          onClick={openAddModal}
          className="flex items-center gap-2 bg-slate-900 hover:bg-slate-800 text-white text-[13px] font-medium px-4 py-2.5 rounded-lg transition-colors shadow-sm"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-4 h-4">
            <path d="M12 5v14M5 12h14" />
          </svg>
          Add Guest
        </button>
      </div>

      {/* ══════════════════════════════════════════════════════
          SUCCESS BANNER
      ══════════════════════════════════════════════════════ */}
      {successMsg && (
        <div className="flex items-center gap-3 mb-5 bg-emerald-50 border border-emerald-200 rounded-xl px-5 py-3.5">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-5 h-5 text-emerald-600 flex-shrink-0">
            <path d="M22 11.08V12a10 10 0 11-5.93-9.14" /><path d="M22 4L12 14.01l-3-3" />
          </svg>
          <p className="text-[13px] font-medium text-emerald-800">{successMsg}</p>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════
          SEARCH BAR
      ══════════════════════════════════════════════════════ */}
      <div className="relative mb-6 max-w-sm">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none">
          <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
        </svg>
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search by name, email, or nationality…"
          className="w-full pl-10 pr-4 py-2.5 text-[13px] text-slate-800 bg-white border border-slate-200 rounded-lg shadow-sm
            placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-amber-400 focus:border-transparent transition"
        />
        {search && (
          <button
            onClick={() => setSearch("")}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 transition-colors"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-3.5 h-3.5">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>

      {/* ══════════════════════════════════════════════════════
          GUESTS TABLE
      ══════════════════════════════════════════════════════ */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200">
                {["Guest", "Contact", "Nationality", "Notes", "Actions"].map(h => (
                  <th
                    key={h}
                    className="text-left px-5 py-3 text-[11px] font-semibold text-slate-400 uppercase tracking-wider whitespace-nowrap"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredGuests.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-5 py-14 text-center">
                    <p className="text-[13px] text-slate-400">
                      {search ? `No guests found matching "${search}".` : "No guests yet."}
                    </p>
                    {!search && (
                      <button
                        onClick={openAddModal}
                        className="mt-3 text-[13px] font-medium text-amber-600 hover:text-amber-700 transition-colors"
                      >
                        Add your first guest →
                      </button>
                    )}
                  </td>
                </tr>
              ) : (
                filteredGuests.map(guest => (
                  <tr
                    key={guest.id}
                    className={`transition-colors ${
                      deleteConfirmId === guest.id
                        ? "bg-red-50/60"
                        : "hover:bg-slate-50/70"
                    }`}
                  >

                    {/* ── Guest: avatar + name + id + VIP ── */}
                    <td className="px-5 py-3.5">
                      <div className="flex items-center gap-3">
                        <div className={`w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 text-[12px] font-bold ${avatarColor(guest.name)}`}>
                          {initials(guest.name)}
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <p className="font-semibold text-slate-800 whitespace-nowrap">
                              {guest.name}
                            </p>
                            {guest.vip && (
                              <span className="bg-amber-100 text-amber-700 text-[10px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wide leading-none">
                                VIP
                              </span>
                            )}
                          </div>
                          <p className="text-[11px] text-slate-400 mt-0.5">{guest.id}</p>
                        </div>
                      </div>
                    </td>

                    {/* ── Contact: email + phone ── */}
                    <td className="px-5 py-3.5">
                      <p className="text-slate-700">{guest.email}</p>
                      <p className="text-[12px] text-slate-400 mt-0.5">{guest.phone}</p>
                    </td>

                    {/* ── Nationality ── */}
                    <td className="px-5 py-3.5 text-slate-600 whitespace-nowrap">
                      {guest.nationality || <span className="text-slate-300">—</span>}
                    </td>

                    {/* ── Notes (truncated) ── */}
                    <td className="px-5 py-3.5 max-w-[240px]">
                      {guest.notes ? (
                        <p className="text-slate-500 text-[12.5px] truncate" title={guest.notes}>
                          {guest.notes}
                        </p>
                      ) : (
                        <span className="text-slate-300">—</span>
                      )}
                    </td>

                    {/* ── Actions ── */}
                    <td className="px-5 py-3.5">
                      {deleteConfirmId === guest.id ? (
                        // Two-step delete confirmation
                        <div className="flex items-center gap-2">
                          <span className="text-[12px] text-red-600 font-medium whitespace-nowrap">
                            Delete?
                          </span>
                          <button
                            onClick={() => confirmDelete(guest.id)}
                            className="text-[11.5px] font-semibold bg-red-600 hover:bg-red-700 text-white px-2.5 py-1.5 rounded-lg transition-colors whitespace-nowrap"
                          >
                            Yes, delete
                          </button>
                          <button
                            onClick={() => setDeleteConfirmId(null)}
                            className="text-[11.5px] font-medium text-slate-500 hover:text-slate-700 border border-slate-200 hover:border-slate-300 px-2.5 py-1.5 rounded-lg transition-colors"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        // Normal edit / delete buttons
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => openEditModal(guest)}
                            className="text-[12px] font-medium text-slate-500 hover:text-slate-800 border border-slate-200 hover:border-slate-300 px-3 py-1.5 rounded-lg transition-colors"
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => handleDeleteClick(guest.id)}
                            className="text-[12px] font-medium text-red-400 hover:text-red-600 border border-slate-200 hover:border-red-200 px-3 py-1.5 rounded-lg transition-colors"
                          >
                            Delete
                          </button>
                        </div>
                      )}
                    </td>

                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Table footer */}
        <div className="px-5 py-3 border-t border-slate-200 bg-slate-50">
          <p className="text-[12px] text-slate-400">
            {search
              ? `${filteredGuests.length} of ${guests.length} guests match "${search}"`
              : `${guests.length} guests total`}
          </p>
        </div>
      </div>

      {/* ══════════════════════════════════════════════════════
          ADD / EDIT MODAL
          Opens when modalOpen is true.
          Closes on Escape key or backdrop click.
      ══════════════════════════════════════════════════════ */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">

          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm"
            onClick={closeModal}
          />

          {/* Modal panel */}
          <div className="relative z-10 bg-white rounded-2xl shadow-2xl w-full max-w-lg">

            {/* Modal header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
              <div className="flex items-center gap-2.5">
                <div className="w-7 h-7 rounded-lg bg-slate-800 flex items-center justify-center flex-shrink-0">
                  {editingId ? (
                    // Pencil icon for edit
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-3.5 h-3.5 text-white">
                      <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
                      <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
                    </svg>
                  ) : (
                    // Plus icon for add
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-3.5 h-3.5 text-white">
                      <path d="M12 5v14M5 12h14"/>
                    </svg>
                  )}
                </div>
                <div>
                  <h2 className="text-[14px] font-semibold text-slate-800 leading-none">
                    {editingId ? "Edit Guest" : "Add New Guest"}
                  </h2>
                  <p className="text-[11.5px] text-slate-400 mt-0.5">
                    Fields marked * are required
                  </p>
                </div>
              </div>
              {/* Close button */}
              <button
                onClick={closeModal}
                className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-4 h-4">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Form */}
            <form onSubmit={handleSubmit} noValidate>
              <div className="px-6 py-5 space-y-4">

                {/* Full Name */}
                <div>
                  <label className="block text-[12px] font-semibold text-slate-600 mb-1.5 uppercase tracking-wide">
                    Full Name <span className="text-rose-500">*</span>
                  </label>
                  <input
                    type="text"
                    placeholder="e.g. James Whitfield"
                    value={form.name}
                    onChange={e => setField("name", e.target.value)}
                    autoFocus
                    className={`w-full px-3.5 py-2.5 text-[13.5px] text-slate-800 bg-white border rounded-lg
                      placeholder:text-slate-300 focus:outline-none focus:ring-2 focus:ring-amber-400 focus:border-transparent transition
                      ${errors.name ? "border-rose-300 bg-rose-50" : "border-slate-200"}`}
                  />
                  {errors.name && (
                    <p className="mt-1 text-[11.5px] text-rose-600">{errors.name}</p>
                  )}
                </div>

                {/* Phone + Email side by side */}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-[12px] font-semibold text-slate-600 mb-1.5 uppercase tracking-wide">
                      Phone <span className="text-rose-500">*</span>
                    </label>
                    <input
                      type="tel"
                      placeholder="e.g. +1 617 555 0101"
                      value={form.phone}
                      onChange={e => setField("phone", e.target.value)}
                      className={`w-full px-3.5 py-2.5 text-[13.5px] text-slate-800 bg-white border rounded-lg
                        placeholder:text-slate-300 focus:outline-none focus:ring-2 focus:ring-amber-400 focus:border-transparent transition
                        ${errors.phone ? "border-rose-300 bg-rose-50" : "border-slate-200"}`}
                    />
                    {errors.phone && (
                      <p className="mt-1 text-[11.5px] text-rose-600">{errors.phone}</p>
                    )}
                  </div>

                  <div>
                    <label className="block text-[12px] font-semibold text-slate-600 mb-1.5 uppercase tracking-wide">
                      Email <span className="text-rose-500">*</span>
                    </label>
                    <input
                      type="email"
                      placeholder="e.g. name@email.com"
                      value={form.email}
                      onChange={e => setField("email", e.target.value)}
                      className={`w-full px-3.5 py-2.5 text-[13.5px] text-slate-800 bg-white border rounded-lg
                        placeholder:text-slate-300 focus:outline-none focus:ring-2 focus:ring-amber-400 focus:border-transparent transition
                        ${errors.email ? "border-rose-300 bg-rose-50" : "border-slate-200"}`}
                    />
                    {errors.email && (
                      <p className="mt-1 text-[11.5px] text-rose-600">{errors.email}</p>
                    )}
                  </div>
                </div>

                {/* Nationality */}
                <div>
                  <label className="block text-[12px] font-semibold text-slate-600 mb-1.5 uppercase tracking-wide">
                    Nationality
                  </label>
                  <input
                    type="text"
                    placeholder="e.g. French"
                    value={form.nationality}
                    onChange={e => setField("nationality", e.target.value)}
                    className="w-full px-3.5 py-2.5 text-[13.5px] text-slate-800 bg-white border border-slate-200 rounded-lg
                      placeholder:text-slate-300 focus:outline-none focus:ring-2 focus:ring-amber-400 focus:border-transparent transition"
                  />
                </div>

                {/* Notes */}
                <div>
                  <label className="block text-[12px] font-semibold text-slate-600 mb-1.5 uppercase tracking-wide">
                    Notes
                  </label>
                  <textarea
                    rows={3}
                    placeholder="Preferences, allergies, special requests…"
                    value={form.notes}
                    onChange={e => setField("notes", e.target.value)}
                    className="w-full px-3.5 py-2.5 text-[13.5px] text-slate-800 bg-white border border-slate-200 rounded-lg
                      placeholder:text-slate-300 focus:outline-none focus:ring-2 focus:ring-amber-400 focus:border-transparent transition resize-none"
                  />
                </div>

                {/* VIP toggle */}
                <label className="flex items-center gap-3 cursor-pointer select-none group">
                  <div className="relative">
                    <input
                      type="checkbox"
                      className="sr-only"
                      checked={form.vip}
                      onChange={e => setField("vip", e.target.checked)}
                    />
                    <div className={`w-10 h-5 rounded-full transition-colors ${form.vip ? "bg-amber-500" : "bg-slate-200"}`} />
                    <div className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${form.vip ? "translate-x-5" : "translate-x-0"}`} />
                  </div>
                  <span className="text-[13px] font-medium text-slate-700">
                    Mark as VIP guest
                  </span>
                  {form.vip && (
                    <span className="bg-amber-100 text-amber-700 text-[10px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wide leading-none">
                      VIP
                    </span>
                  )}
                </label>

              </div>

              {/* Form actions */}
              <div className="flex items-center justify-end gap-3 px-6 pb-5">
                <button
                  type="button"
                  onClick={closeModal}
                  className="px-4 py-2.5 text-[13px] font-medium text-slate-600 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="flex items-center gap-2 px-5 py-2.5 text-[13px] font-semibold text-white bg-slate-900 hover:bg-slate-800 rounded-lg transition-colors shadow-sm"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-4 h-4">
                    <path d="M22 11.08V12a10 10 0 11-5.93-9.14" /><path d="M22 4L12 14.01l-3-3" />
                  </svg>
                  {editingId ? "Save Changes" : "Add Guest"}
                </button>
              </div>
            </form>

          </div>
        </div>
      )}

    </div>
  );
}

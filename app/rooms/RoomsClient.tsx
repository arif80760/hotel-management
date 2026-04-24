"use client";

// app/rooms/RoomsClient.tsx
//
// Full room inventory management — add, edit, delete rooms.
// Reads and writes rooms via HotelContext so every change
// propagates instantly to the Dashboard Room Board, stat cards,
// and the Bookings form room-lookup.
//
// KEY RULES enforced here:
//   • Room STATUS is never set in this file. It is exclusively
//     controlled by booking workflow (createBooking /
//     changeBookingStatus) inside HotelContext. Editing a room
//     preserves its current status unconditionally.
//   • Delete is blocked when status is Occupied, Reserved, or
//     Cleaning — those rooms have active or recent bookings.

import { useState, useMemo, useEffect, useCallback } from "react";
import { useHotel } from "@/contexts/HotelContext";
import { useAuth }  from "@/contexts/AuthContext";
import type { MockRoom, RoomStatus } from "@/lib/mockData";

// ─────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────
const CATEGORIES  = ["Single", "Double", "Deluxe", "Suite", "Family"] as const;
const FLOOR_OPTIONS = ["Floor 1", "Floor 2", "Floor 3", "Floor 4"] as const;
const ALL_STATUSES: RoomStatus[] = [
  "Available", "Occupied", "Reserved", "Cleaning", "Maintenance",
];

// Statuses that booking logic owns — delete blocked in these states
const BOOKING_LOCKED: RoomStatus[] = ["Occupied", "Reserved", "Cleaning"];

// ─────────────────────────────────────────────────────────────
// FORM TYPE  (all strings so <input> bindings are simple)
// ─────────────────────────────────────────────────────────────
type RoomFormData = {
  roomNumber: string;
  floor:      string;
  capacity:   string;   // parsed → number on save
  category:   string;
  price:      string;   // parsed → number on save
  amenities:  string;   // comma-separated; split on save
};

type FormErrors = Partial<Record<keyof RoomFormData, string>>;

const EMPTY_FORM: RoomFormData = {
  roomNumber: "",
  floor:      "Floor 1",
  capacity:   "2",
  category:   "Double",
  price:      "150",
  amenities:  "WiFi, TV",
};

// ─────────────────────────────────────────────────────────────
// STYLE HELPERS
// ─────────────────────────────────────────────────────────────
function statusStyle(s: RoomStatus): string {
  const m: Record<RoomStatus, string> = {
    Available:   "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200",
    Occupied:    "bg-rose-50    text-rose-700    ring-1 ring-rose-200",
    Reserved:    "bg-blue-50    text-blue-700    ring-1 ring-blue-200",
    Cleaning:    "bg-amber-50   text-amber-700   ring-1 ring-amber-200",
    Maintenance: "bg-slate-100  text-slate-600   ring-1 ring-slate-200",
  };
  return m[s];
}

function statusDot(s: RoomStatus): string {
  const m: Record<RoomStatus, string> = {
    Available:   "bg-emerald-500",
    Occupied:    "bg-rose-500",
    Reserved:    "bg-blue-500",
    Cleaning:    "bg-amber-500",
    Maintenance: "bg-slate-400",
  };
  return m[s];
}

function categoryBadge(c: string): string {
  const m: Record<string, string> = {
    Single: "bg-slate-100  text-slate-600",
    Double: "bg-blue-50    text-blue-700",
    Deluxe: "bg-violet-50  text-violet-700",
    Suite:  "bg-amber-50   text-amber-700",
    Family: "bg-teal-50    text-teal-700",
  };
  return m[c] ?? "bg-slate-100 text-slate-500";
}

// ─────────────────────────────────────────────────────────────
// COMPONENT
// ─────────────────────────────────────────────────────────────
export default function RoomsClient() {
  const {
    rooms,
    addRoom,
    updateRoom,
    deleteRoom,
  } = useHotel();

  const { role } = useAuth();
  const isAdmin = role === "admin";   // only admins may add / edit / delete rooms

  // ── Filter state ────────────────────────────────────────────
  const [floorFilter,  setFloorFilter]  = useState<string>("All");
  const [statusFilter, setStatusFilter] = useState<string>("All");

  // ── Modal state ─────────────────────────────────────────────
  const [modalOpen,   setModalOpen]   = useState(false);
  const [editingId,   setEditingId]   = useState<string | null>(null);
  const [form,        setForm]        = useState<RoomFormData>(EMPTY_FORM);
  const [errors,      setErrors]      = useState<FormErrors>({});

  // ── Delete confirmation (inline 2-step) ────────────────────
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  // ── Success / info banner ───────────────────────────────────
  const [successMsg, setSuccessMsg] = useState("");

  // Auto-clear success banner
  useEffect(() => {
    if (!successMsg) return;
    const t = setTimeout(() => setSuccessMsg(""), 4000);
    return () => clearTimeout(t);
  }, [successMsg]);

  // Close modal on Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") closeModal();
    }
    if (modalOpen) document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [modalOpen]);

  // ── Derived: filtered room list ─────────────────────────────
  const filteredRooms = useMemo(() => {
    return rooms.filter(r => {
      const floorOk  = floorFilter  === "All" || r.floor  === floorFilter;
      const statusOk = statusFilter === "All" || r.status === statusFilter;
      return floorOk && statusOk;
    });
  }, [rooms, floorFilter, statusFilter]);

  // ── Derived: status counts (for filter pills) ───────────────
  const statusCounts = useMemo(() => {
    const base: Record<string, number> = { All: rooms.length };
    ALL_STATUSES.forEach(s => {
      base[s] = rooms.filter(r => r.status === s).length;
    });
    return base;
  }, [rooms]);

  // ── Derived: floor counts ───────────────────────────────────
  const floorCounts = useMemo(() => {
    const base: Record<string, number> = { All: rooms.length };
    FLOOR_OPTIONS.forEach(f => {
      base[f] = rooms.filter(r => r.floor === f).length;
    });
    return base;
  }, [rooms]);

  // ── Modal helpers ───────────────────────────────────────────
  function openAdd() {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setErrors({});
    setModalOpen(true);
  }

  function openEdit(room: MockRoom) {
    setEditingId(room.id);
    setForm({
      roomNumber: room.roomNumber,
      floor:      room.floor,
      capacity:   String(room.capacity),
      category:   room.category,
      price:      String(room.price),
      amenities:  room.amenities.join(", "),
    });
    setErrors({});
    setModalOpen(true);
  }

  function closeModal() {
    setModalOpen(false);
    setEditingId(null);
    setForm(EMPTY_FORM);
    setErrors({});
  }

  function setField<K extends keyof RoomFormData>(key: K, value: string) {
    setForm(prev => ({ ...prev, [key]: value }));
    if (errors[key]) setErrors(prev => ({ ...prev, [key]: undefined }));
  }

  // ── Validation ──────────────────────────────────────────────
  function validate(): boolean {
    const e: FormErrors = {};

    if (!form.roomNumber.trim()) {
      e.roomNumber = "Room number is required.";
    } else {
      // Check for duplicate room number (exclude the room being edited)
      const duplicate = rooms.find(
        r => r.roomNumber === form.roomNumber.trim() && r.id !== editingId
      );
      if (duplicate) e.roomNumber = `Room ${form.roomNumber.trim()} already exists.`;
    }

    if (!form.floor) {
      e.floor = "Floor is required.";
    }

    const cap = parseInt(form.capacity);
    if (!form.capacity || isNaN(cap) || cap < 1 || cap > 20) {
      e.capacity = "Capacity must be between 1 and 20.";
    }

    const price = parseFloat(form.price);
    if (!form.price || isNaN(price) || price < 1) {
      e.price = "Price must be a positive number.";
    }

    setErrors(e);
    return Object.keys(e).length === 0;
  }

  // ── Submit ──────────────────────────────────────────────────
  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validate()) return;

    const amenitiesArr = form.amenities
      .split(",")
      .map(a => a.trim())
      .filter(a => a.length > 0);

    if (editingId) {
      // Edit — never touch status; booking logic owns it
      updateRoom(editingId, {
        roomNumber: form.roomNumber.trim(),
        floor:      form.floor,
        capacity:   parseInt(form.capacity),
        category:   form.category,
        price:      parseFloat(form.price),
        amenities:  amenitiesArr,
      });
      setSuccessMsg(`Room ${form.roomNumber.trim()} updated successfully.`);
    } else {
      // Add — new rooms start as Available (no booking yet).
      // id is a client-side placeholder; the real UUID comes from Supabase.
      const newRoom: import("@/lib/mockData").MockRoom = {
        id:         `pending-${Date.now()}`,
        roomNumber: form.roomNumber.trim(),
        floor:      form.floor,
        category:   form.category,
        status:     "Available",
        price:      parseFloat(form.price),
        capacity:   parseInt(form.capacity),
        amenities:  amenitiesArr,
      };
      addRoom(newRoom);
      setSuccessMsg(`Room ${newRoom.roomNumber} added to inventory.`);
    }

    closeModal();
  }

  // ── Delete ──────────────────────────────────────────────────
  function handleDeleteClick(room: MockRoom) {
    if (BOOKING_LOCKED.includes(room.status)) return; // safety guard
    if (deleteConfirmId === room.id) {
      // Second click — confirmed
      deleteRoom(room.id);
      setSuccessMsg(`Room ${room.roomNumber} removed from inventory.`);
      setDeleteConfirmId(null);
    } else {
      // First click — ask for confirmation
      setDeleteConfirmId(room.id);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────
  return (
    <div className="p-7 max-w-[1400px] space-y-5">

      {/* ══════════════════════════════════════════════════════
          PAGE HEADER
      ══════════════════════════════════════════════════════ */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-[22px] font-semibold text-slate-900 tracking-tight leading-none">
            Rooms
          </h1>
          <p className="text-[13px] text-slate-500 mt-1">
            {rooms.length} room{rooms.length !== 1 ? "s" : ""} across{" "}
            {FLOOR_OPTIONS.length} floors
          </p>
        </div>
        {isAdmin && (
          <button
            onClick={openAdd}
            className="flex items-center gap-2 bg-slate-900 hover:bg-slate-800 text-white text-[13px] font-medium px-4 py-2.5 rounded-lg transition-colors shadow-sm"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-4 h-4">
              <path d="M12 5v14M5 12h14"/>
            </svg>
            Add Room
          </button>
        )}
      </div>

      {/* ══════════════════════════════════════════════════════
          SUCCESS BANNER
      ══════════════════════════════════════════════════════ */}
      {successMsg && (
        <div className="flex items-center gap-3 bg-emerald-50 border border-emerald-200 rounded-xl px-5 py-3.5">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-5 h-5 text-emerald-600 flex-shrink-0">
            <path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><path d="M22 4L12 14.01l-3-3"/>
          </svg>
          <p className="text-[13px] font-medium text-emerald-800">{successMsg}</p>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════
          STATUS SUMMARY PILLS  (live counts from context)
      ══════════════════════════════════════════════════════ */}
      <div className="flex flex-wrap gap-2.5">
        {[
          { label: "All Rooms",   key: "All",         style: "bg-white border-slate-200 text-slate-700",          dot: "bg-slate-400"   },
          { label: "Available",   key: "Available",   style: "bg-emerald-50 border-emerald-200 text-emerald-700", dot: "bg-emerald-500" },
          { label: "Occupied",    key: "Occupied",    style: "bg-rose-50 border-rose-200 text-rose-700",          dot: "bg-rose-500"    },
          { label: "Reserved",    key: "Reserved",    style: "bg-blue-50 border-blue-200 text-blue-700",          dot: "bg-blue-500"    },
          { label: "Cleaning",    key: "Cleaning",    style: "bg-amber-50 border-amber-200 text-amber-700",       dot: "bg-amber-500"   },
          { label: "Maintenance", key: "Maintenance", style: "bg-slate-100 border-slate-200 text-slate-600",      dot: "bg-slate-400"   },
        ].map(pill => (
          <div
            key={pill.key}
            className={`flex items-center gap-2 px-3.5 py-1.5 rounded-full border text-[12.5px] font-medium ${pill.style}`}
          >
            <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${pill.dot}`} />
            {pill.label}
            <span className="font-bold">{statusCounts[pill.key] ?? 0}</span>
          </div>
        ))}
      </div>

      {/* ══════════════════════════════════════════════════════
          FILTER BAR
      ══════════════════════════════════════════════════════ */}
      <div className="flex flex-wrap items-center gap-4">

        {/* Floor filter */}
        <div className="flex items-center gap-1.5">
          <span className="text-[12px] font-semibold text-slate-400 uppercase tracking-wider mr-1">
            Floor
          </span>
          {(["All", ...FLOOR_OPTIONS] as string[]).map(f => (
            <button
              key={f}
              onClick={() => setFloorFilter(f)}
              className={`px-3 py-1.5 rounded-lg text-[12.5px] font-medium transition-colors ${
                floorFilter === f
                  ? "bg-slate-900 text-white shadow-sm"
                  : "bg-white border border-slate-200 text-slate-500 hover:text-slate-700 hover:border-slate-300"
              }`}
            >
              {f === "All" ? "All" : f.replace("Floor ", "")}
              {f !== "All" && (
                <span className={`ml-1.5 text-[11px] font-bold ${
                  floorFilter === f ? "text-white/70" : "text-slate-400"
                }`}>
                  {floorCounts[f] ?? 0}
                </span>
              )}
            </button>
          ))}
        </div>

        <div className="w-px h-5 bg-slate-200" />

        {/* Status filter */}
        <div className="flex items-center gap-1.5">
          <span className="text-[12px] font-semibold text-slate-400 uppercase tracking-wider mr-1">
            Status
          </span>
          {(["All", ...ALL_STATUSES] as string[]).map(s => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`px-3 py-1.5 rounded-lg text-[12.5px] font-medium transition-colors ${
                statusFilter === s
                  ? "bg-slate-900 text-white shadow-sm"
                  : "bg-white border border-slate-200 text-slate-500 hover:text-slate-700 hover:border-slate-300"
              }`}
            >
              {s}
              <span className={`ml-1.5 text-[11px] font-bold ${
                statusFilter === s ? "text-white/70" : "text-slate-400"
              }`}>
                {statusCounts[s] ?? 0}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* ══════════════════════════════════════════════════════
          ROOMS TABLE
      ══════════════════════════════════════════════════════ */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200">
                {["Room", "Category", "Floor", "Capacity", "Amenities", "Status", "Rate / Night", "Actions"].map(h => (
                  <th key={h} className="text-left px-5 py-3 text-[11px] font-semibold text-slate-400 uppercase tracking-wider whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredRooms.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-5 py-12 text-center text-[13px] text-slate-400">
                    No rooms match the selected filters.
                  </td>
                </tr>
              ) : filteredRooms.map(room => {
                const isLocked  = BOOKING_LOCKED.includes(room.status);
                const isConfirm = deleteConfirmId === room.id;

                return (
                  <tr
                    key={room.id}
                    className="hover:bg-slate-50/70 transition-colors"
                    onClick={() => {
                      // Clicking elsewhere clears a pending delete confirmation
                      if (deleteConfirmId && deleteConfirmId !== room.id) {
                        setDeleteConfirmId(null);
                      }
                    }}
                  >
                    {/* Room number */}
                    <td className="px-5 py-3.5">
                      <span className="font-bold text-slate-800 text-[15px]">
                        {room.roomNumber}
                      </span>
                    </td>

                    {/* Category */}
                    <td className="px-5 py-3.5">
                      <span className={`px-2.5 py-1 rounded-md text-[12px] font-semibold ${categoryBadge(room.category)}`}>
                        {room.category}
                      </span>
                    </td>

                    {/* Floor */}
                    <td className="px-5 py-3.5 text-slate-500 whitespace-nowrap">
                      {room.floor}
                    </td>

                    {/* Capacity */}
                    <td className="px-5 py-3.5 text-slate-500 whitespace-nowrap">
                      {room.capacity} {room.capacity === 1 ? "guest" : "guests"}
                    </td>

                    {/* Amenities */}
                    <td className="px-5 py-3.5">
                      <div className="flex flex-wrap gap-1">
                        {room.amenities.slice(0, 3).map(a => (
                          <span key={a} className="bg-slate-100 text-slate-500 text-[11px] font-medium px-2 py-0.5 rounded">
                            {a}
                          </span>
                        ))}
                        {room.amenities.length > 3 && (
                          <span className="bg-slate-100 text-slate-400 text-[11px] px-2 py-0.5 rounded">
                            +{room.amenities.length - 3}
                          </span>
                        )}
                      </div>
                    </td>

                    {/* Status — booking-controlled, read-only here */}
                    <td className="px-5 py-3.5">
                      <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[12px] font-semibold ${statusStyle(room.status)}`}>
                        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${statusDot(room.status)}`} />
                        {room.status}
                      </span>
                    </td>

                    {/* Price */}
                    <td className="px-5 py-3.5 font-semibold text-slate-800 whitespace-nowrap">
                      ${room.price}
                    </td>

                    {/* Actions — admin only; staff sees an empty cell */}
                    <td className="px-5 py-3.5">
                      {isAdmin && (
                        <div className="flex items-center gap-2">

                          {/* Edit */}
                          <button
                            onClick={() => openEdit(room)}
                            className="text-[12px] font-medium text-slate-500 hover:text-slate-800 border border-slate-200 hover:border-slate-300 bg-white hover:bg-slate-50 px-3 py-1.5 rounded-lg transition-colors"
                          >
                            Edit
                          </button>

                          {/* Delete — disabled while booking-locked */}
                          {isLocked ? (
                            <span
                              title={`Room is ${room.status} — cannot delete while a booking is active`}
                              className="text-[12px] font-medium text-slate-300 border border-slate-100 px-3 py-1.5 rounded-lg cursor-not-allowed select-none"
                            >
                              Delete
                            </span>
                          ) : isConfirm ? (
                            <div className="flex items-center gap-1.5">
                              <span className="text-[11.5px] text-rose-600 font-semibold whitespace-nowrap">
                                Confirm?
                              </span>
                              <button
                                onClick={() => handleDeleteClick(room)}
                                className="text-[12px] font-semibold text-white bg-rose-500 hover:bg-rose-600 px-3 py-1.5 rounded-lg transition-colors"
                              >
                                Yes
                              </button>
                              <button
                                onClick={() => setDeleteConfirmId(null)}
                                className="text-[12px] font-medium text-slate-500 border border-slate-200 hover:bg-slate-50 px-3 py-1.5 rounded-lg transition-colors"
                              >
                                No
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() => handleDeleteClick(room)}
                              className="text-[12px] font-medium text-slate-400 hover:text-rose-600 border border-slate-200 hover:border-rose-200 hover:bg-rose-50 px-3 py-1.5 rounded-lg transition-colors"
                            >
                              Delete
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Table footer */}
        <div className="px-5 py-3 border-t border-slate-100 bg-slate-50 flex items-center justify-between">
          <p className="text-[12px] text-slate-400">
            Showing {filteredRooms.length} of {rooms.length} rooms
            {(floorFilter !== "All" || statusFilter !== "All") && (
              <button
                onClick={() => { setFloorFilter("All"); setStatusFilter("All"); }}
                className="ml-2 text-amber-600 hover:underline font-medium"
              >
                Clear filters
              </button>
            )}
          </p>
          <p className="text-[12px] text-slate-400 italic">
            Room status is managed automatically by booking workflow
          </p>
        </div>
      </div>

      {/* ══════════════════════════════════════════════════════
          ADD / EDIT MODAL
      ══════════════════════════════════════════════════════ */}
      {modalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm"
          onClick={e => { if (e.target === e.currentTarget) closeModal(); }}
        >
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden">

            {/* Modal header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 bg-slate-50">
              <div className="flex items-center gap-2.5">
                <div className="w-7 h-7 rounded-lg bg-slate-800 flex items-center justify-center">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-3.5 h-3.5 text-white">
                    {editingId
                      ? <><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></>
                      : <path d="M12 5v14M5 12h14"/>
                    }
                  </svg>
                </div>
                <div>
                  <h2 className="text-[14px] font-semibold text-slate-800 leading-none">
                    {editingId ? `Edit Room ${form.roomNumber || "…"}` : "Add New Room"}
                  </h2>
                  <p className="text-[11.5px] text-slate-400 mt-0.5">
                    Fields marked * are required
                  </p>
                </div>
              </div>
              <button
                onClick={closeModal}
                className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-200 rounded-lg transition-colors"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-4 h-4">
                  <path d="M18 6L6 18M6 6l12 12"/>
                </svg>
              </button>
            </div>

            {/* Modal form */}
            <form onSubmit={handleSubmit} noValidate>
              <div className="p-6 space-y-4">

                {/* Row 1: Room Number + Floor */}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-[12px] font-semibold text-slate-600 mb-1.5 uppercase tracking-wide">
                      Room Number <span className="text-rose-500">*</span>
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. 501"
                      value={form.roomNumber}
                      onChange={e => setField("roomNumber", e.target.value)}
                      className={`w-full px-3.5 py-2.5 text-[13.5px] text-slate-800 bg-white border rounded-lg
                        placeholder:text-slate-300 focus:outline-none focus:ring-2 focus:ring-amber-400 focus:border-transparent transition
                        ${errors.roomNumber ? "border-rose-300 bg-rose-50" : "border-slate-200"}`}
                    />
                    {errors.roomNumber && (
                      <p className="mt-1 text-[11.5px] text-rose-600">{errors.roomNumber}</p>
                    )}
                  </div>

                  <div>
                    <label className="block text-[12px] font-semibold text-slate-600 mb-1.5 uppercase tracking-wide">
                      Floor <span className="text-rose-500">*</span>
                    </label>
                    <select
                      value={form.floor}
                      onChange={e => setField("floor", e.target.value)}
                      className="w-full px-3.5 py-2.5 text-[13.5px] text-slate-800 bg-white border border-slate-200 rounded-lg
                        focus:outline-none focus:ring-2 focus:ring-amber-400 focus:border-transparent transition appearance-none cursor-pointer"
                    >
                      {FLOOR_OPTIONS.map(f => (
                        <option key={f} value={f}>{f}</option>
                      ))}
                    </select>
                  </div>
                </div>

                {/* Row 2: Category + Capacity */}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-[12px] font-semibold text-slate-600 mb-1.5 uppercase tracking-wide">
                      Category
                    </label>
                    <select
                      value={form.category}
                      onChange={e => setField("category", e.target.value)}
                      className="w-full px-3.5 py-2.5 text-[13.5px] text-slate-800 bg-white border border-slate-200 rounded-lg
                        focus:outline-none focus:ring-2 focus:ring-amber-400 focus:border-transparent transition appearance-none cursor-pointer"
                    >
                      {CATEGORIES.map(c => (
                        <option key={c} value={c}>{c}</option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-[12px] font-semibold text-slate-600 mb-1.5 uppercase tracking-wide">
                      Capacity <span className="text-rose-500">*</span>
                    </label>
                    <input
                      type="number"
                      min={1}
                      max={20}
                      placeholder="2"
                      value={form.capacity}
                      onChange={e => setField("capacity", e.target.value)}
                      className={`w-full px-3.5 py-2.5 text-[13.5px] text-slate-800 bg-white border rounded-lg
                        placeholder:text-slate-300 focus:outline-none focus:ring-2 focus:ring-amber-400 focus:border-transparent transition
                        ${errors.capacity ? "border-rose-300 bg-rose-50" : "border-slate-200"}`}
                    />
                    {errors.capacity && (
                      <p className="mt-1 text-[11.5px] text-rose-600">{errors.capacity}</p>
                    )}
                  </div>
                </div>

                {/* Row 3: Price */}
                <div>
                  <label className="block text-[12px] font-semibold text-slate-600 mb-1.5 uppercase tracking-wide">
                    Price per Night (USD) <span className="text-rose-500">*</span>
                  </label>
                  <div className="relative">
                    <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 font-semibold text-[14px] pointer-events-none">
                      $
                    </span>
                    <input
                      type="number"
                      min={1}
                      step="0.01"
                      placeholder="150"
                      value={form.price}
                      onChange={e => setField("price", e.target.value)}
                      className={`w-full pl-7 pr-3.5 py-2.5 text-[13.5px] text-slate-800 bg-white border rounded-lg
                        placeholder:text-slate-300 focus:outline-none focus:ring-2 focus:ring-amber-400 focus:border-transparent transition
                        ${errors.price ? "border-rose-300 bg-rose-50" : "border-slate-200"}`}
                    />
                  </div>
                  {errors.price && (
                    <p className="mt-1 text-[11.5px] text-rose-600">{errors.price}</p>
                  )}
                </div>

                {/* Row 4: Amenities */}
                <div>
                  <label className="block text-[12px] font-semibold text-slate-600 mb-1.5 uppercase tracking-wide">
                    Amenities
                    <span className="ml-1 font-normal normal-case text-slate-400">(comma-separated)</span>
                  </label>
                  <input
                    type="text"
                    placeholder="WiFi, TV, Mini Bar, Ocean View"
                    value={form.amenities}
                    onChange={e => setField("amenities", e.target.value)}
                    className="w-full px-3.5 py-2.5 text-[13.5px] text-slate-800 bg-white border border-slate-200 rounded-lg
                      placeholder:text-slate-300 focus:outline-none focus:ring-2 focus:ring-amber-400 focus:border-transparent transition"
                  />
                  <p className="mt-1 text-[11.5px] text-slate-400">
                    e.g. WiFi, TV, AC, Mini Bar, Jacuzzi, Ocean View
                  </p>
                </div>

                {/* Status note (edit only) */}
                {editingId && (
                  <div className="flex items-start gap-2.5 bg-slate-50 border border-slate-200 rounded-lg px-4 py-3">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" className="w-4 h-4 text-slate-400 flex-shrink-0 mt-0.5">
                      <circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>
                    </svg>
                    <p className="text-[12px] text-slate-500 leading-relaxed">
                      <span className="font-semibold text-slate-700">Room status is not editable here.</span>{" "}
                      It is automatically managed by the booking workflow — Confirmed → Reserved,
                      Checked In → Occupied, Checked Out → Cleaning, Cancelled → Available.
                    </p>
                  </div>
                )}
              </div>

              {/* Modal actions */}
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
                    <path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><path d="M22 4L12 14.01l-3-3"/>
                  </svg>
                  {editingId ? "Save Changes" : "Add Room"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

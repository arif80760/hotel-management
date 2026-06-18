"use client";

// app/employees/EmployeesClient.tsx
//
// Employee directory management.
//
// ARCHITECTURE:
//   • Employees are hotel staff records — separate from Supabase auth accounts.
//   • can_access_app = false  →  directory record only; only the employee record
//                                is created (addEmployee service call).
//   • can_access_app = true   →  full provisioning via POST /api/employees/provision:
//                                  1. Supabase Auth user is created server-side
//                                  2. Employee record is inserted with auth_user_id
//                                  3. Profile row is upserted (sets role for AuthContext)
//                                The employee can log in immediately after being added.
//   • Designation auto-sets the default can_access_app / app_role, but
//     the admin can always override.
//   • Admin-only: Add, Edit, Delete. Staff can view the directory.
//   • tempPassword is form-only state — it is sent to the provisioning API
//     and used only server-side to create the auth user. It is never stored
//     in the employees table.

import { useState, useEffect, useMemo, useRef } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/lib/supabase";
import * as employeesService from "@/services/employeesService";
import type { Employee, Designation, EmployeeAppRole } from "@/services/employeesService";
import {
  DESIGNATIONS,
  DESIGNATION_DEFAULTS,
  BLOOD_GROUPS,
} from "@/services/employeesService";

// ─────────────────────────────────────────────────────────────
// FORM TYPE
// photo_url is intentionally excluded — staff upload their own
// photo from the self-profile section (not implemented yet).
// tempPassword is form-only — not persisted to the employees table.
// ─────────────────────────────────────────────────────────────
type EmployeeFormData = {
  fullName:         string;
  employeeId:       string;
  designation:      string;
  phone:            string;
  email:            string;
  bloodGroup:       string;
  joiningDate:      string;   // "YYYY-MM-DD" for <input type="date">
  emergencyContact: string;
  address:          string;
  canAccessApp:     boolean;
  appRole:          string;   // "admin" | "staff" | ""
  tempPassword:     string;   // form-only — not saved to DB
  notes:            string;
  isActive:         boolean;
};

type FormErrors = Partial<Record<keyof EmployeeFormData, string>>;

const EMPTY_FORM: EmployeeFormData = {
  fullName:         "",
  employeeId:       "",
  designation:      "Receptionist",
  phone:            "",
  email:            "",
  bloodGroup:       "",
  joiningDate:      new Date().toISOString().slice(0, 10),
  emergencyContact: "",
  address:          "",
  canAccessApp:     DESIGNATION_DEFAULTS["Receptionist"].canAccessApp,
  appRole:          DESIGNATION_DEFAULTS["Receptionist"].appRole ?? "",
  tempPassword:     "",
  notes:            "",
  isActive:         true,
};

// ─────────────────────────────────────────────────────────────
// STYLE HELPERS
// ─────────────────────────────────────────────────────────────
function designationBadge(d: string): string {
  const m: Record<string, string> = {
    "Chairman":          "bg-orange-50  text-orange-700  ring-1 ring-orange-200",
    "Managing Director": "bg-rose-50    text-rose-700    ring-1 ring-rose-200",
    "Director":          "bg-fuchsia-50 text-fuchsia-700 ring-1 ring-fuchsia-200",
    "General Manager": "bg-amber-50  text-amber-700  ring-1 ring-amber-200",
    "Manager":         "bg-violet-50 text-violet-700 ring-1 ring-violet-200",
    "Receptionist":    "bg-blue-50   text-blue-700   ring-1 ring-blue-200",
    "Cleaner":         "bg-slate-100 text-slate-600  ring-1 ring-slate-200",
    "Room Attendant":  "bg-teal-50   text-teal-700   ring-1 ring-teal-200",
    "Laundry Boy":     "bg-cyan-50   text-cyan-700   ring-1 ring-cyan-200",
    "Security Guard":  "bg-indigo-50 text-indigo-700 ring-1 ring-indigo-200",
  };
  return m[d] ?? "bg-slate-100 text-slate-500";
}

function roleBadge(role: EmployeeAppRole | null): string {
  if (role === "admin") return "bg-amber-100 text-amber-800";
  if (role === "staff") return "bg-blue-50   text-blue-700";
  return "bg-slate-100 text-slate-500";
}

// ─────────────────────────────────────────────────────────────
// INITIALS AVATAR
// ─────────────────────────────────────────────────────────────
function initials(name: string): string {
  return name.split(" ").slice(0, 2).map(n => n[0]?.toUpperCase() ?? "").join("");
}

const AVATAR_COLORS = [
  "bg-rose-100 text-rose-700",
  "bg-violet-100 text-violet-700",
  "bg-blue-100 text-blue-700",
  "bg-teal-100 text-teal-700",
  "bg-amber-100 text-amber-700",
  "bg-emerald-100 text-emerald-700",
];

function avatarColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % AVATAR_COLORS.length;
  return AVATAR_COLORS[h];
}

// ─────────────────────────────────────────────────────────────
// SMALL REUSABLE PIECES
// ─────────────────────────────────────────────────────────────

/** Consistent section heading used inside the modal form */
function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 mb-4">
      <p className="text-[11px] font-bold text-slate-400 uppercase tracking-widest whitespace-nowrap">
        {children}
      </p>
      <div className="flex-1 h-px bg-slate-100" />
    </div>
  );
}

/** Consistent field label */
function FieldLabel({
  children,
  required,
  hint,
}: {
  children: React.ReactNode;
  required?: boolean;
  hint?: string;
}) {
  return (
    <label className="block text-[12px] font-semibold text-slate-600 mb-1.5 uppercase tracking-wide">
      {children}
      {required && <span className="text-rose-500 ml-0.5">*</span>}
      {hint && <span className="ml-1.5 font-normal normal-case text-slate-400">{hint}</span>}
    </label>
  );
}

/** Shared text-input className builder */
function inputCls(hasError = false): string {
  return [
    "w-full px-3.5 py-2.5 text-[13.5px] text-slate-800 bg-white border rounded-lg",
    "placeholder:text-slate-300 focus:outline-none focus:ring-2 focus:ring-amber-400 focus:border-transparent transition",
    hasError ? "border-rose-300 bg-rose-50" : "border-slate-200",
  ].join(" ");
}

/** Reusable toggle switch */
function Toggle({
  checked,
  onChange,
  activeColor = "bg-emerald-500",
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  activeColor?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex w-11 h-6 rounded-full transition-colors flex-shrink-0 ${checked ? activeColor : "bg-slate-300"}`}
    >
      <span
        className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${checked ? "translate-x-5" : "translate-x-0"}`}
      />
    </button>
  );
}

// ─────────────────────────────────────────────────────────────
// DATE PICKER  — three-mode drill-down
//
// Three views, each reachable by clicking the header:
//
//   DAY view   → the normal month calendar grid
//               header: "April 2026 ▾"  (click → MONTH view)
//               arrows: prev / next month
//
//   MONTH view → 3×4 grid of all 12 months
//               header: "2026 ▾"  (click → YEAR view)
//               arrows: prev / next year
//               click a month → back to DAY view
//
//   YEAR view  → 4×3 grid of 12 years
//               header: "2016 – 2027"  (non-clickable range label)
//               arrows: scroll range by 12 years
//               click a year → back to MONTH view
//
// Stored value stays "YYYY-MM-DD" — the external API is unchanged.
// ─────────────────────────────────────────────────────────────

const CAL_MONTHS_LONG  = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const CAL_MONTHS_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const CAL_DAYS         = ["Su","Mo","Tu","We","Th","Fr","Sa"];

type CalMode = "day" | "month" | "year";

/** Returns the start of a 12-year block that contains `year` */
function yearBlockStart(year: number): number {
  return Math.floor(year / 12) * 12;
}

function DatePickerField({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const [open,       setOpen]       = useState(false);
  const [openUpward, setOpenUpward] = useState(false);
  const [mode,       setMode]       = useState<CalMode>("day");
  const containerRef = useRef<HTMLDivElement>(null);

  const today  = new Date();
  const parsed = value ? new Date(`${value}T12:00:00`) : null;

  const [viewYear,       setViewYear]       = useState(() => parsed?.getFullYear() ?? today.getFullYear());
  const [viewMonth,      setViewMonth]      = useState(() => parsed?.getMonth()    ?? today.getMonth());
  const [yearRangeStart, setYearRangeStart] = useState(() => yearBlockStart(parsed?.getFullYear() ?? today.getFullYear()));

  // ── Close on outside click ───────────────────────────────
  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // ── Open / close ─────────────────────────────────────────
  function handleToggle() {
    if (!open && containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      setOpenUpward(window.innerHeight - rect.bottom < 360);
      setMode("day");
    }
    setOpen(o => !o);
  }

  // ── Prev / Next arrows (behaviour depends on current mode) ─
  function handlePrev() {
    if (mode === "day") {
      if (viewMonth === 0) { setViewYear(y => y - 1); setViewMonth(11); }
      else setViewMonth(m => m - 1);
    } else if (mode === "month") {
      setViewYear(y => y - 1);
    } else {
      setYearRangeStart(s => s - 12);
    }
  }
  function handleNext() {
    if (mode === "day") {
      if (viewMonth === 11) { setViewYear(y => y + 1); setViewMonth(0); }
      else setViewMonth(m => m + 1);
    } else if (mode === "month") {
      setViewYear(y => y + 1);
    } else {
      setYearRangeStart(s => s + 12);
    }
  }

  // ── Header click: day → month → year ─────────────────────
  function handleHeaderClick() {
    if (mode === "day")   { setMode("month"); }
    if (mode === "month") {
      setYearRangeStart(yearBlockStart(viewYear));
      setMode("year");
    }
    // year mode header is not clickable (it's a range label)
  }

  // ── Day selection ────────────────────────────────────────
  const firstWeekday = new Date(viewYear, viewMonth, 1).getDay();
  const daysInMonth  = new Date(viewYear, viewMonth + 1, 0).getDate();
  const dayCells: (number | null)[] = [
    ...Array<null>(firstWeekday).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];
  while (dayCells.length % 7 !== 0) dayCells.push(null);

  function selectDay(day: number) {
    const m = String(viewMonth + 1).padStart(2, "0");
    const d = String(day).padStart(2, "0");
    onChange(`${viewYear}-${m}-${d}`);
    setOpen(false);
  }

  function isSelectedDay(day: number) {
    return !!parsed && parsed.getFullYear() === viewYear && parsed.getMonth() === viewMonth && parsed.getDate() === day;
  }
  function isTodayDay(day: number) {
    return today.getFullYear() === viewYear && today.getMonth() === viewMonth && today.getDate() === day;
  }

  // ── Month selection ──────────────────────────────────────
  function selectMonth(monthIndex: number) {
    setViewMonth(monthIndex);
    setMode("day");
  }
  function isSelectedMonth(monthIndex: number) {
    return !!parsed && parsed.getFullYear() === viewYear && parsed.getMonth() === monthIndex;
  }
  function isTodayMonth(monthIndex: number) {
    return today.getFullYear() === viewYear && today.getMonth() === monthIndex;
  }

  // ── Year selection ───────────────────────────────────────
  const yearCells = Array.from({ length: 12 }, (_, i) => yearRangeStart + i);

  function selectYear(year: number) {
    setViewYear(year);
    setMode("month");
  }
  function isSelectedYear(year: number) {
    return !!parsed && parsed.getFullYear() === year;
  }
  function isTodayYear(year: number) {
    return today.getFullYear() === year;
  }

  // ── Today shortcut ───────────────────────────────────────
  function selectToday() {
    const t = new Date();
    onChange(`${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`);
    setViewYear(t.getFullYear());
    setViewMonth(t.getMonth());
    setOpen(false);
  }

  // ── Header label per mode ────────────────────────────────
  const headerLabel =
    mode === "day"   ? `${CAL_MONTHS_LONG[viewMonth]} ${viewYear}` :
    mode === "month" ? `${viewYear}`                                :
    `${yearRangeStart} – ${yearRangeStart + 11}`;

  const headerClickable = mode !== "year";

  const displayText = parsed
    ? parsed.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
    : "";

  // ── Shared nav-arrow button ──────────────────────────────
  function NavArrow({ dir, onClick, label }: { dir: "left" | "right"; onClick: () => void; label: string }) {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        className="w-7 h-7 flex items-center justify-center rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors flex-shrink-0"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="w-3.5 h-3.5">
          <path d={dir === "left" ? "M15 18l-6-6 6-6" : "M9 18l6-6-6-6"}/>
        </svg>
      </button>
    );
  }

  return (
    <div ref={containerRef} className="relative">

      {/* ── Trigger button ─────────────────────────────────── */}
      <button
        type="button"
        onClick={handleToggle}
        className={`w-full flex items-center gap-2.5 px-3.5 py-2.5 text-left bg-white border rounded-lg transition-all focus:outline-none ${
          open
            ? "border-amber-400 ring-2 ring-amber-400/25 shadow-sm"
            : "border-slate-200 hover:border-slate-300 hover:shadow-sm"
        }`}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"
          className={`w-[17px] h-[17px] flex-shrink-0 transition-colors ${open ? "text-amber-500" : "text-slate-400"}`}>
          <rect x="3" y="4" width="18" height="17" rx="2"/>
          <path d="M3 10h18"/><path d="M8 2v4"/><path d="M16 2v4"/>
        </svg>
        <span className={`flex-1 text-[13.5px] ${displayText ? "text-slate-800 font-medium" : "text-slate-300"}`}>
          {displayText || "Select a date"}
        </span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
          className={`w-4 h-4 text-slate-400 flex-shrink-0 transition-transform duration-200 ${open ? "rotate-180 text-amber-500" : ""}`}>
          <path d="M6 9l6 6 6-6"/>
        </svg>
      </button>

      {/* ── Dropdown panel ─────────────────────────────────── */}
      {open && (
        <div className={`absolute left-0 z-30 bg-white border border-slate-200 rounded-xl shadow-2xl p-4 w-[272px] ${
          openUpward ? "bottom-full mb-2" : "top-full mt-2"
        }`}>

          {/* ── Shared header: prev arrow · label · next arrow ─ */}
          <div className="flex items-center justify-between mb-3 gap-1">
            <NavArrow dir="left"  onClick={handlePrev} label={mode === "day" ? "Previous month" : mode === "month" ? "Previous year" : "Previous 12 years"} />

            {headerClickable ? (
              <button
                type="button"
                onClick={handleHeaderClick}
                className="flex items-center gap-1.5 px-2 py-1 rounded-lg text-[13.5px] font-semibold text-slate-800 hover:bg-slate-100 transition-colors select-none"
                title={mode === "day" ? "Switch to month view" : "Switch to year view"}
              >
                {headerLabel}
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="w-3 h-3 text-slate-400">
                  <path d="M6 9l6 6 6-6"/>
                </svg>
              </button>
            ) : (
              <span className="text-[13px] font-semibold text-slate-500 select-none px-2">
                {headerLabel}
              </span>
            )}

            <NavArrow dir="right" onClick={handleNext} label={mode === "day" ? "Next month" : mode === "month" ? "Next year" : "Next 12 years"} />
          </div>

          {/* ══════════════════════════════
              DAY VIEW — month calendar grid
          ══════════════════════════════ */}
          {mode === "day" && (
            <>
              {/* Weekday labels */}
              <div className="grid grid-cols-7 mb-1">
                {CAL_DAYS.map(d => (
                  <div key={d} className="h-7 flex items-center justify-center text-[11px] font-semibold text-slate-400 select-none">
                    {d}
                  </div>
                ))}
              </div>

              {/* Day cells */}
              <div className="grid grid-cols-7 gap-y-0.5">
                {dayCells.map((day, idx) =>
                  day === null ? (
                    <div key={idx} className="h-8" />
                  ) : (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => selectDay(day)}
                      className={`h-8 w-8 mx-auto flex items-center justify-center rounded-lg text-[13px] transition-colors select-none ${
                        isSelectedDay(day)
                          ? "bg-slate-900 text-white font-semibold shadow-sm"
                          : isTodayDay(day)
                          ? "bg-amber-50 text-amber-700 font-semibold ring-1 ring-amber-300"
                          : "text-slate-700 hover:bg-slate-100 font-medium"
                      }`}
                    >
                      {day}
                    </button>
                  ),
                )}
              </div>
            </>
          )}

          {/* ══════════════════════════════
              MONTH VIEW — 3×4 month grid
          ══════════════════════════════ */}
          {mode === "month" && (
            <div className="grid grid-cols-3 gap-1.5">
              {CAL_MONTHS_SHORT.map((name, idx) => (
                <button
                  key={name}
                  type="button"
                  onClick={() => selectMonth(idx)}
                  className={`py-2.5 rounded-lg text-[13px] font-semibold transition-colors select-none ${
                    isSelectedMonth(idx)
                      ? "bg-slate-900 text-white shadow-sm"
                      : isTodayMonth(idx)
                      ? "bg-amber-50 text-amber-700 ring-1 ring-amber-300"
                      : "text-slate-700 hover:bg-slate-100"
                  }`}
                >
                  {name}
                </button>
              ))}
            </div>
          )}

          {/* ══════════════════════════════
              YEAR VIEW — 4×3 year grid
          ══════════════════════════════ */}
          {mode === "year" && (
            <div className="grid grid-cols-3 gap-1.5">
              {yearCells.map(year => (
                <button
                  key={year}
                  type="button"
                  onClick={() => selectYear(year)}
                  className={`py-2.5 rounded-lg text-[13px] font-semibold transition-colors select-none ${
                    isSelectedYear(year)
                      ? "bg-slate-900 text-white shadow-sm"
                      : isTodayYear(year)
                      ? "bg-amber-50 text-amber-700 ring-1 ring-amber-300"
                      : "text-slate-700 hover:bg-slate-100"
                  }`}
                >
                  {year}
                </button>
              ))}
            </div>
          )}

          {/* ── Today shortcut (day view only) ─────────────── */}
          {mode === "day" && (
            <div className="mt-3 pt-3 border-t border-slate-100">
              <button
                type="button"
                onClick={selectToday}
                className="w-full py-1.5 text-[12.5px] font-semibold text-slate-500 hover:text-slate-800 hover:bg-slate-50 rounded-lg transition-colors"
              >
                Today
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// COMPONENT
// ─────────────────────────────────────────────────────────────
export default function EmployeesClient() {
  const { role } = useAuth();
  const isAdmin = role === "admin";

  // ── Remote state ────────────────────────────────────────────
  const [employees,  setEmployees]  = useState<Employee[]>([]);
  const [fetching,   setFetching]   = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // ── Filter state ────────────────────────────────────────────
  const [statusFilter,      setStatusFilter]      = useState<"All" | "Active" | "Inactive">("All");
  const [designationFilter, setDesignationFilter] = useState<string>("All");

  // ── Modal state ─────────────────────────────────────────────
  const [modalOpen,      setModalOpen]      = useState(false);
  const [editingId,      setEditingId]      = useState<string | null>(null);
  const [form,           setForm]           = useState<EmployeeFormData>(EMPTY_FORM);
  const [errors,         setErrors]         = useState<FormErrors>({});
  const [saving,         setSaving]         = useState(false);
  const [showPassword,   setShowPassword]   = useState(false);

  // ── Delete confirmation ─────────────────────────────────────
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  // ── Success banner ───────────────────────────────────────────
  const [successMsg, setSuccessMsg] = useState("");

  // ── Load employees ───────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const data = await employeesService.getAllEmployees();
        if (!cancelled) setEmployees(data);
      } catch (err) {
        if (!cancelled) setFetchError(err instanceof Error ? err.message : "Failed to load employees.");
      } finally {
        if (!cancelled) setFetching(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  // Auto-clear success banner
  useEffect(() => {
    if (!successMsg) return;
    const t = setTimeout(() => setSuccessMsg(""), 4000);
    return () => clearTimeout(t);
  }, [successMsg]);

  // Close modal on Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") closeModal(); }
    if (modalOpen) document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [modalOpen]);

  // ── Derived lists ────────────────────────────────────────────
  const filteredEmployees = useMemo(() => {
    return employees.filter(emp => {
      const statusOk = statusFilter === "All"
        ? true
        : statusFilter === "Active" ? emp.isActive : !emp.isActive;
      const desigOk = designationFilter === "All" || emp.designation === designationFilter;
      return statusOk && desigOk;
    });
  }, [employees, statusFilter, designationFilter]);

  const statusCounts = useMemo(() => ({
    All:      employees.length,
    Active:   employees.filter(e => e.isActive).length,
    Inactive: employees.filter(e => !e.isActive).length,
  }), [employees]);

  // ── Auto-suggest employee_id ─────────────────────────────────
  function suggestEmployeeId(): string {
    return `EMP-${String(employees.length + 1).padStart(3, "0")}`;
  }

  // ── Modal helpers ────────────────────────────────────────────
  function openAdd() {
    const defaults = DESIGNATION_DEFAULTS["Receptionist"];
    setEditingId(null);
    setShowPassword(false);
    setForm({
      ...EMPTY_FORM,
      employeeId:   suggestEmployeeId(),
      canAccessApp: defaults.canAccessApp,
      appRole:      defaults.appRole ?? "",
      tempPassword: "",
    });
    setErrors({});
    setModalOpen(true);
  }

  function openEdit(emp: Employee) {
    setEditingId(emp.id);
    setShowPassword(false);
    setForm({
      fullName:         emp.fullName,
      employeeId:       emp.employeeId,
      designation:      emp.designation,
      phone:            emp.phone ?? "",
      email:            emp.email ?? "",
      bloodGroup:       emp.bloodGroup ?? "",
      joiningDate:      emp.joiningDate ?? "",
      emergencyContact: emp.emergencyContact ?? "",
      address:          emp.address ?? "",
      canAccessApp:     emp.canAccessApp,
      appRole:          emp.appRole ?? "",
      tempPassword:     "",
      notes:            emp.notes ?? "",
      isActive:         emp.isActive,
    });
    setErrors({});
    setModalOpen(true);
  }

  function closeModal() {
    setModalOpen(false);
    setEditingId(null);
    setForm(EMPTY_FORM);
    setErrors({});
    setSaving(false);
    setShowPassword(false);
  }

  function setField<K extends keyof EmployeeFormData>(key: K, value: EmployeeFormData[K]) {
    setForm(prev => ({ ...prev, [key]: value }));
    if (errors[key]) setErrors(prev => ({ ...prev, [key]: undefined }));
  }

  // When designation changes, auto-set the default app access.
  // Admin can always override.
  function handleDesignationChange(newDesig: string) {
    const defaults = DESIGNATION_DEFAULTS[newDesig as Designation];
    setForm(prev => ({
      ...prev,
      designation:  newDesig,
      canAccessApp: defaults.canAccessApp,
      appRole:      defaults.appRole ?? "",
    }));
    setErrors(prev => ({ ...prev, designation: undefined }));
  }

  // Toggle off: clears role + tempPassword.
  // Toggle on: restores designation default role.
  function handleCanAccessAppChange(checked: boolean) {
    setForm(prev => ({
      ...prev,
      canAccessApp: checked,
      appRole: checked
        ? (prev.appRole || DESIGNATION_DEFAULTS[prev.designation as Designation]?.appRole || "staff")
        : "",
      tempPassword: checked ? prev.tempPassword : "",
    }));
  }

  // ── Validation ───────────────────────────────────────────────
  function validate(): boolean {
    const e: FormErrors = {};

    if (!form.fullName.trim())   e.fullName   = "Full name is required.";
    if (!form.employeeId.trim()) e.employeeId = "Employee ID is required.";
    if (!form.designation)       e.designation = "Designation is required.";

    if (form.employeeId.trim()) {
      const dup = employees.find(
        emp => emp.employeeId === form.employeeId.trim() && emp.id !== editingId,
      );
      if (dup) e.employeeId = `"${form.employeeId.trim()}" is already in use.`;
    }

    if (form.canAccessApp) {
      if (!form.appRole) {
        e.appRole = "Select a role when app access is enabled.";
      }
      // Email + password are only required when ADDING a new employee with app access.
      // Editing does not re-provision the auth account.
      if (!editingId) {
        if (!form.email.trim()) {
          e.email = "Email is required to create a login account.";
        }
        if (!form.tempPassword) {
          e.tempPassword = "Temporary password is required to create a login account.";
        } else if (form.tempPassword.length < 6) {
          e.tempPassword = "Password must be at least 6 characters.";
        }
      }
    }

    setErrors(e);
    return Object.keys(e).length === 0;
  }

  // ── Submit ───────────────────────────────────────────────────
  //
  // Two code paths depending on can_access_app and whether it's an add or edit:
  //
  //   EDIT (any)         → updateEmployee() directly; auth account already exists.
  //
  //   ADD, no app access → addEmployee() directly; just a directory record.
  //
  //   ADD, app access    → POST /api/employees/provision (server-side):
  //                          • creates Supabase Auth user (email + tempPassword)
  //                          • inserts employee row with auth_user_id set
  //                          • upserts profiles row so the employee can log in
  //                        tempPassword is sent to the API and used only there —
  //                        it is never stored in the employees table.
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validate()) return;
    setSaving(true);

    // Base employee data (used for both paths)
    const empData: Omit<Employee, "id" | "createdAt"> = {
      employeeId:       form.employeeId.trim(),
      fullName:         form.fullName.trim(),
      email:            form.email.trim() || null,
      phone:            form.phone.trim() || null,
      photoUrl:         null,   // set via staff self-profile, not here
      bloodGroup:       form.bloodGroup || null,
      designation:      form.designation as Designation,
      canAccessApp:     form.canAccessApp,
      appRole:          form.canAccessApp ? (form.appRole as EmployeeAppRole || null) : null,
      joiningDate:      form.joiningDate || null,
      emergencyContact: form.emergencyContact.trim() || null,
      address:          form.address.trim() || null,
      notes:            form.notes.trim() || null,
      isActive:         form.isActive,
      authUserId:       null,
    };

    try {
      // ── EDIT ────────────────────────────────────────────────
      if (editingId) {
        setEmployees(prev => prev.map(emp =>
          emp.id === editingId ? { ...emp, ...empData } : emp,
        ));
        await employeesService.updateEmployee(editingId, empData);
        setSuccessMsg(`${form.fullName.trim()} updated successfully.`);

      // ── ADD with app access → provision endpoint ────────────
      } else if (form.canAccessApp) {
        const placeholder: Employee = {
          ...empData,
          id:        `pending-${Date.now()}`,
          createdAt: new Date().toISOString(),
        };
        setEmployees(prev => [placeholder, ...prev]);

        // Get the logged-in admin's session token to authenticate the API call
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) throw new Error("No active session — please sign in again.");

        const res = await fetch("/api/employees/provision", {
          method:  "POST",
          headers: {
            "Content-Type":  "application/json",
            "Authorization": `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({
            employee: {
              employeeId:       empData.employeeId,
              fullName:         empData.fullName,
              email:            form.email.trim(),
              phone:            empData.phone,
              bloodGroup:       empData.bloodGroup,
              designation:      empData.designation,
              canAccessApp:     true,
              appRole:          empData.appRole as "admin" | "staff",
              joiningDate:      empData.joiningDate,
              emergencyContact: empData.emergencyContact,
              address:          empData.address,
              notes:            empData.notes,
              isActive:         empData.isActive,
            },
            tempPassword: form.tempPassword,
          }),
        });

        // Read the body as text first — if the server returns HTML (e.g. an
        // unhandled crash or a misrouted request), res.json() would throw the
        // useless "Unexpected token '<'" error and hide the real message.
        const rawText = await res.text();
        let json: { employee?: Employee; error?: string } | null = null;
        try {
          json = JSON.parse(rawText) as { employee?: Employee; error?: string };
        } catch {
          // Server returned non-JSON — log the first 500 chars for debugging
          console.error(
            "[EmployeesClient] provision: non-JSON response (first 500 chars):\n",
            rawText.slice(0, 500),
          );
        }

        if (!res.ok) {
          throw new Error(
            json?.error ??
            `Provisioning failed (HTTP ${res.status}). ` +
            `Server replied: ${rawText.slice(0, 200)}`,
          );
        }

        if (!json?.employee) {
          throw new Error(
            `Provisioning returned an unexpected response. ` +
            `Server replied: ${rawText.slice(0, 200)}`,
          );
        }

        const saved = json.employee;
        setEmployees(prev => prev.map(emp => emp.id === placeholder.id ? saved : emp));
        setSuccessMsg(
          `${saved.fullName} added and login account created. They can sign in immediately.`,
        );

      // ── ADD without app access → directory record only ──────
      } else {
        const placeholder: Employee = {
          ...empData,
          id:        `pending-${Date.now()}`,
          createdAt: new Date().toISOString(),
        };
        setEmployees(prev => [placeholder, ...prev]);
        const saved = await employeesService.addEmployee(empData);
        setEmployees(prev => prev.map(emp => emp.id === placeholder.id ? saved : emp));
        setSuccessMsg(`${saved.fullName} added to employee directory.`);
      }

      closeModal();
    } catch (err) {
      console.error("[EmployeesClient] save failed:", err instanceof Error ? err.message : err);
      // Show the error in the form instead of silently failing
      setErrors({ fullName: err instanceof Error ? err.message : "An unexpected error occurred." });
      setSaving(false);
      if (!editingId) {
        setEmployees(prev => prev.filter(emp => !emp.id.startsWith("pending-")));
      }
    }
  }

  // ── Delete ───────────────────────────────────────────────────
  function handleDeleteClick(emp: Employee) {
    if (deleteConfirmId === emp.id) {
      setEmployees(prev => prev.filter(e => e.id !== emp.id));
      employeesService.deleteEmployee(emp.id).catch(err =>
        console.error("[EmployeesClient deleteEmployee] failed:", err instanceof Error ? err.message : err),
      );
      setSuccessMsg(`${emp.fullName} removed from directory.`);
      setDeleteConfirmId(null);
    } else {
      setDeleteConfirmId(emp.id);
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
            Employees
          </h1>
          <p className="text-[13px] text-slate-500 mt-1">
            {employees.filter(e => e.isActive).length} active employee{employees.filter(e => e.isActive).length !== 1 ? "s" : ""} ·{" "}
            {employees.filter(e => e.canAccessApp).length} with app access
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
            Add Employee
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
          FILTER BAR
      ══════════════════════════════════════════════════════ */}
      <div className="flex flex-wrap items-center gap-4">

        <div className="flex items-center gap-1.5">
          <span className="text-[12px] font-semibold text-slate-400 uppercase tracking-wider mr-1">Status</span>
          {(["All", "Active", "Inactive"] as const).map(s => (
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
              <span className={`ml-1.5 text-[11px] font-bold ${statusFilter === s ? "text-white/70" : "text-slate-400"}`}>
                {statusCounts[s]}
              </span>
            </button>
          ))}
        </div>

        <div className="w-px h-5 bg-slate-200" />

        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[12px] font-semibold text-slate-400 uppercase tracking-wider mr-1">Role</span>
          {(["All", ...DESIGNATIONS] as string[]).map(d => (
            <button
              key={d}
              onClick={() => setDesignationFilter(d)}
              className={`px-3 py-1.5 rounded-lg text-[12.5px] font-medium transition-colors whitespace-nowrap ${
                designationFilter === d
                  ? "bg-slate-900 text-white shadow-sm"
                  : "bg-white border border-slate-200 text-slate-500 hover:text-slate-700 hover:border-slate-300"
              }`}
            >
              {d === "All" ? "All Roles" : d}
            </button>
          ))}
        </div>
      </div>

      {/* ══════════════════════════════════════════════════════
          LOADING / ERROR
      ══════════════════════════════════════════════════════ */}
      {fetching && (
        <div className="flex items-center justify-center py-16">
          <div className="w-6 h-6 border-2 border-slate-200 border-t-amber-500 rounded-full animate-spin" />
        </div>
      )}
      {fetchError && !fetching && (
        <div className="bg-rose-50 border border-rose-200 rounded-xl px-5 py-4 text-[13px] text-rose-700">
          Failed to load employees: {fetchError}
        </div>
      )}

      {/* ══════════════════════════════════════════════════════
          EMPLOYEES TABLE
      ══════════════════════════════════════════════════════ */}
      {!fetching && !fetchError && (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200">
                  {["Employee", "Designation", "Contact", "Blood Group", "App Access", "Joined", "Status", ...(isAdmin ? ["Actions"] : [])].map(h => (
                    <th key={h} className="text-left px-5 py-3 text-[11px] font-semibold text-slate-400 uppercase tracking-wider whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredEmployees.length === 0 ? (
                  <tr>
                    <td colSpan={isAdmin ? 8 : 7} className="px-5 py-12 text-center text-[13px] text-slate-400">
                      {employees.length === 0 ? "No employees yet. Add your first employee." : "No employees match the selected filters."}
                    </td>
                  </tr>
                ) : filteredEmployees.map(emp => {
                  const isConfirm = deleteConfirmId === emp.id;
                  return (
                    <tr
                      key={emp.id}
                      className="hover:bg-slate-50/70 transition-colors"
                      onClick={() => { if (deleteConfirmId && deleteConfirmId !== emp.id) setDeleteConfirmId(null); }}
                    >
                      {/* Employee name + ID + initials avatar */}
                      <td className="px-5 py-3.5">
                        <div className="flex items-center gap-3">
                          <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 text-[11px] font-bold ${avatarColor(emp.fullName)}`}>
                            {initials(emp.fullName)}
                          </div>
                          <div>
                            <p className="font-semibold text-slate-800 leading-tight">{emp.fullName}</p>
                            <p className="text-[11.5px] text-slate-400 leading-tight">{emp.employeeId}</p>
                          </div>
                        </div>
                      </td>

                      {/* Designation */}
                      <td className="px-5 py-3.5">
                        <span className={`px-2.5 py-1 rounded-md text-[12px] font-semibold whitespace-nowrap ${designationBadge(emp.designation)}`}>
                          {emp.designation}
                        </span>
                      </td>

                      {/* Contact */}
                      <td className="px-5 py-3.5">
                        <div className="space-y-0.5">
                          {emp.phone && <p className="text-slate-700 whitespace-nowrap">{emp.phone}</p>}
                          {emp.email && <p className="text-slate-400 text-[12px] whitespace-nowrap">{emp.email}</p>}
                          {!emp.phone && !emp.email && <span className="text-slate-300">—</span>}
                        </div>
                      </td>

                      {/* Blood Group */}
                      <td className="px-5 py-3.5">
                        {emp.bloodGroup ? (
                          <span className="bg-rose-50 text-rose-700 ring-1 ring-rose-200 px-2.5 py-1 rounded-md text-[12px] font-semibold">
                            {emp.bloodGroup}
                          </span>
                        ) : (
                          <span className="text-slate-300">—</span>
                        )}
                      </td>

                      {/* App Access */}
                      <td className="px-5 py-3.5">
                        {emp.canAccessApp ? (
                          <div className="space-y-1">
                            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11.5px] font-semibold bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200">
                              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 flex-shrink-0" />
                              App Access
                            </span>
                            {emp.appRole && (
                              <span className={`inline-block px-2 py-0.5 rounded text-[11px] font-semibold capitalize ${roleBadge(emp.appRole)}`}>
                                {emp.appRole}
                              </span>
                            )}
                          </div>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11.5px] font-medium bg-slate-100 text-slate-500">
                            <span className="w-1.5 h-1.5 rounded-full bg-slate-300 flex-shrink-0" />
                            No Access
                          </span>
                        )}
                      </td>

                      {/* Joined */}
                      <td className="px-5 py-3.5 text-slate-500 whitespace-nowrap text-[12.5px]">
                        {emp.joiningDate
                          ? new Date(`${emp.joiningDate}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
                          : <span className="text-slate-300">—</span>}
                      </td>

                      {/* Status */}
                      <td className="px-5 py-3.5">
                        <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[12px] font-semibold ${
                          emp.isActive
                            ? "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200"
                            : "bg-slate-100 text-slate-500 ring-1 ring-slate-200"
                        }`}>
                          <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${emp.isActive ? "bg-emerald-500" : "bg-slate-300"}`} />
                          {emp.isActive ? "Active" : "Inactive"}
                        </span>
                      </td>

                      {/* Actions — admin only */}
                      {isAdmin && (
                        <td className="px-5 py-3.5">
                          {isConfirm ? (
                            <div className="flex items-center gap-1.5">
                              <span className="text-[11.5px] text-rose-600 font-semibold whitespace-nowrap">Delete?</span>
                              <button onClick={() => handleDeleteClick(emp)} className="text-[12px] font-semibold text-white bg-rose-500 hover:bg-rose-600 px-3 py-1.5 rounded-lg transition-colors">
                                Yes
                              </button>
                              <button onClick={() => setDeleteConfirmId(null)} className="text-[12px] font-medium text-slate-500 border border-slate-200 hover:bg-slate-50 px-3 py-1.5 rounded-lg transition-colors">
                                No
                              </button>
                            </div>
                          ) : (
                            <div className="flex items-center gap-2">
                              <button onClick={() => openEdit(emp)} className="text-[12px] font-medium text-slate-500 hover:text-slate-800 border border-slate-200 hover:border-slate-300 bg-white hover:bg-slate-50 px-3 py-1.5 rounded-lg transition-colors">
                                Edit
                              </button>
                              <button onClick={() => handleDeleteClick(emp)} className="text-[12px] font-medium text-slate-400 hover:text-rose-600 border border-slate-200 hover:border-rose-200 hover:bg-rose-50 px-3 py-1.5 rounded-lg transition-colors">
                                Delete
                              </button>
                            </div>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Table footer */}
          <div className="px-5 py-3 border-t border-slate-100 bg-slate-50 flex items-center justify-between">
            <p className="text-[12px] text-slate-400">
              Showing {filteredEmployees.length} of {employees.length} employee{employees.length !== 1 ? "s" : ""}
              {(statusFilter !== "All" || designationFilter !== "All") && (
                <button
                  onClick={() => { setStatusFilter("All"); setDesignationFilter("All"); }}
                  className="ml-2 text-amber-600 hover:underline font-medium"
                >
                  Clear filters
                </button>
              )}
            </p>
            <p className="text-[12px] text-slate-400 italic">
              App access does not automatically create login accounts
            </p>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════
          ADD / EDIT MODAL
      ══════════════════════════════════════════════════════ */}
      {modalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm"
          onClick={e => { if (e.target === e.currentTarget) closeModal(); }}
        >
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl flex flex-col max-h-[90vh]">

            {/* ── Modal header ──────────────────────────────── */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 bg-slate-50 flex-shrink-0 rounded-t-2xl">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-slate-800 flex items-center justify-center flex-shrink-0">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-4 h-4 text-white">
                    {editingId
                      ? <><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></>
                      : <path d="M12 5v14M5 12h14"/>}
                  </svg>
                </div>
                <div>
                  <h2 className="text-[15px] font-semibold text-slate-800 leading-none">
                    {editingId ? `Edit — ${form.fullName || "Employee"}` : "Add New Employee"}
                  </h2>
                  <p className="text-[11.5px] text-slate-400 mt-0.5">Fields marked <span className="text-rose-400">*</span> are required</p>
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

            {/* ── Scrollable form body ───────────────────────── */}
            <form onSubmit={handleSubmit} noValidate className="flex flex-col flex-1 min-h-0">
              <div className="overflow-y-auto flex-1 px-6 py-5 space-y-6">

                {/* ─────────── SECTION: IDENTITY ─────────────── */}
                <div>
                  <SectionHeading>Identity</SectionHeading>
                  <div className="grid grid-cols-2 gap-4">

                    {/* Full Name — spans both columns */}
                    <div className="col-span-2">
                      <FieldLabel required>Full Name</FieldLabel>
                      <input
                        type="text"
                        placeholder="e.g. Sarah Johnson"
                        value={form.fullName}
                        onChange={e => setField("fullName", e.target.value)}
                        className={inputCls(!!errors.fullName)}
                      />
                      {errors.fullName && <p className="mt-1.5 text-[11.5px] text-rose-600">{errors.fullName}</p>}
                    </div>

                    {/* Employee ID */}
                    <div>
                      <FieldLabel required>Employee ID</FieldLabel>
                      <input
                        type="text"
                        placeholder="e.g. EMP-001"
                        value={form.employeeId}
                        onChange={e => setField("employeeId", e.target.value)}
                        className={inputCls(!!errors.employeeId)}
                      />
                      {errors.employeeId && <p className="mt-1.5 text-[11.5px] text-rose-600">{errors.employeeId}</p>}
                    </div>

                    {/* Designation */}
                    <div>
                      <FieldLabel required>Designation</FieldLabel>
                      <div className="relative">
                        <select
                          value={form.designation}
                          onChange={e => handleDesignationChange(e.target.value)}
                          className="w-full px-3.5 py-2.5 text-[13.5px] text-slate-800 bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-amber-400 focus:border-transparent transition appearance-none cursor-pointer pr-9"
                        >
                          {DESIGNATIONS.map(d => (
                            <option key={d} value={d}>{d}</option>
                          ))}
                        </select>
                        {/* Chevron */}
                        <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-slate-400">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-4 h-4">
                            <path d="M6 9l6 6 6-6"/>
                          </svg>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* ─────────── SECTION: CONTACT ──────────────── */}
                <div>
                  <SectionHeading>Contact</SectionHeading>
                  <div className="grid grid-cols-2 gap-4">

                    {/* Phone */}
                    <div>
                      <FieldLabel>Phone</FieldLabel>
                      <input
                        type="tel"
                        placeholder="+880 1XXX-XXXXXX"
                        value={form.phone}
                        onChange={e => setField("phone", e.target.value)}
                        className={inputCls()}
                      />
                    </div>

                    {/* Email */}
                    <div>
                      <FieldLabel>Email</FieldLabel>
                      <input
                        type="email"
                        placeholder="name@hotel.com"
                        value={form.email}
                        onChange={e => setField("email", e.target.value)}
                        className={inputCls(!!errors.email)}
                      />
                      {errors.email && (
                        <p className="mt-1.5 text-[11.5px] text-rose-600">{errors.email}</p>
                      )}
                    </div>
                  </div>

                  {/* Photo note — no upload here */}
                  <div className="mt-3 flex items-start gap-2.5 bg-slate-50 border border-slate-200 rounded-lg px-4 py-3">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" className="w-4 h-4 text-slate-400 flex-shrink-0 mt-0.5">
                      <rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>
                    </svg>
                    <p className="text-[12px] text-slate-500 leading-relaxed">
                      <span className="font-semibold text-slate-700">Profile photo is not set here.</span>{" "}
                      Staff members upload their own photo from their personal profile section, which will be available in a future update.
                    </p>
                  </div>
                </div>

                {/* ─────────── SECTION: PERSONAL INFO ───────── */}
                <div>
                  <SectionHeading>Personal Info</SectionHeading>
                  <div className="grid grid-cols-2 gap-4">

                    {/* Blood Group */}
                    <div>
                      <FieldLabel>Blood Group</FieldLabel>
                      <div className="relative">
                        <select
                          value={form.bloodGroup}
                          onChange={e => setField("bloodGroup", e.target.value)}
                          className="w-full px-3.5 py-2.5 text-[13.5px] text-slate-800 bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-amber-400 focus:border-transparent transition appearance-none cursor-pointer pr-9"
                        >
                          <option value="">Select…</option>
                          {BLOOD_GROUPS.map(g => <option key={g} value={g}>{g}</option>)}
                        </select>
                        <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-slate-400">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-4 h-4">
                            <path d="M6 9l6 6 6-6"/>
                          </svg>
                        </div>
                      </div>
                    </div>

                    {/* Joining Date — custom calendar picker */}
                    <div>
                      <FieldLabel>Joining Date</FieldLabel>
                      <DatePickerField
                        value={form.joiningDate}
                        onChange={v => setField("joiningDate", v)}
                      />
                    </div>

                    {/* Emergency Contact */}
                    <div>
                      <FieldLabel>Emergency Contact</FieldLabel>
                      <input
                        type="text"
                        placeholder="Name — phone number"
                        value={form.emergencyContact}
                        onChange={e => setField("emergencyContact", e.target.value)}
                        className={inputCls()}
                      />
                    </div>

                    {/* Address */}
                    <div>
                      <FieldLabel>Address</FieldLabel>
                      <input
                        type="text"
                        placeholder="Residential address"
                        value={form.address}
                        onChange={e => setField("address", e.target.value)}
                        className={inputCls()}
                      />
                    </div>
                  </div>
                </div>

                {/* ─────────── SECTION: APP ACCESS ───────────── */}
                <div>
                  <SectionHeading>App Access</SectionHeading>

                  {/* Toggle card */}
                  <div className="border border-slate-200 rounded-xl overflow-hidden">

                    {/* Toggle row */}
                    <div className="flex items-center justify-between px-4 py-3.5 bg-white">
                      <div>
                        <p className="text-[13.5px] font-semibold text-slate-800">Can access app?</p>
                        <p className="text-[12px] text-slate-400 mt-0.5">
                          {form.canAccessApp
                            ? "Employee will be eligible for a login account."
                            : "Directory record only — no login account needed."}
                        </p>
                      </div>
                      <Toggle checked={form.canAccessApp} onChange={handleCanAccessAppChange} />
                    </div>

                    {/* Expanded fields — only when can_access_app is true */}
                    {form.canAccessApp && (
                      <div className="border-t border-slate-100 bg-slate-50 px-4 py-4 space-y-4">

                        {/* App Role */}
                        <div>
                          <FieldLabel required>App Role</FieldLabel>
                          <div className="flex items-stretch gap-3">
                            {(["admin", "staff"] as const).map(r => {
                              const active = form.appRole === r;
                              return (
                                <button
                                  key={r}
                                  type="button"
                                  onClick={() => setField("appRole", r)}
                                  className={`flex-1 flex items-center gap-3 px-4 py-3 rounded-lg border text-left transition-all ${
                                    active
                                      ? "border-amber-400 bg-amber-50 ring-1 ring-amber-300"
                                      : "border-slate-200 bg-white hover:border-slate-300"
                                  }`}
                                >
                                  <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${
                                    active ? "border-amber-500" : "border-slate-300"
                                  }`}>
                                    {active && <div className="w-2 h-2 rounded-full bg-amber-500" />}
                                  </div>
                                  <div>
                                    <p className={`text-[13px] font-semibold capitalize ${active ? "text-amber-800" : "text-slate-700"}`}>
                                      {r}
                                    </p>
                                    <p className={`text-[11.5px] mt-0.5 ${active ? "text-amber-600" : "text-slate-400"}`}>
                                      {r === "admin" ? "Full access to all modules" : "Standard front-desk access"}
                                    </p>
                                  </div>
                                </button>
                              );
                            })}
                          </div>
                          {errors.appRole && <p className="mt-1.5 text-[11.5px] text-rose-600">{errors.appRole}</p>}
                        </div>

                        {/* Temporary Password */}
                        <div>
                          <FieldLabel hint="(for initial login)">Temporary Password</FieldLabel>
                          <div className="relative">
                            <input
                              type={showPassword ? "text" : "password"}
                              placeholder="Set a temporary password for first login"
                              value={form.tempPassword}
                              onChange={e => setField("tempPassword", e.target.value)}
                              className="w-full px-3.5 py-2.5 pr-11 text-[13.5px] text-slate-800 bg-white border border-slate-200 rounded-lg placeholder:text-slate-300 focus:outline-none focus:ring-2 focus:ring-amber-400 focus:border-transparent transition"
                            />
                            {/* Show / hide toggle */}
                            <button
                              type="button"
                              onClick={() => setShowPassword(p => !p)}
                              className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 transition-colors"
                              tabIndex={-1}
                              aria-label={showPassword ? "Hide password" : "Show password"}
                            >
                              {showPassword ? (
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" className="w-4.5 h-4.5">
                                  <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/>
                                  <line x1="1" y1="1" x2="23" y2="23"/>
                                </svg>
                              ) : (
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" className="w-4.5 h-4.5">
                                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
                                </svg>
                              )}
                            </button>
                          </div>
                          {errors.tempPassword && (
                            <p className="mt-1.5 text-[11.5px] text-rose-600">{errors.tempPassword}</p>
                          )}
                          {/* Info note */}
                          <p className="mt-1.5 flex items-center gap-1.5 text-[11.5px] text-slate-400">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" className="w-3.5 h-3.5 flex-shrink-0">
                              <circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>
                            </svg>
                            This password is used to create the login account securely on the server. It is never stored in the employee record.
                          </p>
                        </div>

                      </div>
                    )}
                  </div>
                </div>

                {/* ─────────── SECTION: NOTES & STATUS ──────── */}
                <div>
                  <SectionHeading>Notes{editingId ? " & Status" : ""}</SectionHeading>
                  <div className="space-y-4">

                    {/* Notes */}
                    <div>
                      <FieldLabel>Notes</FieldLabel>
                      <textarea
                        rows={2}
                        placeholder="Any additional notes about this employee…"
                        value={form.notes}
                        onChange={e => setField("notes", e.target.value)}
                        className="w-full px-3.5 py-2.5 text-[13.5px] text-slate-800 bg-white border border-slate-200 rounded-lg placeholder:text-slate-300 focus:outline-none focus:ring-2 focus:ring-amber-400 focus:border-transparent transition resize-none"
                      />
                    </div>

                    {/* Active toggle — edit mode only */}
                    {editingId && (
                      <div className="flex items-center justify-between bg-white border border-slate-200 rounded-xl px-4 py-3.5">
                        <div>
                          <p className="text-[13.5px] font-semibold text-slate-800">Active employee</p>
                          <p className="text-[12px] text-slate-400 mt-0.5">
                            Inactive employees remain in the directory but are excluded from the active count.
                          </p>
                        </div>
                        <Toggle
                          checked={form.isActive}
                          onChange={v => setField("isActive", v)}
                        />
                      </div>
                    )}
                  </div>
                </div>

              </div>

              {/* ── Modal footer — fixed save/cancel bar ──────── */}
              <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-slate-100 bg-white flex-shrink-0 rounded-b-2xl">
                <button
                  type="button"
                  onClick={closeModal}
                  className="px-4 py-2.5 text-[13px] font-medium text-slate-600 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="flex items-center gap-2 px-5 py-2.5 text-[13px] font-semibold text-white bg-slate-900 hover:bg-slate-800 disabled:opacity-60 rounded-lg transition-colors shadow-sm"
                >
                  {saving ? (
                    <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  ) : (
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-4 h-4">
                      <path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><path d="M22 4L12 14.01l-3-3"/>
                    </svg>
                  )}
                  {saving ? "Saving…" : editingId ? "Save Changes" : "Add Employee"}
                </button>
              </div>
            </form>

          </div>
        </div>
      )}
    </div>
  );
}

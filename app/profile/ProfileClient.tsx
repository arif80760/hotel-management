"use client";

// app/profile/ProfileClient.tsx
//
// Staff Self Profile page.
//
// WHO can use this:
//   Any authenticated user whose login account is linked to an employee record
//   via employees.auth_user_id = auth.users.id.  Both staff and admins see the
//   same page — admins are not special here.
//
// WHAT is read-only (admin-controlled):
//   full_name, employee_id, designation, app_role, can_access_app, joining_date, email
//
// WHAT is editable by the employee:
//   phone, address, emergency_contact, blood_group, photo_url
//
// PHOTO FLOW:
//   1. User picks a file → uploaded to "employee-photos" Storage (gets a public URL)
//   2. URL is placed into the photoUrl form-field state (marks form dirty)
//   3. User clicks Save → all editable fields INCLUDING the new photoUrl are written
//      to employees in a single updateEmployee call.
//   This means the DB is only updated on an explicit Save — consistent with the
//   other editable fields.  A Storage upload that isn't followed by Save leaves an
//   orphaned object in Storage but the DB remains unchanged (safe).
//
// NOT LINKED:
//   If no employee record has auth_user_id matching the logged-in user, a
//   clear message is shown asking them to contact an admin.

import { useEffect, useRef, useState, useCallback } from "react";
import { useAuth } from "@/contexts/AuthContext";
import {
  getEmployeeByAuthUserId,
  updateEmployee,
  uploadEmployeePhoto,
  BLOOD_GROUPS,
  type Employee,
} from "@/services/employeesService";

// ─── Tiny UI helpers ──────────────────────────────────────────

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[10.5px] font-semibold uppercase tracking-widest text-slate-400 mb-4">
      {children}
    </h3>
  );
}

function ReadOnlyField({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string | null | undefined;
  mono?: boolean;
}) {
  return (
    <div>
      <p className="text-[11px] font-medium text-slate-400 uppercase tracking-wide mb-1">
        {label}
      </p>
      {value ? (
        <p className={`text-[13.5px] text-slate-800 font-medium leading-snug ${mono ? "font-mono" : ""}`}>
          {value}
        </p>
      ) : (
        <p className="text-[13.5px] text-slate-300 italic">—</p>
      )}
    </div>
  );
}

const inputCls = (hasError = false) =>
  [
    "w-full rounded-lg border px-3 py-2 text-[13.5px] text-slate-800",
    "placeholder-slate-300 focus:outline-none focus:ring-2 transition-colors",
    hasError
      ? "border-rose-300 bg-rose-50 focus:ring-rose-300/60 focus:border-rose-400"
      : "border-slate-200 bg-white focus:ring-amber-400/60 focus:border-amber-400",
  ].join(" ");

// ─── Spinner (reused in two places) ──────────────────────────

function Spinner({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={`${className} animate-spin`} viewBox="0 0 24 24" fill="none">
      <circle
        cx="12" cy="12" r="10"
        stroke="currentColor" strokeWidth="3"
        strokeDasharray="31.4" strokeDashoffset="10"
        strokeLinecap="round"
      />
    </svg>
  );
}

// ─── Format "YYYY-MM-DD" → "15 Jan 2024" ─────────────────────

function formatDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const [y, m, d] = iso.split("-");
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${parseInt(d, 10)} ${months[parseInt(m, 10) - 1]} ${y}`;
}

// ─── Auto-dismiss hook ────────────────────────────────────────
// Clears a message state after `ms` milliseconds whenever the value changes.

function useAutoDismiss(
  value: string | null,
  setter: (v: null) => void,
  ms = 4000,
) {
  useEffect(() => {
    if (!value) return;
    const t = setTimeout(() => setter(null), ms);
    return () => clearTimeout(t);
  }, [value, setter, ms]);
}

// ─── Main component ───────────────────────────────────────────

export default function ProfileClient() {
  const { user } = useAuth();

  // ── Remote state ─────────────────────────────────────────────
  const [employee,  setEmployee]  = useState<Employee | null>(null);
  const [loading,   setLoading]   = useState(true);
  const [notLinked, setNotLinked] = useState(false);

  // ── Editable form values (all 5 editable fields) ────────────
  const [phone,     setPhone]     = useState("");
  const [address,   setAddress]   = useState("");
  const [emergency, setEmergency] = useState("");
  const [blood,     setBlood]     = useState("");
  // photoUrl is a form field — set when a file is uploaded to Storage.
  // It is NOT written to the DB until the user clicks Save.
  const [photoUrl,  setPhotoUrl]  = useState<string | null>(null);

  // ── Save state ────────────────────────────────────────────────
  const [saving,    setSaving]    = useState(false);
  const [saveOk,    setSaveOk]    = useState<string | null>(null);
  const [saveErr,   setSaveErr]   = useState<string | null>(null);

  // ── Photo upload UI state (separate from the photoUrl form field) ─
  // photoPreview  — the <img> src; may be a blob URL during upload,
  //                 then the stable Storage URL once upload succeeds.
  // uploading     — true while the file is being sent to Storage.
  // photoOk/Err   — transient feedback messages.
  const fileRef                             = useRef<HTMLInputElement>(null);
  const [photoPreview, setPhotoPreview]     = useState<string | null>(null);
  const [uploading,    setUploading]        = useState(false);
  const [photoOk,      setPhotoOk]          = useState<string | null>(null);
  const [photoErr,     setPhotoErr]         = useState<string | null>(null);

  // Auto-dismiss all feedback messages
  const clearSaveOk  = useCallback((v: null) => setSaveOk(v),  []);
  const clearSaveErr = useCallback((v: null) => setSaveErr(v), []);
  const clearPhotoOk = useCallback((v: null) => setPhotoOk(v), []);
  const clearPhotoErr= useCallback((v: null) => setPhotoErr(v),[]);
  useAutoDismiss(saveOk,   clearSaveOk,   4000);
  useAutoDismiss(saveErr,  clearSaveErr,  6000);
  useAutoDismiss(photoOk,  clearPhotoOk,  4000);
  useAutoDismiss(photoErr, clearPhotoErr, 6000);

  // ── Dirty detection ───────────────────────────────────────────
  // Save button is active when ANY editable field differs from what
  // is currently stored in the DB (represented by `employee`).
  // photoUrl is included — it is set when a file is uploaded to Storage
  // but has not been written to the DB yet.
  const isDirty =
    employee !== null && (
      (phone.trim()     || null) !== (employee.phone            ?? null) ||
      (address.trim()   || null) !== (employee.address          ?? null) ||
      (emergency.trim() || null) !== (employee.emergencyContact ?? null) ||
      (blood             || null) !== (employee.bloodGroup       ?? null) ||
      photoUrl                   !== (employee.photoUrl         ?? null)
    );

  // ── Fetch employee linked to this auth user ───────────────────

  useEffect(() => {
    if (!user?.id) return;
    setLoading(true);
    setNotLinked(false);

    getEmployeeByAuthUserId(user.id)
      .then((emp) => {
        if (!emp) {
          setNotLinked(true);
          return;
        }
        setEmployee(emp);
        // Seed all editable form fields from the DB record
        setPhone(emp.phone              ?? "");
        setAddress(emp.address          ?? "");
        setEmergency(emp.emergencyContact ?? "");
        setBlood(emp.bloodGroup         ?? "");
        setPhotoUrl(emp.photoUrl        ?? null);   // form field
        setPhotoPreview(emp.photoUrl    ?? null);   // preview img src
      })
      .catch((err) => {
        console.error("[ProfileClient] fetch error:", err instanceof Error ? err.message : err);
        setNotLinked(true);
      })
      .finally(() => setLoading(false));
  }, [user?.id]);

  // ── Save editable fields ──────────────────────────────────────

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!employee || !isDirty) return;

    setSaving(true);
    setSaveOk(null);
    setSaveErr(null);

    const updates = {
      phone:            phone.trim()     || null,
      address:          address.trim()   || null,
      emergencyContact: emergency.trim() || null,
      bloodGroup:       blood             || null,
      photoUrl:         photoUrl,   // included — may be a new Storage URL or null
    };

    try {
      await updateEmployee(employee.id, updates);
      // Mirror the DB write into local employee state so isDirty resets to false
      setEmployee((prev) => prev ? { ...prev, ...updates } : prev);
      setSaveOk("Changes saved.");
    } catch (err) {
      setSaveErr(err instanceof Error ? err.message : "Save failed — please try again.");
    } finally {
      setSaving(false);
    }
  }

  // ── Photo upload ──────────────────────────────────────────────

  async function handlePhotoChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // reset input so the same file can be re-selected after an error
    e.target.value = "";
    if (!file || !employee) return;

    // Client-side guards
    if (!file.type.startsWith("image/")) {
      setPhotoErr("Please select an image file (JPEG, PNG, WebP, etc.).");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setPhotoErr("Image must be 5 MB or smaller.");
      return;
    }

    // Show an instant local preview using a blob URL while the file uploads
    const objectUrl = URL.createObjectURL(file);
    setPhotoPreview(objectUrl);

    setUploading(true);
    setPhotoOk(null);
    setPhotoErr(null);

    try {
      // Upload the file to Supabase Storage and get the stable public URL.
      // We do NOT write to the DB here — the URL goes into form state.
      // The DB is only updated when the user explicitly clicks Save.
      const publicUrl = await uploadEmployeePhoto(employee.id, file);

      setPhotoUrl(publicUrl);        // form field — marks isDirty = true
      setPhotoPreview(publicUrl);    // swap blob URL for the stable Storage URL
      setPhotoOk("Photo ready — click Save to apply.");
    } catch (err) {
      // Upload failed — revert the preview to whatever URL is currently in the form
      // (which may itself be a pending URL from a previous successful upload)
      setPhotoPreview(photoUrl);
      setPhotoErr(
        err instanceof Error
          ? err.message.replace("[uploadEmployeePhoto] ", "")
          : "Upload failed — please try again.",
      );
    } finally {
      setUploading(false);
    }
  }

  // ── Render: loading ───────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Spinner className="w-5 h-5 text-amber-400" />
        <span className="ml-2 text-[13px] text-slate-400">Loading profile…</span>
      </div>
    );
  }

  // ── Render: not linked ────────────────────────────────────────

  if (notLinked || !employee) {
    return (
      <div className="max-w-md mx-auto mt-20 px-6">
        <div className="bg-amber-50 border border-amber-200 rounded-2xl p-8 text-center">
          <div className="w-12 h-12 rounded-full bg-amber-100 flex items-center justify-center mx-auto mb-4">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"
              strokeLinecap="round" strokeLinejoin="round" className="w-6 h-6 text-amber-500">
              <circle cx="12" cy="12" r="10" />
              <path d="M12 8v4M12 16h.01" />
            </svg>
          </div>
          <h2 className="text-[15px] font-semibold text-slate-800 mb-2">
            Profile not linked yet
          </h2>
          <p className="text-[13px] text-slate-500 leading-relaxed">
            Your login account hasn&apos;t been linked to an employee record.
            Please ask an admin to add or link your account in the{" "}
            <span className="font-medium text-slate-700">Employee Management</span> section.
          </p>
        </div>
      </div>
    );
  }

  // ── Render: profile ───────────────────────────────────────────

  const initials = employee.fullName
    .split(" ")
    .slice(0, 2)
    .map((n) => n[0] ?? "")
    .join("")
    .toUpperCase();

  // ── Layout note ────────────────────────────────────────────────
  // The outer div is "flex flex-col min-h-full" so it fills the
  // height of the <main> scroll container in AppShell.
  //
  // The content area (flex-1) grows and scrolls freely.
  // The action footer (sticky bottom-0) is OUTSIDE the scrollable
  // content — it always stays visible at the bottom of the viewport
  // regardless of how tall the content is.  This prevents the Save
  // button from being pushed off-screen after a photo upload.
  //
  // The form uses id="profile-form" so the submit <button> in the
  // sticky footer can reference it via form="profile-form" even
  // though the button lives outside the <form> element.

  return (
    <div className="flex flex-col min-h-full">

      {/* ── Scrollable content region ──────────────────────────── */}
      {/* pb-4 gives a small gap above the sticky footer */}
      <div className="flex-1 max-w-2xl mx-auto w-full px-6 pt-8 pb-4 space-y-6">

      {/* ── Page header ────────────────────────────────────────── */}
      <div>
        <h1 className="text-[22px] font-bold text-slate-900 leading-tight">My Profile</h1>
        <p className="text-[13px] text-slate-500 mt-0.5">
          View your employee record and update your personal details.
        </p>
      </div>

      {/* ── Hero card: avatar + name + badges ──────────────────── */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6">
        <div className="flex items-start gap-5">

          {/* ── Avatar with upload overlay ─────────────────────── */}
          <div className="relative flex-shrink-0">
            <div className="w-[72px] h-[72px] rounded-full overflow-hidden bg-slate-100
              border-2 border-slate-200 flex items-center justify-center select-none">
              {photoPreview ? (
                <img
                  src={photoPreview}
                  alt={employee.fullName}
                  className="w-full h-full object-cover"
                />
              ) : (
                <span className="text-xl font-bold text-slate-400 leading-none">
                  {initials}
                </span>
              )}
            </div>

            {/* Amber camera button */}
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
              title="Change profile photo"
              className="absolute -bottom-1 -right-1 w-7 h-7 rounded-full bg-amber-500
                hover:bg-amber-600 border-2 border-white flex items-center justify-center
                transition-colors shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {uploading ? (
                <Spinner className="w-3 h-3 text-white" />
              ) : (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                  strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5 text-white">
                  <path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/>
                  <circle cx="12" cy="13" r="4"/>
                </svg>
              )}
            </button>

            {/* Hidden file input */}
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handlePhotoChange}
            />
          </div>

          {/* ── Name / role / status ───────────────────────────── */}
          <div className="flex-1 min-w-0 pt-0.5">
            <h2 className="text-[17px] font-bold text-slate-900 leading-tight truncate">
              {employee.fullName}
            </h2>
            <p className="text-[13px] text-slate-500 mt-0.5">{employee.designation}</p>

            <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
              {/* Employee ID */}
              <span className="inline-flex items-center px-2 py-0.5 rounded-full
                text-[11px] font-semibold bg-slate-100 text-slate-500 font-mono tracking-wide">
                {employee.employeeId}
              </span>
              {/* App role */}
              {employee.appRole && (
                <span className={`inline-flex items-center px-2 py-0.5 rounded-full
                  text-[11px] font-semibold
                  ${employee.appRole === "admin"
                    ? "bg-amber-100 text-amber-700"
                    : "bg-blue-50 text-blue-600"
                  }`}>
                  {employee.appRole}
                </span>
              )}
              {/* Active / inactive */}
              <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full
                text-[11px] font-semibold
                ${employee.isActive
                  ? "bg-emerald-50 text-emerald-700"
                  : "bg-red-50 text-red-500"
                }`}>
                <span className={`w-1.5 h-1.5 rounded-full ${
                  employee.isActive ? "bg-emerald-500" : "bg-red-400"
                }`} />
                {employee.isActive ? "Active" : "Inactive"}
              </span>
            </div>
          </div>
        </div>

        {/* Photo feedback — shown below the avatar row */}
        {(photoOk || photoErr) && (
          <div className={`mt-4 flex items-center gap-2 rounded-lg px-3 py-2 text-[12.5px] font-medium
            ${photoOk ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-600"}`}>
            {photoOk ? (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5 flex-shrink-0">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5 flex-shrink-0">
                <circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>
              </svg>
            )}
            {photoOk ?? photoErr}
          </div>
        )}

        {/* Upload hint */}
        <p className="mt-3 text-[11.5px] text-slate-400">
          Click the camera icon to upload a new photo. Max 5 MB · JPEG, PNG, or WebP.
        </p>
      </div>

      {/* ── Read-only: admin-controlled fields ─────────────────── */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6">
        <SectionHeading>Employee Record — managed by admin</SectionHeading>

        <div className="grid grid-cols-2 gap-x-8 gap-y-5">
          <ReadOnlyField label="Full Name"    value={employee.fullName} />
          <ReadOnlyField label="Employee ID"  value={employee.employeeId} mono />
          <ReadOnlyField label="Designation"  value={employee.designation} />
          <ReadOnlyField label="App Role"     value={employee.appRole} />
          <ReadOnlyField label="Joining Date" value={formatDate(employee.joiningDate)} />
          <ReadOnlyField label="Email"        value={employee.email} />
          {/* can_access_app */}
          <div>
            <p className="text-[11px] font-medium text-slate-400 uppercase tracking-wide mb-1">
              App Access
            </p>
            <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full
              text-[11px] font-semibold
              ${employee.canAccessApp
                ? "bg-emerald-50 text-emerald-700"
                : "bg-slate-100 text-slate-500"
              }`}>
              <span className={`w-1.5 h-1.5 rounded-full ${
                employee.canAccessApp ? "bg-emerald-500" : "bg-slate-400"
              }`} />
              {employee.canAccessApp ? "Enabled" : "No access"}
            </span>
          </div>
        </div>

        <div className="mt-5 flex items-center gap-1.5 text-[12px] text-slate-400">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"
            strokeLinecap="round" className="w-3.5 h-3.5 flex-shrink-0">
            <rect x="3" y="11" width="18" height="11" rx="2"/>
            <path d="M7 11V7a5 5 0 0110 0v4"/>
          </svg>
          These fields are managed by an admin and cannot be changed here.
        </div>
      </div>

      {/* ── Editable: personal details ──────────────────────────── */}
      {/*
        No submit button here — it lives in the sticky footer below.
        The form id="profile-form" links the external button via the
        standard HTML `form` attribute.
      */}
      <form
        id="profile-form"
        onSubmit={handleSave}
        className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6"
      >
        <SectionHeading>Personal Details — you can edit these</SectionHeading>

        <div className="space-y-4">

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">

            {/* Phone */}
            <div>
              <label className="block text-[12px] font-medium text-slate-600 mb-1.5">
                Phone Number
              </label>
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+1 234 567 8900"
                className={inputCls()}
              />
            </div>

            {/* Blood Group */}
            <div>
              <label className="block text-[12px] font-medium text-slate-600 mb-1.5">
                Blood Group
              </label>
              <select
                value={blood}
                onChange={(e) => setBlood(e.target.value)}
                className={inputCls()}
              >
                <option value="">— Select —</option>
                {BLOOD_GROUPS.map((g) => (
                  <option key={g} value={g}>{g}</option>
                ))}
              </select>
            </div>

            {/* Emergency Contact */}
            <div className="sm:col-span-2">
              <label className="block text-[12px] font-medium text-slate-600 mb-1.5">
                Emergency Contact
              </label>
              <input
                type="text"
                value={emergency}
                onChange={(e) => setEmergency(e.target.value)}
                placeholder="Name and phone number"
                className={inputCls()}
              />
            </div>

          </div>

          {/* Address */}
          <div>
            <label className="block text-[12px] font-medium text-slate-600 mb-1.5">
              Home Address
            </label>
            <textarea
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              rows={3}
              placeholder="Your home address"
              className={inputCls() + " resize-none"}
            />
          </div>

        </div>
      </form>

      </div>{/* end scrollable content */}

      {/* ── Sticky action footer ────────────────────────────────── */}
      {/*
        sticky bottom-0 keeps this bar pinned to the bottom of the
        <main> viewport regardless of how much content is above it.
        The save button references the form above via form="profile-form".

        Visible states:
          • isDirty=true  → amber Save button, "Unsaved changes" hint
          • isDirty=false → grey Save button ("Nothing to save" label)
          • saving=true   → spinner + "Saving…"
          • saveOk/Err    → inline feedback replaces the hint text
      */}
      <div className="sticky bottom-0 z-10 bg-white border-t border-slate-200
        shadow-[0_-1px_6px_rgba(0,0,0,0.06)]">
        <div className="max-w-2xl mx-auto px-6 py-3 flex items-center justify-between gap-4">

          {/* Left: status text */}
          <div className="flex-1 min-w-0 text-[12.5px]">
            {saveOk && (
              <span className="flex items-center gap-1.5 font-medium text-emerald-600">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
                  strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5 flex-shrink-0">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
                {saveOk}
              </span>
            )}
            {saveErr && (
              <span className="flex items-center gap-1.5 font-medium text-red-500">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
                  strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5 flex-shrink-0">
                  <circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>
                </svg>
                {saveErr}
              </span>
            )}
            {!saveOk && !saveErr && isDirty && (
              <span className="text-slate-400">You have unsaved changes.</span>
            )}
            {!saveOk && !saveErr && !isDirty && (
              <span className="text-slate-300 select-none">No unsaved changes.</span>
            )}
          </div>

          {/* Right: Save button — always rendered, disabled when nothing to save */}
          <button
            type="submit"
            form="profile-form"
            disabled={saving || !isDirty}
            className="flex-shrink-0 flex items-center gap-2 px-5 py-2 rounded-lg
              text-[13px] font-semibold transition-all shadow-sm
              bg-amber-500 text-white
              hover:bg-amber-600
              disabled:bg-slate-200 disabled:text-slate-400 disabled:shadow-none
              disabled:cursor-not-allowed"
          >
            {saving && <Spinner className="w-3.5 h-3.5" />}
            {saving ? "Saving…" : "Save Changes"}
          </button>

        </div>
      </div>

    </div>
  );
}

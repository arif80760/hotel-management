"use client";

// app/profile/ProfileClient.tsx
//
// Staff Self Profile — lets any logged-in employee:
//   • View their own record (read-only admin-controlled fields)
//   • Edit their personal details (phone, address, emergency contact, blood group)
//   • Upload / change their profile photo
//
// The page fetches the employee record whose auth_user_id matches the
// logged-in Supabase auth user ID.  If no linked record exists (the admin
// hasn't linked the account yet) a clear "not linked" message is shown.

import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import {
  getEmployeeByAuthUserId,
  updateEmployee,
  uploadEmployeePhoto,
  BLOOD_GROUPS,
  type Employee,
} from "@/services/employeesService";

// ─── small UI helpers ─────────────────────────────────────────

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[11px] font-semibold uppercase tracking-widest text-slate-400 mb-3">
      {children}
    </h3>
  );
}

function ReadOnlyField({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <p className="text-[11px] font-medium text-slate-400 uppercase tracking-wide mb-0.5">
        {label}
      </p>
      <p className="text-[14px] text-slate-800 font-medium">
        {value || <span className="text-slate-400 font-normal italic">—</span>}
      </p>
    </div>
  );
}

const inputCls =
  "w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-[13.5px] text-slate-800 " +
  "placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-amber-400/60 focus:border-amber-400 " +
  "transition-colors";

// ─── format joining date ──────────────────────────────────────

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  const months = [
    "Jan","Feb","Mar","Apr","May","Jun",
    "Jul","Aug","Sep","Oct","Nov","Dec",
  ];
  return `${parseInt(d)} ${months[parseInt(m) - 1]} ${y}`;
}

// ─── component ───────────────────────────────────────────────

export default function ProfileClient() {
  const { user } = useAuth();

  const [employee, setEmployee] = useState<Employee | null>(null);
  const [loading,  setLoading]  = useState(true);
  const [notLinked, setNotLinked] = useState(false);

  // editable fields
  const [phone,    setPhone]    = useState("");
  const [address,  setAddress]  = useState("");
  const [emergency, setEmergency] = useState("");
  const [blood,    setBlood]    = useState("");

  // save state
  const [saving,   setSaving]   = useState(false);
  const [saveMsg,  setSaveMsg]  = useState<string | null>(null);

  // photo upload
  const fileRef = useRef<HTMLInputElement>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [photoMsg, setPhotoMsg] = useState<string | null>(null);

  // ── fetch employee record ─────────────────────────────────

  useEffect(() => {
    if (!user?.id) return;

    setLoading(true);
    getEmployeeByAuthUserId(user.id)
      .then((emp) => {
        if (!emp) {
          setNotLinked(true);
        } else {
          setEmployee(emp);
          setPhone(emp.phone ?? "");
          setAddress(emp.address ?? "");
          setEmergency(emp.emergencyContact ?? "");
          setBlood(emp.bloodGroup ?? "");
          setPhotoPreview(emp.photoUrl ?? null);
        }
      })
      .catch((err) => {
        console.error("[ProfileClient] fetch error:", err instanceof Error ? err.message : err);
        setNotLinked(true);
      })
      .finally(() => setLoading(false));
  }, [user?.id]);

  // ── save editable fields ──────────────────────────────────

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!employee) return;

    setSaving(true);
    setSaveMsg(null);

    try {
      await updateEmployee(employee.id, {
        phone:            phone.trim()     || null,
        address:          address.trim()   || null,
        emergencyContact: emergency.trim() || null,
        bloodGroup:       blood             || null,
      });

      // update local state
      setEmployee((prev) =>
        prev
          ? {
              ...prev,
              phone:            phone.trim()     || null,
              address:          address.trim()   || null,
              emergencyContact: emergency.trim() || null,
              bloodGroup:       blood             || null,
            }
          : prev,
      );

      setSaveMsg("Changes saved successfully.");
    } catch (err) {
      setSaveMsg(
        "Failed to save: " + (err instanceof Error ? err.message : String(err)),
      );
    } finally {
      setSaving(false);
    }
  }

  // ── photo upload ──────────────────────────────────────────

  async function handlePhotoChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !employee) return;

    // local preview immediately
    const objectUrl = URL.createObjectURL(file);
    setPhotoPreview(objectUrl);

    setUploadingPhoto(true);
    setPhotoMsg(null);

    try {
      const publicUrl = await uploadEmployeePhoto(employee.id, file);
      await updateEmployee(employee.id, { photoUrl: publicUrl });
      setEmployee((prev) => (prev ? { ...prev, photoUrl: publicUrl } : prev));
      setPhotoPreview(publicUrl);
      setPhotoMsg("Photo updated successfully.");
    } catch (err) {
      setPhotoMsg(
        "Photo upload failed: " + (err instanceof Error ? err.message : String(err)),
      );
    } finally {
      setUploadingPhoto(false);
    }
  }

  // ── render ────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-slate-400 text-sm">
        Loading profile…
      </div>
    );
  }

  if (notLinked || !employee) {
    return (
      <div className="max-w-lg mx-auto mt-20 px-6">
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-6 text-center">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"
            strokeLinecap="round" strokeLinejoin="round"
            className="w-10 h-10 text-amber-400 mx-auto mb-3">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 8v4" />
            <path d="M12 16h.01" />
          </svg>
          <h2 className="text-[15px] font-semibold text-slate-800 mb-1">
            Profile not linked yet
          </h2>
          <p className="text-[13px] text-slate-500 leading-relaxed">
            Your login account hasn&apos;t been linked to an employee record.
            Please ask an admin to link your account in the Employee Management section.
          </p>
        </div>
      </div>
    );
  }

  const initials = employee.fullName
    .split(" ")
    .slice(0, 2)
    .map((n) => n[0])
    .join("")
    .toUpperCase();

  return (
    <div className="max-w-2xl mx-auto px-6 py-8 space-y-8">

      {/* ── Page title ─────────────────────────────────────── */}
      <div>
        <h1 className="text-[22px] font-bold text-slate-900">My Profile</h1>
        <p className="text-[13px] text-slate-500 mt-0.5">
          View your employee record and update personal details.
        </p>
      </div>

      {/* ── Photo + identity card ───────────────────────────── */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 flex items-start gap-5">

        {/* Avatar / photo */}
        <div className="relative flex-shrink-0">
          <div className="w-20 h-20 rounded-full overflow-hidden bg-slate-100 border border-slate-200 flex items-center justify-center">
            {photoPreview ? (
              <img
                src={photoPreview}
                alt={employee.fullName}
                className="w-full h-full object-cover"
              />
            ) : (
              <span className="text-2xl font-bold text-slate-400">{initials}</span>
            )}
          </div>

          {/* Upload button overlay */}
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={uploadingPhoto}
            className="absolute -bottom-1 -right-1 w-7 h-7 rounded-full bg-amber-500 hover:bg-amber-600
              border-2 border-white flex items-center justify-center transition-colors shadow-sm
              disabled:opacity-60"
            title="Change photo"
          >
            {uploadingPhoto ? (
              <svg className="w-3.5 h-3.5 text-white animate-spin" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3"
                  strokeDasharray="31.4" strokeDashoffset="10" strokeLinecap="round" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5 text-white">
                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
            )}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handlePhotoChange}
          />
        </div>

        {/* Identity */}
        <div className="flex-1 min-w-0">
          <h2 className="text-[18px] font-bold text-slate-900 truncate">{employee.fullName}</h2>
          <p className="text-[13px] text-slate-500 mt-0.5">{employee.designation}</p>
          <div className="mt-2 flex items-center gap-2 flex-wrap">
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold
              bg-slate-100 text-slate-600">
              {employee.employeeId}
            </span>
            {employee.appRole && (
              <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold
                ${employee.appRole === "admin"
                  ? "bg-amber-100 text-amber-700"
                  : "bg-blue-50 text-blue-700"
                }`}>
                {employee.appRole}
              </span>
            )}
            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold
              ${employee.isActive
                ? "bg-emerald-50 text-emerald-700"
                : "bg-red-50 text-red-600"
              }`}>
              {employee.isActive ? "Active" : "Inactive"}
            </span>
          </div>
          {photoMsg && (
            <p className={`mt-2 text-[12px] font-medium ${
              photoMsg.startsWith("Photo updated") ? "text-emerald-600" : "text-red-500"
            }`}>
              {photoMsg}
            </p>
          )}
        </div>
      </div>

      {/* ── Read-only admin fields ─────────────────────────── */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6">
        <SectionHeading>Employee Record (Admin-controlled)</SectionHeading>
        <div className="grid grid-cols-2 gap-x-8 gap-y-5">
          <ReadOnlyField label="Full Name"     value={employee.fullName} />
          <ReadOnlyField label="Employee ID"   value={employee.employeeId} />
          <ReadOnlyField label="Designation"   value={employee.designation} />
          <ReadOnlyField label="App Role"      value={employee.appRole} />
          <ReadOnlyField label="Joining Date"  value={formatDate(employee.joiningDate)} />
          <ReadOnlyField label="Email"         value={employee.email} />
        </div>
        <p className="mt-4 text-[12px] text-slate-400 flex items-center gap-1.5">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"
            strokeLinecap="round" className="w-3.5 h-3.5 flex-shrink-0">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
            <path d="M7 11V7a5 5 0 0110 0v4" />
          </svg>
          These fields are managed by an admin and cannot be changed here.
        </p>
      </div>

      {/* ── Editable personal fields ─────────────────────────── */}
      <form onSubmit={handleSave} className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 space-y-5">
        <SectionHeading>Personal Details (You can edit these)</SectionHeading>

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
              className={inputCls}
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
              className={inputCls}
            >
              <option value="">— Select —</option>
              {BLOOD_GROUPS.map((g) => (
                <option key={g} value={g}>{g}</option>
              ))}
            </select>
          </div>

          {/* Emergency Contact */}
          <div>
            <label className="block text-[12px] font-medium text-slate-600 mb-1.5">
              Emergency Contact
            </label>
            <input
              type="text"
              value={emergency}
              onChange={(e) => setEmergency(e.target.value)}
              placeholder="Name + phone number"
              className={inputCls}
            />
          </div>

        </div>

        {/* Address — full width */}
        <div>
          <label className="block text-[12px] font-medium text-slate-600 mb-1.5">
            Address
          </label>
          <textarea
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            rows={3}
            placeholder="Your home address"
            className={inputCls + " resize-none"}
          />
        </div>

        {/* Save row */}
        <div className="flex items-center justify-between pt-1">
          {saveMsg ? (
            <p className={`text-[12.5px] font-medium ${
              saveMsg.startsWith("Changes saved") ? "text-emerald-600" : "text-red-500"
            }`}>
              {saveMsg}
            </p>
          ) : (
            <span />
          )}
          <button
            type="submit"
            disabled={saving}
            className="px-5 py-2 rounded-lg bg-amber-500 hover:bg-amber-600 text-white text-[13px]
              font-semibold transition-colors shadow-sm disabled:opacity-60 flex items-center gap-2"
          >
            {saving && (
              <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3"
                  strokeDasharray="31.4" strokeDashoffset="10" strokeLinecap="round" />
              </svg>
            )}
            {saving ? "Saving…" : "Save Changes"}
          </button>
        </div>
      </form>

    </div>
  );
}

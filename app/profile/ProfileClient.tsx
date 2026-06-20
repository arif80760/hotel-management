"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/contexts/AuthContext";

type EmployeeRow = {
  id: string; employee_id: string | null; designation: string | null;
  email: string | null; phone: string | null; photo_url: string | null;
};
type Msg = { type: "success" | "error"; text: string } | null;

function initials(name: string): string {
  const t = name.trim();
  if (!t) return "·";
  return t.split(/\s+/).slice(0, 2).map(n => n[0]?.toUpperCase() ?? "").join("") || "·";
}

export default function ProfileClient() {
  const { user, loading: authLoading } = useAuth();

  const [loading, setLoading]       = useState(true);
  const [role, setRole]             = useState("");
  const [fullName, setFullName]     = useState("");
  const [avatarPath, setAvatarPath] = useState<string | null>(null);
  const [employee, setEmployee]     = useState<EmployeeRow | null>(null);
  const [phone, setPhone]           = useState("");

  const [savingProfile, setSavingProfile] = useState(false);
  const [profileMsg, setProfileMsg]       = useState<Msg>(null);
  const [uploading, setUploading]         = useState(false);
  const [avatarMsg, setAvatarMsg]         = useState<Msg>(null);
  const [newPw, setNewPw]                 = useState("");
  const [confirmPw, setConfirmPw]         = useState("");
  const [savingPw, setSavingPw]           = useState(false);
  const [pwMsg, setPwMsg]                 = useState<Msg>(null);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      const [{ data: prof }, { data: emp }] = await Promise.all([
        supabase.from("profiles").select("full_name, role, avatar_url").eq("id", user.id).single(),
        supabase.from("employees").select("id, employee_id, designation, email, phone, photo_url").eq("auth_user_id", user.id).maybeSingle(),
      ]);
      if (cancelled) return;
      if (prof) { setFullName(prof.full_name ?? ""); setRole(prof.role ?? ""); setAvatarPath(prof.avatar_url ?? null); }
      if (emp)  { setEmployee(emp as EmployeeRow); setPhone((emp as EmployeeRow).phone ?? ""); }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [user?.id]);

  const avatarUrl = avatarPath
    ? supabase.storage.from("avatars").getPublicUrl(avatarPath).data.publicUrl
    : null;

  async function onAvatarChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !user) return;
    if (!file.type.startsWith("image/")) { setAvatarMsg({ type: "error", text: "Please choose an image file." }); return; }
    if (file.size > 5 * 1024 * 1024)     { setAvatarMsg({ type: "error", text: "Image must be under 5 MB." }); return; }
    setUploading(true); setAvatarMsg(null);
    try {
      const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
      const path = `${user.id}/${Date.now()}.${ext}`;
      const { error: upErr } = await supabase.storage.from("avatars").upload(path, file, { cacheControl: "3600", upsert: true });
      if (upErr) throw upErr;
      const { error: updErr } = await supabase.from("profiles").update({ avatar_url: path }).eq("id", user.id);
      if (updErr) throw updErr;
      if (avatarPath && avatarPath !== path) supabase.storage.from("avatars").remove([avatarPath]).catch(() => {});
      setAvatarPath(path);
      setAvatarMsg({ type: "success", text: "Photo updated." });
    } catch (err) {
      setAvatarMsg({ type: "error", text: (err as Error).message || "Upload failed." });
    } finally { setUploading(false); }
  }

  async function saveProfile() {
    if (!user) return;
    const name = fullName.trim();
    if (!name) { setProfileMsg({ type: "error", text: "Name can't be empty." }); return; }
    setSavingProfile(true); setProfileMsg(null);
    try {
      const { error: pErr } = await supabase.from("profiles").update({ full_name: name }).eq("id", user.id);
      if (pErr) throw pErr;
      if (employee) {
        const { error: eErr } = await supabase.from("employees")
          .update({ full_name: name, phone: phone.trim() || null }).eq("auth_user_id", user.id);
        if (eErr) throw eErr;
      }
      setProfileMsg({ type: "success", text: "Profile saved." });
    } catch (err) {
      setProfileMsg({ type: "error", text: (err as Error).message || "Save failed." });
    } finally { setSavingProfile(false); }
  }

  async function updatePassword() {
    setPwMsg(null);
    if (newPw.length < 6)    { setPwMsg({ type: "error", text: "Password must be at least 6 characters." }); return; }
    if (newPw !== confirmPw) { setPwMsg({ type: "error", text: "Passwords don't match." }); return; }
    setSavingPw(true);
    try {
      const { error } = await supabase.auth.updateUser({ password: newPw });
      if (error) throw error;
      setNewPw(""); setConfirmPw("");
      setPwMsg({ type: "success", text: "Password updated." });
    } catch (err) {
      setPwMsg({ type: "error", text: (err as Error).message || "Could not update password." });
    } finally { setSavingPw(false); }
  }

  if (authLoading || (loading && user)) {
    return (
      <div className="max-w-2xl mx-auto px-4 sm:px-6 py-6 space-y-3">
        <div className="h-8 w-40 rounded bg-slate-100 animate-pulse" />
        <div className="h-44 rounded-2xl bg-slate-100 animate-pulse" />
        <div className="h-32 rounded-2xl bg-slate-100 animate-pulse" />
      </div>
    );
  }
  if (!user) return <div className="max-w-2xl mx-auto px-4 py-10 text-[13px] text-slate-500">You&apos;re not signed in.</div>;

  const cardCls  = "rounded-2xl bg-white ring-1 ring-slate-200 p-5";
  const labelCls = "block text-[12px] font-medium text-slate-500 mb-1";
  const inputCls = "w-full px-3 py-2 rounded-lg text-[13.5px] text-slate-800 bg-white ring-1 ring-slate-200 focus:outline-none focus:ring-2 focus:ring-amber-400";
  const msgCls   = (m: Msg) => `text-[12.5px] ${m?.type === "success" ? "text-emerald-600" : "text-rose-600"}`;

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-6">
      <h1 className="text-xl font-semibold text-slate-900 mb-5">My Profile</h1>

      <section className={`${cardCls} mb-4`}>
        <div className="flex items-center gap-4 mb-5">
          <div className="relative">
            <div className="w-20 h-20 rounded-full overflow-hidden bg-slate-100 ring-1 ring-slate-200 flex items-center justify-center">
              {avatarUrl ? <img src={avatarUrl} alt="" className="w-full h-full object-cover" /> : <span className="text-xl font-bold text-slate-400">{initials(fullName)}</span>}
            </div>
            <label className="absolute -bottom-1 -right-1 w-7 h-7 rounded-full bg-slate-900 text-white flex items-center justify-center cursor-pointer ring-2 ring-white hover:bg-slate-700 transition-colors" title="Change photo">
              {uploading ? (
                <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" strokeOpacity="0.25" /><path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" /></svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" /><circle cx="12" cy="13" r="4" /></svg>
              )}
              <input type="file" accept="image/*" className="hidden" onChange={onAvatarChange} disabled={uploading} />
            </label>
          </div>
          <div className="min-w-0">
            <p className="text-[16px] font-semibold text-slate-900 truncate">{fullName || "—"}</p>
            <div className="flex items-center gap-2 mt-1">
              <span className="text-[11px] font-medium text-amber-700 bg-amber-50 ring-1 ring-amber-200 rounded-full px-2 py-0.5 capitalize">{role || "—"}</span>
              {employee?.designation && <span className="text-[11px] font-medium text-slate-600 bg-slate-100 ring-1 ring-slate-200 rounded-full px-2 py-0.5">{employee.designation}</span>}
            </div>
          </div>
        </div>
        {avatarMsg && <p className={`${msgCls(avatarMsg)} -mt-3 mb-3`}>{avatarMsg.text}</p>}

        <div className="space-y-3">
          <div><label className={labelCls}>Full name</label><input className={inputCls} value={fullName} onChange={e => setFullName(e.target.value)} /></div>
          {employee && <div><label className={labelCls}>Phone</label><input className={inputCls} value={phone} onChange={e => setPhone(e.target.value)} placeholder="e.g. 01XXXXXXXXX" /></div>}
        </div>

        <div className="flex items-center gap-3 mt-4">
          <button onClick={saveProfile} disabled={savingProfile} className="px-4 py-2 rounded-lg text-[13px] font-medium text-white bg-slate-900 hover:bg-slate-700 disabled:opacity-60">{savingProfile ? "Saving…" : "Save changes"}</button>
          {profileMsg && <span className={msgCls(profileMsg)}>{profileMsg.text}</span>}
        </div>
      </section>

      <section className={`${cardCls} mb-4`}>
        <h2 className="text-[13px] font-semibold text-slate-900 mb-3">Account details</h2>
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
          <Detail label="Login email" value={user.email ?? "—"} />
          <Detail label="Role" value={role} capitalize />
          {employee && <Detail label="Employee ID" value={employee.employee_id ?? "—"} />}
          {employee && <Detail label="Designation" value={employee.designation ?? "—"} />}
          {employee && <Detail label="Contact email" value={employee.email ?? "—"} />}
        </dl>
        <p className="text-[11.5px] text-slate-400 mt-3">Your role, designation and login email are managed by an administrator.</p>
      </section>

      <section className={cardCls}>
        <h2 className="text-[13px] font-semibold text-slate-900 mb-3">Change password</h2>
        <div className="space-y-3 max-w-sm">
          <div><label className={labelCls}>New password</label><input type="password" className={inputCls} value={newPw} onChange={e => setNewPw(e.target.value)} autoComplete="new-password" /></div>
          <div><label className={labelCls}>Confirm new password</label><input type="password" className={inputCls} value={confirmPw} onChange={e => setConfirmPw(e.target.value)} autoComplete="new-password" /></div>
        </div>
        <div className="flex items-center gap-3 mt-4">
          <button onClick={updatePassword} disabled={savingPw} className="px-4 py-2 rounded-lg text-[13px] font-medium text-white bg-slate-900 hover:bg-slate-700 disabled:opacity-60">{savingPw ? "Updating…" : "Update password"}</button>
          {pwMsg && <span className={msgCls(pwMsg)}>{pwMsg.text}</span>}
        </div>
      </section>
    </div>
  );
}

function Detail({ label, value, capitalize }: { label: string; value: string; capitalize?: boolean }) {
  return (
    <div>
      <dt className="text-[12px] font-medium text-slate-500">{label}</dt>
      <dd className={`text-[13.5px] text-slate-800 mt-0.5 ${capitalize ? "capitalize" : ""}`}>{value || "—"}</dd>
    </div>
  );
}

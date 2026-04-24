"use client";

// app/login/page.tsx
//
// Standalone login page — rendered without Sidebar or TopBar.
// AppShell skips the shell layout when pathname === "/login".
//
// On successful sign-in, AppShell's routing guard detects the
// newly-set user and calls router.replace("/") automatically.
// This page never needs to call router.push() itself.

import { useState } from "react";
import { useAuth } from "@/contexts/AuthContext";

export default function LoginPage() {
  const { signIn } = useAuth();

  const [email,    setEmail]    = useState("");
  const [password, setPassword] = useState("");
  const [error,    setError]    = useState<string | null>(null);
  const [loading,  setLoading]  = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim() || !password) return;

    setError(null);
    setLoading(true);

    const { error: authError } = await signIn(email.trim(), password);

    if (authError) {
      setError(authError);
      setLoading(false);
      // On success: AuthContext sets user → AppShell guard redirects to "/"
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
      <div className="w-full max-w-sm">

        {/* ── Brand mark ─────────────────────────────────────── */}
        <div className="flex items-center justify-center gap-3 mb-8">
          <div className="w-10 h-10 rounded-xl bg-amber-500 flex items-center justify-center flex-shrink-0">
            <span className="text-slate-900 font-bold text-sm tracking-tight">HA</span>
          </div>
          <div>
            <p className="text-[15px] font-semibold leading-tight text-slate-900">
              Hotel Albatross
            </p>
            <p className="text-[11px] text-amber-600 font-medium tracking-widest uppercase leading-tight">
              Resort
            </p>
          </div>
        </div>

        {/* ── Login card ─────────────────────────────────────── */}
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-8">
          <h1 className="text-[20px] font-semibold text-slate-900 mb-1">
            Welcome back
          </h1>
          <p className="text-[13px] text-slate-400 mb-6">
            Sign in to the management system
          </p>

          <form onSubmit={handleSubmit} noValidate className="space-y-4">

            {/* Email */}
            <div>
              <label className="block text-[12px] font-semibold text-slate-600 mb-1.5 uppercase tracking-wide">
                Email
              </label>
              <input
                type="email"
                autoComplete="email"
                placeholder="you@hotel.com"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
                className="w-full px-3.5 py-2.5 text-[13.5px] text-slate-800 bg-white border border-slate-200 rounded-lg
                  placeholder:text-slate-300 focus:outline-none focus:ring-2 focus:ring-amber-400
                  focus:border-transparent transition"
              />
            </div>

            {/* Password */}
            <div>
              <label className="block text-[12px] font-semibold text-slate-600 mb-1.5 uppercase tracking-wide">
                Password
              </label>
              <input
                type="password"
                autoComplete="current-password"
                placeholder="••••••••"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
                className="w-full px-3.5 py-2.5 text-[13.5px] text-slate-800 bg-white border border-slate-200 rounded-lg
                  placeholder:text-slate-300 focus:outline-none focus:ring-2 focus:ring-amber-400
                  focus:border-transparent transition"
              />
            </div>

            {/* Error message */}
            {error && (
              <div className="flex items-start gap-2.5 bg-rose-50 border border-rose-200 rounded-lg px-4 py-3">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  className="w-4 h-4 text-rose-500 flex-shrink-0 mt-0.5"
                >
                  <circle cx="12" cy="12" r="10" />
                  <path d="M12 8v4M12 16h.01" />
                </svg>
                <p className="text-[12.5px] text-rose-700 leading-relaxed">{error}</p>
              </div>
            )}

            {/* Submit */}
            <button
              type="submit"
              disabled={loading || !email.trim() || !password}
              className="w-full flex items-center justify-center gap-2 mt-2
                bg-slate-900 hover:bg-slate-800 disabled:bg-slate-300 disabled:cursor-not-allowed
                text-white text-[13.5px] font-semibold px-4 py-2.5 rounded-lg
                transition-colors shadow-sm"
            >
              {loading ? (
                <>
                  <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  Signing in…
                </>
              ) : (
                "Sign in"
              )}
            </button>

          </form>
        </div>

        {/* Footer note */}
        <p className="text-center text-[11.5px] text-slate-400 mt-6">
          Contact your administrator to get access.
        </p>

      </div>
    </div>
  );
}

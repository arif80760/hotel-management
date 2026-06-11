"use client";

// app/login/page.tsx
//
// Hotel Albatross Login Page with branded logo
// Light blue theme that matches the logo colors
// 
// On successful sign-in, AppShell's routing guard detects the
// newly-set user and calls router.replace("/") automatically.

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
    }
  }

  return (
    <div className="min-h-screen w-full bg-gradient-to-br from-slate-50 via-blue-50 to-slate-50 flex items-center justify-center p-4 relative overflow-hidden">
      
      {/* Decorative gradient orbs */}
      <div className="absolute top-0 left-0 w-96 h-96 bg-blue-200/20 rounded-full blur-3xl -translate-x-1/2 -translate-y-1/2" />
      <div className="absolute bottom-0 right-0 w-80 h-80 bg-blue-300/15 rounded-full blur-3xl translate-x-1/3 translate-y-1/3" />

      {/* Content container — centered both ways */}
      <div className="w-full max-w-md relative z-10 flex flex-col items-center justify-center min-h-screen py-12">

        {/* ── Brand section ──────────────────────────────────── */}
        <div className="text-center mb-8">
          {/* Logo image */}
          <div className="flex justify-center mb-6">
            <img 
              src="/logo.png" 
              alt="Hotel Albatross Logo" 
              className="h-20 w-auto object-contain"
            />
          </div>

          {/* Hotel name */}
          <h1 className="text-4xl font-black text-slate-900 mb-2 tracking-tight">
            Hotel Albatross
          </h1>
          <p className="text-blue-600 text-sm font-semibold tracking-widest uppercase">
            Resort Management
          </p>

          {/* Tagline */}
          <p className="text-slate-600 text-sm mt-4 max-w-xs mx-auto">
            Cox's Bazar's Premier Hospitality Management System
          </p>
        </div>

        {/* ── Login card ─────────────────────────────────────── */}
        <div className="bg-white/80 backdrop-blur-xl border border-blue-100 rounded-2xl shadow-2xl p-8 mb-6">
          
          {/* Card header */}
          <div className="mb-6">
            <h2 className="text-2xl font-bold text-slate-900 mb-2">Welcome back</h2>
            <p className="text-slate-600 text-sm">
              Sign in to access the management system
            </p>
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit} noValidate className="space-y-5">

            {/* Email field */}
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-2 uppercase tracking-wider">
                Email Address
              </label>
              <input
                type="email"
                autoComplete="email"
                placeholder="you@hotel.com"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
                className="w-full px-4 py-3 text-sm text-slate-900 bg-slate-50 border border-blue-200 rounded-lg
                  placeholder:text-slate-400 
                  focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-0 focus:border-transparent
                  hover:bg-slate-100 transition-all duration-200"
              />
            </div>

            {/* Password field */}
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-2 uppercase tracking-wider">
                Password
              </label>
              <input
                type="password"
                autoComplete="current-password"
                placeholder="••••••••"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
                className="w-full px-4 py-3 text-sm text-slate-900 bg-slate-50 border border-blue-200 rounded-lg
                  placeholder:text-slate-400
                  focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-0 focus:border-transparent
                  hover:bg-slate-100 transition-all duration-200"
              />
            </div>

            {/* Error message */}
            {error && (
              <div className="flex items-start gap-3 bg-rose-50 border border-rose-200 rounded-lg px-4 py-3.5">
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
                <p className="text-xs text-rose-700 leading-relaxed font-medium">{error}</p>
              </div>
            )}

            {/* Submit button */}
            <button
              type="submit"
              disabled={loading || !email.trim() || !password}
              className="w-full flex items-center justify-center gap-2 mt-6
                bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-600 hover:to-blue-700
                disabled:from-slate-400 disabled:to-slate-500 disabled:cursor-not-allowed
                text-white text-sm font-bold px-4 py-3 rounded-lg
                transition-all duration-200 shadow-lg hover:shadow-xl hover:scale-105
                disabled:scale-100 disabled:shadow-md"
            >
              {loading ? (
                <>
                  <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  Signing in…
                </>
              ) : (
                <>
                  Sign in to Dashboard
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-4 h-4">
                    <path d="M5 12h14M12 5l7 7-7 7" />
                  </svg>
                </>
              )}
            </button>

          </form>

          {/* Divider */}
          <div className="flex items-center gap-3 my-6">
            <div className="flex-1 h-px bg-slate-200" />
            <span className="text-xs text-slate-500">OR</span>
            <div className="flex-1 h-px bg-slate-200" />
          </div>

          {/* Help text */}
          <p className="text-center text-xs text-slate-600">
            Don't have access?{" "}
            <span className="text-blue-600 font-semibold">
              Contact your administrator
            </span>
          </p>
        </div>

        {/* ── Footer ─────────────────────────────────────────── */}
        <div className="text-center">
          <p className="text-xs text-slate-500">
            © {new Date().getFullYear()} Hotel Albatross Resort. All rights reserved.
          </p>
          <p className="text-xs text-slate-600 mt-2">
            Cox's Bazar, Bangladesh
          </p>
        </div>

      </div>
    </div>
  );
}

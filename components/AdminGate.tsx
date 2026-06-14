"use client";

// components/AdminGate.tsx
//
// ─── ADMIN ROLE GATE (client-side) ───────────────────────────────────────────
//
// Replaces the old per-page SERVER wrapper that ran, on every request:
//     await serverClient.auth.getUser()              // round trip → Supabase (Tokyo)
//     await serverClient.from("profiles")...role     // round trip → Supabase (Tokyo)
// ...sequentially, from the Vercel function in Virginia. On a force-dynamic
// (uncacheable) route that was ~350ms of TTFB before a single byte of HTML
// shipped — the tax that made the admin pages feel slow.
//
// WHAT ENFORCES WHAT NOW:
//   • Signed-in vs not            → AppShell (already redirects to /login
//                                    before any page mounts).
//   • Admin role                  → this component, using the `role` already
//                                    resolved in AuthContext at app start —
//                                    NO extra network round trip.
//   • Actual DATA protection      → RLS on the underlying tables / RPC execute
//                                    permissions, unchanged. This gate is
//                                    UX-level (hide the page chrome); the
//                                    database is the real security boundary.
//
// NOTE on the resolve window: AuthContext clears `loading` on INITIAL_SESSION,
// but fetches the profile (and thus `role`) one effect later. So there is a
// brief window where the user is known but `role` is still null. We treat that
// as "still resolving" and show a spinner, so an admin is never bounced during
// that ~one-round-trip gap. A timeout guards against a profile that never
// resolves (missing row / failed fetch) so we don't spin forever.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";

export default function AdminGate({ children }: { children: ReactNode }) {
  const { user, profile, role, loading } = useAuth();
  const router = useRouter();

  // True while we don't yet know the role for certain.
  // (signed in but profile not loaded yet → still resolving)
  const resolving = loading || (!!user && profile === null);
  const isAdmin   = role === "admin";

  // Once resolved and confirmed non-admin, send them home.
  useEffect(() => {
    if (!resolving && user && !isAdmin) {
      router.replace("/");
    }
  }, [resolving, user, isAdmin, router]);

  // Safety net: if the profile never resolves (missing row / failed fetch),
  // don't spin forever — bounce home after a generous grace period. A healthy
  // profile query returns in ~150ms, so this only fires on a genuine failure.
  useEffect(() => {
    if (!resolving) return;
    const t = setTimeout(() => {
      console.warn("[AdminGate] role did not resolve in time — redirecting home");
      router.replace("/");
    }, 8000);
    return () => clearTimeout(t);
  }, [resolving, router]);

  // Still resolving session/profile → spinner (matches AppShell's spinner)
  if (resolving) {
    return (
      <div className="h-full w-full flex items-center justify-center py-24">
        <div className="w-6 h-6 border-2 border-slate-300 border-t-amber-500 rounded-full animate-spin" />
      </div>
    );
  }

  // Non-admin → redirect is firing; render nothing in the meantime.
  if (!isAdmin) return null;

  // Admin → the real page.
  return <>{children}</>;
}

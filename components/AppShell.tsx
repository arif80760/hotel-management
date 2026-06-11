"use client";

// components/AppShell.tsx
//
// ─── APP SHELL ───────────────────────────────────────────────────────────────
//
// Client component that sits between the root layout and every page.
// It owns two responsibilities:
//
//   1. ROUTING GUARD
//      • Not signed in + not on /login → redirect to /login
//      • Signed in + on /login         → redirect to /
//
//   2. CONDITIONAL LAYOUT
//      • /login page         → renders children only (no sidebar, no topbar)
//      • All other pages     → renders Sidebar + TopBar + HotelProvider + children
//
// WHY HERE INSTEAD OF MIDDLEWARE:
//   The routing guard runs client-side so it can react to auth state changes
//   from AuthContext (onAuthStateChange). Supabase Auth now stores the session
//   in cookies (via createBrowserClient, Phase D1), making the JWT readable
//   server-side. Middleware-level route protection is the Phase D2 step;
//   this client guard remains in place until then.
//   The only visible difference from a user perspective is a brief loading
//   spinner on first paint while AuthContext resolves the initial session.
//
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, type ReactNode } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import { HotelProvider } from "@/contexts/HotelContext";
import Sidebar from "@/components/Sidebar";
import TopBar from "@/components/TopBar";

export default function AppShell({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const router   = useRouter();
  const pathname = usePathname();

  const isLoginPage = pathname === "/login";
  // Standalone document routes (invoice, reservation details) —
  // render without app shell so they print cleanly
  const isStandaloneDocument =
    /^\/bookings\/[^/]+\/(invoice|reservation)$/.test(pathname) ||
    /^\/accounts\/voucher\/[^/]+$/.test(pathname);

  // ── Routing guard ─────────────────────────────────────────────
  useEffect(() => {
    if (loading) return;                            // wait until session is known
    if (!user && !isLoginPage) router.replace("/login");
    if ( user &&  isLoginPage) router.replace("/");
  }, [user, loading, isLoginPage, router]);

  // ── Loading state ──────────────────────────────────────────────
  // Show a minimal spinner while the Supabase session check is in flight.
  // This prevents a flash of the app before the redirect fires.
  if (loading) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-slate-50">
        <div className="w-6 h-6 border-2 border-slate-300 border-t-amber-500 rounded-full animate-spin" />
      </div>
    );
  }

  // ── Login page — bare render, no shell ────────────────────────
  if (isLoginPage) {
    // If already logged in, render nothing while the redirect to "/" fires.
    if (user) return null;
    return <>{children}</>;
  }

  // ── Not logged in — render nothing while redirect fires ───────
  if (!user) return null;

  // ── Standalone document — authenticated but no app chrome ─────
  // Invoice and reservation-details pages must print without the
  // sidebar and topbar. HotelProvider is omitted too — these pages
  // are server components that fetch their own data directly.
  if (isStandaloneDocument) {
    return <div className="w-full min-h-full">{children}</div>;
  }

  // ── Authenticated — full shell ────────────────────────────────
  // HotelProvider is mounted here (not in root layout) so it only
  // loads data when the user is actually signed in. Mounting it when
  // unauthenticated would trigger Supabase fetches that RLS would block.
  return (
    <HotelProvider>
      <div className="flex w-full h-screen">
        <Sidebar />
        <div className="flex-1 flex flex-col min-h-screen">
          <TopBar />
          <main className="flex-1 overflow-auto bg-slate-50">
            {children}
          </main>
        </div>
      </div>
    </HotelProvider>
  );
}

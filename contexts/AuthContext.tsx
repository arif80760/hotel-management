"use client";

// contexts/AuthContext.tsx
//
// ─── AUTH CONTEXT ────────────────────────────────────────────────────────────
//
// THE LOCK DEADLOCK (and why the code is structured this way):
//
//   Supabase JS v2 holds an internal "gotrue lock" while firing onAuthStateChange.
//   That lock prevents concurrent token refreshes.
//
//   The previous version called `await fetchProfile(...)` inside the
//   onAuthStateChange callback.  fetchProfile calls supabase.from("profiles"),
//   which internally calls getSession() to attach the Bearer token.
//   getSession() tries to acquire the SAME gotrue lock — but onAuthStateChange
//   already holds it.  Both sides block each other: deadlock.  Spinner forever.
//
// THE FIX — two separate effects:
//
//   Effect 1  onAuthStateChange
//     • Callback is synchronous — NO await, NO supabase.from() calls.
//     • Only sets the User object and clears loading.
//     • Never touches the gotrue lock after it is released.
//
//   Effect 2  Profile fetch  (deps: [user?.id])
//     • Runs AFTER Effect 1 has updated React state and the auth lock is gone.
//     • Calls supabase.from("profiles") safely — no lock contention.
//     • Cancelled if the component unmounts or user changes before it resolves
//       (handles React Strict Mode double-mount cleanly).
//
// REACT STRICT MODE (development):
//   Next.js dev mode mounts → cleans up → remounts every component.
//   Effect 1 subscribes, then the cleanup unsubscribes, then subscribes again.
//   Because the callback is now synchronous, the second INITIAL_SESSION event
//   just sets the same user — no duplicate DB queries, no lock race.
//
// ─────────────────────────────────────────────────────────────────────────────

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { supabase } from "@/lib/supabase";
import type { User } from "@supabase/supabase-js";

// ─────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────

export type UserRole = "admin" | "staff";

export type UserProfile = {
  id:        string;
  full_name: string;
  role:      UserRole;
};

type AuthContextType = {
  user:    User | null;
  profile: UserProfile | null;
  role:    UserRole | null;
  loading: boolean;
  canViewActivityLog: boolean;
  signIn:  (email: string, password: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
};

// ─────────────────────────────────────────────────────────────
// PROFILE FETCH  (module-level — stable reference, no closure issues)
// ─────────────────────────────────────────────────────────────
//
// Defined outside the component so it is never re-created on render
// and does not need to appear in any useEffect dependency array.
//
// Returns null on any error — never throws, so callers can always
// proceed without try/catch.

async function fetchProfile(userId: string): Promise<UserProfile | null> {
  console.log("[AuthContext] fetchProfile — start, userId:", userId);

  const { data, error, status, statusText } = await supabase
    .from("profiles")
    .select("id, full_name, role")
    .eq("id", userId)
    .single();

  if (error) {
    console.error("[AuthContext] fetchProfile — FAILED");
    console.error("  message    :", error.message);
    console.error("  details    :", error.details);
    console.error("  hint       :", error.hint);
    console.error("  code       :", error.code);
    console.error("  HTTP status:", status, statusText);
    return null;
  }

  const prof = data as UserProfile;
  console.log("[AuthContext] fetchProfile — success:", {
    id:        prof.id,
    full_name: prof.full_name,
    role:      prof.role,
  });
  return prof;
}

// ─────────────────────────────────────────────────────────────
// CONTEXT
// ─────────────────────────────────────────────────────────────

const AuthContext = createContext<AuthContextType | null>(null);

// ─────────────────────────────────────────────────────────────
// PROVIDER
// ─────────────────────────────────────────────────────────────

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user,    setUser]    = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true); // cleared after INITIAL_SESSION
  const [canViewActivityLog, setCanViewActivityLog] = useState(false);

  // ── Effect 1: Auth subscription — SYNCHRONOUS, NO await ──────
  //
  // CRITICAL: this callback must remain synchronous.
  // Do NOT add await, supabase.from(), or any async call here.
  // Doing so re-enters the gotrue lock and causes a deadlock.
  useEffect(() => {
    // This flag ensures setLoading(false) fires only once even if Strict Mode
    // causes the effect to run twice (mount → cleanup → remount).
    let initialised = false;

    console.log("[AuthContext] subscribing to auth state changes");

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      // ← synchronous callback, no await
      console.log(`[AuthContext] event: ${event} | session: ${session ? "exists" : "null"}`);

      if (session?.user) {
        console.log("[AuthContext] user id:", session.user.id, "| email:", session.user.email);
        setUser(session.user);
        // profile is fetched by Effect 2 once this state update lands
      } else {
        console.log("[AuthContext] no session — clearing user and profile");
        setUser(null);
        setProfile(null);
      }

      // Clear loading on the very first event (INITIAL_SESSION).
      // All subsequent events (SIGNED_IN, TOKEN_REFRESHED, etc.) leave
      // loading untouched — it is already false by then.
      if (!initialised) {
        initialised = true;
        console.log("[AuthContext] setLoading(false) — INITIAL_SESSION handled");
        setLoading(false);
      }
    });

    return () => {
      console.log("[AuthContext] unsubscribing");
      subscription.unsubscribe();
    };
  }, []);

  // ── Effect 2: Profile fetch — runs AFTER Effect 1, outside auth lock ──
  //
  // Triggered when user?.id changes (i.e., after sign-in or sign-out).
  // Because this runs in a separate React effect cycle, the gotrue lock
  // from onAuthStateChange has already been released — no deadlock possible.
  //
  // The `cancelled` flag handles React Strict Mode double-mount:
  // if the effect cleans up before the fetch resolves, the result is discarded.
  useEffect(() => {
    if (!user) {
      setProfile(null);
      return;
    }

    let cancelled = false;

    console.log("[AuthContext] profile fetch triggered for user:", user.id);

    fetchProfile(user.id).then(prof => {
      if (cancelled) {
        console.log("[AuthContext] profile fetch cancelled (component unmounted or user changed)");
        return;
      }
      console.log("[AuthContext] role resolved to:", prof?.role ?? null);
      setProfile(prof);
    });

    return () => {
      cancelled = true;
    };
  }, [user?.id]); // only re-run when the logged-in user actually changes

  // ── Effect 3: Activity-log visibility (admins + managers) ────────────
  useEffect(() => {
    if (!user) { setCanViewActivityLog(false); return; }
    let cancelled = false;
    (async () => {
      if (profile?.role === "admin") { if (!cancelled) setCanViewActivityLog(true); return; }
      const { data, error } = await supabase.rpc("can_view_activity_log");
      if (!cancelled) setCanViewActivityLog(!error && data === true);
    })();
    return () => { cancelled = true; };
  }, [user?.id, profile?.role]);

  // ── Auth actions ──────────────────────────────────────────────

  async function signIn(
    email: string,
    password: string,
  ): Promise<{ error: string | null }> {
    console.log("[AuthContext] signIn — attempt for:", email);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      console.error("[AuthContext] signIn — failed:", error.message);
      return { error: error.message };
    }
    console.log("[AuthContext] signIn — success; waiting for SIGNED_IN event");
    return { error: null };
    // onAuthStateChange fires SIGNED_IN → Effect 1 sets user → Effect 2 fetches profile
  }

  async function signOut(): Promise<void> {
    console.log("[AuthContext] signOut");
    await supabase.auth.signOut();
    // onAuthStateChange fires SIGNED_OUT and clears state via Effect 1,
    // but we also clear immediately here to avoid any visual flicker.
    setUser(null);
    setProfile(null);
  }

  return (
    <AuthContext.Provider
      value={{
        user,
        profile,
        role: profile?.role ?? null,
        loading,
        canViewActivityLog,
        signIn,
        signOut,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

// ─────────────────────────────────────────────────────────────
// HOOK
// ─────────────────────────────────────────────────────────────

export function useAuth(): AuthContextType {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth() must be called inside <AuthProvider>");
  return ctx;
}

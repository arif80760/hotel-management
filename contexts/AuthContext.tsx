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
  avatarUrl: string | null;
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

  // One retry with a short backoff: a transient network/RLS blip must not
  // brand the user role-less (→ treated as staff) for the entire session.
  type ProfileRow = { id: string; full_name: string; role: UserRole; avatar_url: string | null };
  let data:           ProfileRow | null = null;
  let lastError:      { message: string; details: string | null; hint: string | null; code: string } | null = null;
  let lastStatus:     number | undefined;
  let lastStatusText: string | undefined;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const { data: rowData, error, status, statusText } = await supabase
      .from("profiles")
      .select("id, full_name, role, avatar_url")
      .eq("id", userId)
      .single();

    if (!error && rowData) {
      data = rowData as ProfileRow;
      break;
    }
    lastError = error; lastStatus = status; lastStatusText = statusText;
    if (attempt === 1) {
      console.warn("[AuthContext] fetchProfile — attempt 1 failed, retrying in 500ms:", error?.message);
      await new Promise(res => setTimeout(res, 500));
    }
  }

  if (!data) {
    console.error("[AuthContext] fetchProfile — FAILED after retry (role stays null; user treated as non-admin)");
    console.error("  message    :", lastError?.message);
    console.error("  details    :", lastError?.details);
    console.error("  hint       :", lastError?.hint);
    console.error("  code       :", lastError?.code);
    console.error("  HTTP status:", lastStatus, lastStatusText);
    return null;
  }

  const row = data;
  const prof: UserProfile = {
    id:        row.id,
    full_name: row.full_name,
    role:      row.role,
    avatarUrl: row.avatar_url
      ? (String(row.avatar_url).startsWith("http")
          ? row.avatar_url
          : supabase.storage.from("avatars").getPublicUrl(row.avatar_url).data.publicUrl)
      : null,
  };
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
  // ── Three-state loading model (fixes the 258aa66 redirect loop) ──
  //   (a) auth event NOT yet delivered → loading TRUE, no exceptions.
  //   (b) settled, no session          → loading false (legitimately signed out).
  //   (c) settled, session exists      → loading true until profile (role) settles.
  // authEventReceived is the explicit (a)→(b|c) marker. user === null alone
  // CANNOT distinguish (a) from (b) — conflating them was the 258aa66 bug:
  // Effect 2 cleared loading in its !user branch on first mount, before the
  // session arrived, so AppShell redirected to /login and looped.
  const [loading,           setLoading]           = useState(true);
  const [authEventReceived, setAuthEventReceived] = useState(false);
  const [canViewActivityLog, setCanViewActivityLog] = useState(false);

  // ── Effect 1: Auth subscription — SYNCHRONOUS, NO await ──────
  //
  // CRITICAL: this callback must remain synchronous.
  // Do NOT add await, supabase.from(), or any async call here.
  // Doing so re-enters the gotrue lock and causes a deadlock.
  useEffect(() => {
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

      // Mark the auth state as DELIVERED. Effect 2 owns clearing `loading`:
      //   no session      → it clears immediately (settled signed-out), state (b)
      //   session exists  → it clears after the profile fetch settles, state (c)
      // Effect 1 deliberately never touches `loading` — clearing it here (or
      // anywhere before authEventReceived) is what caused the 258aa66 loop.
      // Idempotent under Strict Mode remounts and later SIGNED_IN/TOKEN_REFRESHED.
      setAuthEventReceived(true);
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
      // THREE-STATE RULE — the 258aa66 fix:
      //   state (a) auth event not yet delivered: user is null only because we
      //     don't know the session yet. Do NOTHING — loading must stay true,
      //     or AppShell redirects to /login before the session arrives (loop).
      //   state (b) settled signed-out (incl. sign-out mid-fetch — the cleanup
      //     below cancelled the stale fetch): safe to release the app.
      if (authEventReceived) {
        console.log("[AuthContext] settled signed-out — setLoading(false)");
        setLoading(false);
      }
      return;
    }

    let cancelled = false;

    console.log("[AuthContext] profile fetch triggered for user:", user.id);

    fetchProfile(user.id)
      .then(prof => {
        if (cancelled) {
          console.log("[AuthContext] profile fetch cancelled (component unmounted or user changed)");
          return;
        }
        console.log("[AuthContext] role resolved to:", prof?.role ?? null);
        setProfile(prof);
        // State (c) settled: role known (or definitively unknown after the
        // retry — prof null, treated as non-admin, NEVER defaulted to admin).
        setLoading(false);
      })
      .catch(err => {
        // fetchProfile resolves null on query errors; this net catches only
        // unexpected throws so the spinner can never be stranded. Reachable
        // only in state (c) — a session exists — so clearing is legal.
        if (cancelled) return;
        console.error("[AuthContext] profile fetch threw unexpectedly:", err);
        setProfile(null);
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [user?.id, authEventReceived]); // re-run when the user changes OR auth settles

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

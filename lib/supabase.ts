// lib/supabase.ts
//
// ─── SUPABASE BROWSER CLIENT  (true singleton) ───────────────────────────────
//
// A single shared SupabaseClient instance for the entire browser session.
// Session tokens are stored in cookies (via @supabase/ssr createBrowserClient),
// making the session visible to Next.js Server Components and middleware.
//
// WHY globalThis:
//   In Next.js development, webpack HMR (Hot Module Replacement) can
//   re-evaluate module files when you save a change.  A plain module-level
//   `export const supabase = createBrowserClient(...)` would create a NEW
//   client on every HMR cycle.  Each new client registers its own internal
//   gotrue auth listener on top of the old one, causing:
//     • multiple INITIAL_SESSION events firing on the same page
//     • duplicate onAuthStateChange subscribers racing for the auth token lock
//     • infinite loading spinner in development
//
//   Pinning the instance to globalThis survives HMR — the module is
//   re-evaluated but the client object itself is reused unchanged.
//   In production builds there is no HMR, so this is a no-op safety measure.
//
//   Note: createBrowserClient has its own module-level cache (cachedBrowserClient)
//   that provides singleton behaviour within a single module evaluation, but
//   that cache resets on HMR re-evaluation. The globalThis pin is still needed.
//
// HOW IT WORKS:
//   First evaluation  → client does not exist on globalThis → createBrowserClient()
//   Subsequent HMR    → client already exists on globalThis → reuse it
//
// SESSION STORAGE:
//   createBrowserClient stores the session in document.cookie by default.
//   This makes the JWT readable by the server client in lib/supabaseServer.ts,
//   enabling server-side auth checks on document pages (Phase D2+).
//
// ─────────────────────────────────────────────────────────────────────────────

import { createBrowserClient }  from "@supabase/ssr";
import type { SupabaseClient }  from "@supabase/supabase-js";

const supabaseUrl  = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnon) {
  throw new Error(
    "Missing Supabase environment variables.\n" +
    "Create .env.local at the project root and add:\n" +
    "  NEXT_PUBLIC_SUPABASE_URL=https://<project>.supabase.co\n" +
    "  NEXT_PUBLIC_SUPABASE_ANON_KEY=<your-anon-key>"
  );
}

// Use a typed key on globalThis so TypeScript doesn't complain
const G = globalThis as typeof globalThis & { __hotel_supabase__?: SupabaseClient };

if (!G.__hotel_supabase__) {
  console.log("[supabase] creating client instance");
  G.__hotel_supabase__ = createBrowserClient(supabaseUrl, supabaseAnon);
} else {
  console.log("[supabase] reusing existing client instance (HMR)");
}

export const supabase: SupabaseClient = G.__hotel_supabase__;

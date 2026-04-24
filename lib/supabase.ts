// lib/supabase.ts
//
// ─── SUPABASE CLIENT  (true singleton) ───────────────────────────────────────
//
// A single shared SupabaseClient instance for the entire browser session.
//
// WHY globalThis:
//   In Next.js development, webpack HMR (Hot Module Replacement) can
//   re-evaluate module files when you save a change.  A plain module-level
//   `export const supabase = createClient(...)` would create a NEW client on
//   every HMR cycle.  Each new client registers its own internal gotrue auth
//   listener on top of the old one, causing:
//     • multiple INITIAL_SESSION events firing on the same page
//     • duplicate onAuthStateChange subscribers racing for the auth token lock
//     • infinite loading spinner in development
//
//   Pinning the instance to globalThis survives HMR — the module is
//   re-evaluated but the client object itself is reused unchanged.
//   In production builds there is no HMR, so this is a no-op safety measure.
//
// HOW IT WORKS:
//   First evaluation  → client does not exist on globalThis → createClient()
//   Subsequent HMR    → client already exists on globalThis → reuse it
//
// ─────────────────────────────────────────────────────────────────────────────

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

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
  G.__hotel_supabase__ = createClient(supabaseUrl, supabaseAnon);
} else {
  console.log("[supabase] reusing existing client instance (HMR)");
}

export const supabase: SupabaseClient = G.__hotel_supabase__;

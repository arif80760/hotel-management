// lib/supabaseAdmin.ts
//
// ─── SUPABASE ADMIN CLIENT  (SERVER-ONLY) ────────────────────────────────────
//
// Uses the SERVICE ROLE KEY which bypasses Row Level Security.
// ⚠️  NEVER import this file in a client component or any file
//     that runs in the browser.  It must only be imported from:
//       • app/api/**/route.ts   (Next.js Route Handlers)
//       • Server Actions        (files with "use server")
//       • scripts/              (one-off server scripts)
//
// The service role key is stored in SUPABASE_SERVICE_ROLE_KEY (no NEXT_PUBLIC_
// prefix, so Next.js never bundles it into the browser build).
//
// WHY LAZY INITIALISATION (not module-level throws):
//   A module-level `throw` fires the instant the module is imported —
//   before any request handler runs.  Next.js catches the module-load error
//   and serves its HTML error page.  The route handler never executes,
//   so it can never return a JSON error response.
//
//   Using a lazy getter (getAdminClient) means the throw happens INSIDE the
//   request handler, where the top-level try-catch converts it to JSON:
//     { "error": "Missing SUPABASE_SERVICE_ROLE_KEY …" }
//
// ─────────────────────────────────────────────────────────────────────────────

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Cached instance — created once per server process, reused on every request.
let _adminClient: SupabaseClient | null = null;

/**
 * Returns the Supabase admin (service-role) client.
 *
 * Call this INSIDE a request handler (never at module top-level) so that
 * any missing-env-var error is thrown inside the handler's try-catch and
 * gets converted to a JSON 500 instead of an HTML error page.
 *
 * @throws {Error} if NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY
 *                 are not set in the server environment.
 */
export function getAdminClient(): SupabaseClient {
  if (_adminClient) return _adminClient;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url) {
    throw new Error(
      "[supabaseAdmin] Missing NEXT_PUBLIC_SUPABASE_URL — check .env.local",
    );
  }
  if (!key) {
    throw new Error(
      "[supabaseAdmin] Missing SUPABASE_SERVICE_ROLE_KEY — add it to .env.local\n" +
      "  Find it in: Supabase Dashboard → Project Settings → API → service_role key\n" +
      "  IMPORTANT: never prefix this with NEXT_PUBLIC_ or it will be exposed to the browser.",
    );
  }

  _adminClient = createClient(url, key, {
    auth: {
      autoRefreshToken: false,  // server processes should not auto-refresh
      persistSession:   false,  // never write a session to disk / storage
    },
  });

  return _adminClient;
}

// lib/requireAdmin.ts
//
// Shared admin-gate for server route handlers that use the service-role client.
//
// Mirrors EXACTLY the inline gate in app/api/employees/provision/route.ts:
//   1. Read the caller's JWT from the Authorization: Bearer header
//   2. Verify it with the admin client (auth.getUser)
//   3. Confirm the caller's profiles.role === 'admin'
//
// On success returns { ok: true, caller, adminClient } so the route can reuse the
// same admin client instance. On failure returns { ok: false, response } — a ready
// JSON NextResponse with the right status (401/403). Routes do: `if (!gate.ok)
// return gate.response;`.
//
// NOTE: provision/route.ts keeps its own inline copy of this gate intentionally
// (do not refactor it onto this helper) — these two NEW routes (delete,
// set-password) are the only callers.

import { NextRequest, NextResponse } from "next/server";
import { getAdminClient } from "@/lib/supabaseAdmin";
import type { SupabaseClient, User } from "@supabase/supabase-js";

export type AdminGate =
  | { ok: true;  caller: User; adminClient: SupabaseClient }
  | { ok: false; response: NextResponse };

export async function requireAdmin(req: NextRequest): Promise<AdminGate> {
  // Initialise the admin client here (inside the handler) so a missing
  // SUPABASE_SERVICE_ROLE_KEY throws into the route's outer try-catch → JSON 500.
  const adminClient = getAdminClient();

  // ── 1. Extract bearer token ────────────────────────────────
  const authHeader = req.headers.get("authorization") ?? "";
  const token      = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Unauthorized — missing Bearer token." },
        { status: 401 },
      ),
    };
  }

  // ── 2. Verify the JWT and identify the caller ──────────────
  const { data: { user: caller }, error: jwtError } =
    await adminClient.auth.getUser(token);

  if (jwtError || !caller) {
    console.error("[requireAdmin] JWT verification failed:", jwtError?.message);
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Unauthorized — invalid or expired token." },
        { status: 401 },
      ),
    };
  }

  // ── 3. Confirm caller is an admin ──────────────────────────
  const { data: callerProfile, error: profileError } = await adminClient
    .from("profiles")
    .select("role")
    .eq("id", caller.id)
    .single();

  if (profileError || !callerProfile) {
    console.error("[requireAdmin] could not read caller profile:", profileError?.message);
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Forbidden — could not verify caller role." },
        { status: 403 },
      ),
    };
  }

  if (callerProfile.role !== "admin") {
    console.warn("[requireAdmin] non-admin attempted privileged action; caller:", caller.id);
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Forbidden — admin role required." },
        { status: 403 },
      ),
    };
  }

  return { ok: true, caller, adminClient };
}

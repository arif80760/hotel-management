// app/api/employees/set-password/route.ts
//
// ─── EMPLOYEE PASSWORD RESET ENDPOINT (admin-only) ──────────────────────────
//
// POST /api/employees/set-password
//
// Lets an admin set/reset the login password for a staff member who has an app
// login (employees.auth_user_id is set). Uses auth.admin.updateUserById, which
// requires the service role and must never run in the browser.
//
// Admin gate via lib/requireAdmin (identical logic to provision/route.ts).
//
// Error contract: ALL responses are JSON. { "error": "..." } / { "ok": true }.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/requireAdmin";

type SetPasswordBody = {
  id?:          string;   // employees.id (preferred)
  authUserId?:  string;   // optional fallback
  newPassword:  string;
};

export async function POST(req: NextRequest) {
  try {
    return await handleSetPassword(req);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[set-password] unhandled error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

async function handleSetPassword(req: NextRequest): Promise<NextResponse> {
  // ── Admin gate (token → getUser → profiles.role === 'admin') ──
  const gate = await requireAdmin(req);
  if (!gate.ok) return gate.response;
  const { adminClient } = gate;

  // ── Parse + validate body ──────────────────────────────────
  let body: SetPasswordBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (!body?.id?.trim() && !body?.authUserId?.trim()) {
    return NextResponse.json(
      { error: "Provide an employee id (or authUserId)." },
      { status: 400 },
    );
  }
  if (!body?.newPassword || body.newPassword.length < 6) {
    return NextResponse.json(
      { error: "newPassword must be at least 6 characters." },
      { status: 400 },
    );
  }

  // ── Resolve auth_user_id ───────────────────────────────────
  let authUserId: string | null = body.authUserId?.trim() || null;

  if (!authUserId) {
    const { data: emp, error: loadError } = await adminClient
      .from("employees")
      .select("auth_user_id")
      .eq("id", body.id!.trim())
      .single();

    if (loadError || !emp) {
      return NextResponse.json(
        { error: `Employee not found: ${loadError?.message ?? "no matching row"}` },
        { status: 404 },
      );
    }
    authUserId = emp.auth_user_id ?? null;
  }

  if (!authUserId) {
    return NextResponse.json(
      { error: "This employee has no app login — nothing to reset. Enable app access and provision an account first." },
      { status: 400 },
    );
  }

  // ── Update the password ────────────────────────────────────
  const { error: updateError } =
    await adminClient.auth.admin.updateUserById(authUserId, { password: body.newPassword });

  if (updateError) {
    console.error("[set-password] updateUserById failed:", updateError.message);
    return NextResponse.json(
      { error: `Could not update password: ${updateError.message}` },
      { status: 500 },
    );
  }

  console.log(`[set-password] ✓ password reset for auth user ${authUserId}`);
  return NextResponse.json({ ok: true }, { status: 200 });
}

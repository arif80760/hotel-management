// app/api/employees/update-login/route.ts
//
// ─── EMPLOYEE LOGIN UPDATE ENDPOINT (admin-only) ────────────────────────────
//
// POST /api/employees/update-login
//
// Updates a staff member's AUTH login (email and/or password) in one admin-gated
// call, so the auth user never diverges from the employees row.
//
//   • newPassword → auth.admin.updateUserById(authUserId, { password })
//   • newEmail    → only applied when it DIFFERS from the auth user's current
//                   email (auth.admin.updateUserById(authUserId, { email,
//                   email_confirm: true })). Keeps the login email in sync with
//                   employees.email, which the edit form writes separately.
//
// Both attributes are applied in a single updateUserById call when both change.
//
// Admin gate via lib/requireAdmin (identical logic to provision/route.ts).
// Error contract: ALL responses JSON. { ok, emailChanged, passwordChanged } / { error }.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/requireAdmin";

type UpdateLoginBody = {
  id?:          string;   // employees.id (preferred)
  authUserId?:  string;   // optional fallback
  newEmail?:    string;   // synced only if it differs from current auth email
  newPassword?: string;   // set only if provided (>= 6 chars)
};

export async function POST(req: NextRequest) {
  try {
    return await handleUpdateLogin(req);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[update-login] unhandled error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

async function handleUpdateLogin(req: NextRequest): Promise<NextResponse> {
  const gate = await requireAdmin(req);
  if (!gate.ok) return gate.response;
  const { adminClient } = gate;

  // ── Parse + validate body ──────────────────────────────────
  let body: UpdateLoginBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (!body?.id?.trim() && !body?.authUserId?.trim()) {
    return NextResponse.json({ error: "Provide an employee id (or authUserId)." }, { status: 400 });
  }

  const wantEmail    = !!body.newEmail?.trim();
  const wantPassword = !!body.newPassword;

  if (!wantEmail && !wantPassword) {
    return NextResponse.json({ error: "Nothing to update — provide newEmail and/or newPassword." }, { status: 400 });
  }
  if (wantPassword && body.newPassword!.length < 6) {
    return NextResponse.json({ error: "newPassword must be at least 6 characters." }, { status: 400 });
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
      { error: "This employee has no app login — nothing to update. Enable app access and provision an account first." },
      { status: 400 },
    );
  }

  // ── Build the attributes to change ─────────────────────────
  const attrs: { email?: string; email_confirm?: boolean; password?: string } = {};

  if (wantPassword) {
    attrs.password = body.newPassword!;
  }

  let emailChanged = false;
  if (wantEmail) {
    // Compare against the auth user's CURRENT email — only sync on a real change.
    const { data: current, error: getError } = await adminClient.auth.admin.getUserById(authUserId);
    if (getError || !current?.user) {
      return NextResponse.json(
        { error: `Could not read current login: ${getError?.message ?? "unknown error"}` },
        { status: 500 },
      );
    }
    const desired = body.newEmail!.trim().toLowerCase();
    if ((current.user.email ?? "").toLowerCase() !== desired) {
      attrs.email         = desired;
      attrs.email_confirm = true;   // keep it active immediately; no re-verification email
      emailChanged        = true;
    }
  }

  // Nothing actually differs (email unchanged, no password) → no-op success.
  if (Object.keys(attrs).length === 0) {
    return NextResponse.json({ ok: true, emailChanged: false, passwordChanged: false }, { status: 200 });
  }

  // ── Apply ──────────────────────────────────────────────────
  const { error: updateError } = await adminClient.auth.admin.updateUserById(authUserId, attrs);
  if (updateError) {
    console.error("[update-login] updateUserById failed:", updateError.message);
    return NextResponse.json(
      { error: `Could not update login: ${updateError.message}` },
      { status: 500 },
    );
  }

  console.log(
    `[update-login] ✓ auth user ${authUserId} updated — email:${emailChanged} password:${wantPassword}`,
  );
  return NextResponse.json(
    { ok: true, emailChanged, passwordChanged: wantPassword },
    { status: 200 },
  );
}

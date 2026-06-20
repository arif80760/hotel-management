// app/api/employees/delete/route.ts
//
// ─── EMPLOYEE DELETION ENDPOINT (admin-only) ────────────────────────────────
//
// POST /api/employees/delete
//
// Why a server route (not the client deleteEmployee): removing the employees
// row alone leaves the Supabase Auth user + profiles row intact, so a "deleted"
// staff member can still log in. Tearing down the login requires the service
// role (auth.admin.deleteUser), which must never run in the browser.
//
// Order (auth-lifecycle fix):
//   1. auth.admin.deleteUser(authUserId)   ← kills the login FIRST
//      DB cascades make this clean:
//        • profiles.id → auth.users ON DELETE CASCADE   (profiles row auto-removed)
//        • employees.auth_user_id → auth.users ON DELETE SET NULL
//          (employees row survives for the explicit delete in step 3)
//   2. delete the profiles row             ← explicit, idempotent after cascade
//   3. delete the employees row
//   If auth_user_id is null (non-app-access staff): just step 3.
//
// Admin gate via lib/requireAdmin (identical logic to provision/route.ts).
// Includes a self-delete guard: an admin cannot delete their own account.
//
// Error contract: ALL responses are JSON. { "error": "..." } / { "ok": true }.
// Partial failures are reported, never silent.
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/requireAdmin";

type DeleteBody = {
  id?:         string;   // employees.id (preferred)
  authUserId?: string;   // optional fallback / cross-check
};

export async function POST(req: NextRequest) {
  try {
    return await handleDelete(req);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[delete] unhandled error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

async function handleDelete(req: NextRequest): Promise<NextResponse> {
  // ── Admin gate (token → getUser → profiles.role === 'admin') ──
  const gate = await requireAdmin(req);
  if (!gate.ok) return gate.response;
  const { caller, adminClient } = gate;

  // ── Parse body ─────────────────────────────────────────────
  let body: DeleteBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (!body?.id?.trim() && !body?.authUserId?.trim()) {
    return NextResponse.json(
      { error: "Provide an employee id (or authUserId) to delete." },
      { status: 400 },
    );
  }

  // ── Load the employee ──────────────────────────────────────
  const lookup = body.id?.trim()
    ? adminClient.from("employees").select("id, auth_user_id, full_name").eq("id", body.id.trim())
    : adminClient.from("employees").select("id, auth_user_id, full_name").eq("auth_user_id", body.authUserId!.trim());

  const { data: emp, error: loadError } = await lookup.single();

  if (loadError || !emp) {
    return NextResponse.json(
      { error: `Employee not found: ${loadError?.message ?? "no matching row"}` },
      { status: 404 },
    );
  }

  const authUserId: string | null = emp.auth_user_id ?? null;
  const empId:   string = emp.id;          // captured for use inside the closures below
  const empName: string = emp.full_name;

  // ── Self-delete guard ──────────────────────────────────────
  if (authUserId && authUserId === caller.id) {
    return NextResponse.json(
      { error: "You cannot delete your own admin account while signed in." },
      { status: 400 },
    );
  }

  // Fallback helpers — used when a hard delete is blocked by FK references
  // (the employee/login has booking/transaction history that must be preserved).
  // Ban the login (~100 years) so it can never sign in again:
  async function banLogin(uid: string): Promise<string | null> {
    const { error } = await adminClient.auth.admin.updateUserById(uid, { ban_duration: "876000h" });
    return error ? error.message : null;
  }
  // Flip the employee inactive — the SAME field as the "Active employee" toggle:
  async function deactivateEmployee(): Promise<string | null> {
    const { error } = await adminClient.from("employees").update({ is_active: false }).eq("id", empId);
    return error ? error.message : null;
  }

  // ── Delete the auth user FIRST (if a login exists) ──────────
  if (authUserId) {
    const { error: authDelError } = await adminClient.auth.admin.deleteUser(authUserId);
    if (authDelError) {
      // The auth user is FK-referenced (e.g. bookings/account_transactions point
      // at auth.users) and can't be hard-deleted ("Database error deleting user").
      // Fall back: ban the login + deactivate the employee so they can't sign in
      // and drop off the active roster, while preserving the historical links.
      console.warn("[delete] deleteUser failed — ban + deactivate fallback:", authDelError.message);
      const banErr   = await banLogin(authUserId);
      const deactErr = await deactivateEmployee();
      if (banErr || deactErr) {
        return NextResponse.json(
          {
            error:
              `Could not delete, and the fallback failed` +
              `${banErr ? ` (ban: ${banErr})` : ""}${deactErr ? ` (deactivate: ${deactErr})` : ""}. Please retry.`,
          },
          { status: 500 },
        );
      }
      console.log(`[delete] ⓘ ${emp.full_name} kept — login banned + deactivated (history present).`);
      return NextResponse.json(
        {
          ok: true,
          outcome: "deactivated",
          id: emp.id,
          message: `${emp.full_name} has history, so the record was kept — login disabled and employee deactivated.`,
        },
        { status: 200 },
      );
    }

    // Hard-delete succeeded — remove the profiles row (idempotent after cascade).
    const { error: profDelError } = await adminClient
      .from("profiles")
      .delete()
      .eq("id", authUserId);

    if (profDelError) {
      console.error("[delete] profiles delete failed (login already removed):", profDelError.message);
      return NextResponse.json(
        {
          error:
            `Login removed, but the profile row could not be deleted: ${profDelError.message}. ` +
            `The employee record was NOT deleted — please retry or clean up manually.`,
        },
        { status: 500 },
      );
    }
  }

  // ── Delete the employees row ───────────────────────────────
  const { error: empDelError } = await adminClient
    .from("employees")
    .delete()
    .eq("id", emp.id);

  if (empDelError) {
    // FK-referenced (e.g. inventory_movements.issued_to_employee_id is RESTRICT).
    // Can't hard-delete the row → deactivate instead. Any login was already
    // removed above, so deactivation just drops them off the active roster.
    console.warn("[delete] employees delete failed — deactivate fallback:", empDelError.message);
    const deactErr = await deactivateEmployee();
    if (deactErr) {
      return NextResponse.json(
        {
          error:
            `Could not delete the employee record (${empDelError.message}) ` +
            `and deactivation also failed (${deactErr}). Please retry.`,
        },
        { status: 500 },
      );
    }
    return NextResponse.json(
      {
        ok: true,
        outcome: "deactivated",
        id: emp.id,
        message:
          `${emp.full_name} has history, so the record was kept — employee deactivated` +
          `${authUserId ? " (login already removed)" : ""}.`,
      },
      { status: 200 },
    );
  }

  console.log(
    `[delete] ✓ employee ${emp.id} (${emp.full_name}) fully removed${authUserId ? " incl. login" : " (no login)"}`,
  );
  return NextResponse.json({ ok: true, outcome: "deleted", id: emp.id, hadLogin: !!authUserId }, { status: 200 });
}

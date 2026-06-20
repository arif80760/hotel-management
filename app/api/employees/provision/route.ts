// app/api/employees/provision/route.ts
//
// ─── EMPLOYEE PROVISIONING ENDPOINT ─────────────────────────────────────────
//
// POST /api/employees/provision
//
// What this route does (in order):
//   1. Reads the caller's JWT from the Authorization header
//   2. Verifies the JWT is valid using the admin client
//   3. Confirms the caller has role = "admin" in the profiles table
//   4. Validates the incoming employee payload
//   5. Creates a Supabase Auth user (email + temp password, email pre-confirmed)
//   6. Inserts the employee record with auth_user_id set to the new auth UUID
//   7. Upserts a matching row in the profiles table
//   8. Returns the created Employee record
//
// If any step after auth-user-creation fails, the auth user is deleted so
// we never leave an orphaned login account with no employee record.
//
// Security:
//   • Service role key lives only in this server-side file — never in the browser
//   • Caller JWT is validated before any write happens
//   • Admin role check prevents staff from creating accounts
//
// Error contract:
//   ALL responses from this route are JSON.  The outer try-catch guarantees
//   this even for unexpected runtime errors or missing env-var configuration.
//   Format on error:  { "error": "<human-readable message>" }
//   Format on success: { "employee": { ...Employee fields } }
//
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server";
import { getAdminClient } from "@/lib/supabaseAdmin";

// ─── Types ────────────────────────────────────────────────────

type ProvisionBody = {
  employee: {
    employeeId:       string;
    fullName:         string;
    email:            string;         // required — used for auth user
    phone:            string | null;
    bloodGroup:       string | null;
    designation:      string;
    canAccessApp:     true;           // this route is only called when true
    appRole:          "admin" | "staff";
    joiningDate:      string | null;
    emergencyContact: string | null;
    address:          string | null;
    notes:            string | null;
    isActive:         boolean;
  };
  tempPassword: string;
};

// ─── Route handler ────────────────────────────────────────────
//
// The OUTER try-catch is the last safety net: any unhandled throw
// (including getAdminClient() throwing for a missing env var) is caught
// here and returned as a JSON 500 instead of letting Next.js serve HTML.

export async function POST(req: NextRequest) {
  try {
    return await handleProvision(req);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[provision] unhandled error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// ─── Core logic (separated so the outer catch stays clean) ───

async function handleProvision(req: NextRequest): Promise<NextResponse> {
  // Initialise the admin client here, inside the request handler.
  // If SUPABASE_SERVICE_ROLE_KEY is missing this throws, which the
  // outer try-catch converts to { "error": "..." } JSON — not HTML.
  const adminClient = getAdminClient();

  // ── 1. Extract bearer token ────────────────────────────────
  const authHeader = req.headers.get("authorization") ?? "";
  const token      = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token) {
    return NextResponse.json(
      { error: "Unauthorized — missing Bearer token." },
      { status: 401 },
    );
  }

  // ── 2. Verify the JWT and identify the caller ──────────────
  const { data: { user: caller }, error: jwtError } =
    await adminClient.auth.getUser(token);

  if (jwtError || !caller) {
    console.error("[provision] JWT verification failed:", jwtError?.message);
    return NextResponse.json(
      { error: "Unauthorized — invalid or expired token." },
      { status: 401 },
    );
  }

  // ── 3. Confirm caller is an admin ──────────────────────────
  const { data: callerProfile, error: profileError } = await adminClient
    .from("profiles")
    .select("role")
    .eq("id", caller.id)
    .single();

  if (profileError || !callerProfile) {
    console.error("[provision] could not read caller profile:", profileError?.message);
    return NextResponse.json(
      { error: "Forbidden — could not verify caller role." },
      { status: 403 },
    );
  }

  if (callerProfile.role !== "admin") {
    console.warn("[provision] non-admin attempted to provision employee; caller:", caller.id);
    return NextResponse.json(
      { error: "Forbidden — only admins can provision employees." },
      { status: 403 },
    );
  }

  // ── 4. Parse and validate body ─────────────────────────────
  let body: ProvisionBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { employee, tempPassword } = body;

  if (!employee?.fullName?.trim()) {
    return NextResponse.json({ error: "fullName is required." }, { status: 400 });
  }
  if (!employee?.employeeId?.trim()) {
    return NextResponse.json({ error: "employeeId is required." }, { status: 400 });
  }
  if (!employee?.email?.trim()) {
    return NextResponse.json(
      { error: "email is required for app-access employees." },
      { status: 400 },
    );
  }
  if (!tempPassword || tempPassword.length < 6) {
    return NextResponse.json(
      { error: "tempPassword must be at least 6 characters." },
      { status: 400 },
    );
  }
  if (!employee?.appRole || !["admin", "staff"].includes(employee.appRole)) {
    return NextResponse.json(
      { error: "appRole must be 'admin' or 'staff'." },
      { status: 400 },
    );
  }

  const email    = employee.email.trim().toLowerCase();
  const fullName = employee.fullName.trim();
  const appRole  = employee.appRole;

  console.log(`[provision] admin ${caller.id} provisioning employee: ${email}`);

  // ── 5. Create the Supabase Auth user ──────────────────────
  //   email_confirm: true  → account is active immediately; no verification email
  //   user_metadata        → stored in auth.users.raw_user_meta_data
  const { data: authData, error: authError } =
    await adminClient.auth.admin.createUser({
      email,
      password:      tempPassword,
      email_confirm: true,
      user_metadata: { full_name: fullName, role: appRole },
    });

  if (authError || !authData?.user) {
    console.error("[provision] auth.admin.createUser failed:", authError?.message);

    if (authError?.message?.toLowerCase().includes("already registered")) {
      return NextResponse.json(
        {
          error:
            `An auth account with email "${email}" already exists. ` +
            `Use a different email or link the existing account manually.`,
        },
        { status: 409 },
      );
    }

    return NextResponse.json(
      { error: `Failed to create login account: ${authError?.message ?? "unknown error"}` },
      { status: 500 },
    );
  }

  const authUserId = authData.user.id;
  console.log(`[provision] auth user created: ${authUserId}`);

  // ── 6. Insert the employee record ─────────────────────────
  const employeePayload = {
    employee_id:       employee.employeeId.trim(),
    full_name:         fullName,
    email:             email,
    phone:             employee.phone?.trim()            || null,
    photo_url:         null,
    blood_group:       employee.bloodGroup               || null,
    designation:       employee.designation,
    can_access_app:    true,
    app_role:          appRole,
    joining_date:      employee.joiningDate              || null,
    emergency_contact: employee.emergencyContact?.trim() || null,
    address:           employee.address?.trim()          || null,
    notes:             employee.notes?.trim()            || null,
    is_active:         employee.isActive,
    auth_user_id:      authUserId,
  };

  const { data: empRow, error: empError } = await adminClient
    .from("employees")
    .insert(employeePayload)
    .select()
    .single();

  if (empError || !empRow) {
    console.error("[provision] employee insert failed:", empError?.message);

    // Rollback: delete the auth user so no orphaned login account is left
    console.warn("[provision] rolling back — deleting auth user:", authUserId);
    await adminClient.auth.admin.deleteUser(authUserId);

    return NextResponse.json(
      { error: `Employee record could not be saved: ${empError?.message ?? "unknown error"}` },
      { status: 500 },
    );
  }

  console.log(`[provision] employee record inserted: ${empRow.id}`);

  // ── 7. Upsert the profiles row ─────────────────────────────
  //   This is what AuthContext reads on every login.
  const { error: profileUpsertError } = await adminClient
    .from("profiles")
    .upsert(
      { id: authUserId, full_name: fullName, role: appRole },
      { onConflict: "id" },
    );

  if (profileUpsertError) {
    // FATAL: without a profiles row the user logs in with role = null (broken).
    // Roll back in reverse order — employee row, then auth user — so we never
    // leave a login account with no role behind.
    console.error("[provision] profile upsert FAILED — rolling back:", profileUpsertError.message);

    const { error: empRollbackError } = await adminClient
      .from("employees")
      .delete()
      .eq("id", empRow.id);
    if (empRollbackError) {
      console.error("[provision] employee rollback failed:", empRollbackError.message);
    }

    const { error: authRollbackError } = await adminClient.auth.admin.deleteUser(authUserId);
    if (authRollbackError) {
      console.error("[provision] auth-user rollback failed:", authRollbackError.message);
    }

    return NextResponse.json(
      { error: `Could not create profile (role) record: ${profileUpsertError.message}. Provisioning rolled back.` },
      { status: 500 },
    );
  }

  console.log(`[provision] profile row upserted for auth user: ${authUserId}`);

  // ── 8. Return the created employee (camelCase) ─────────────
  const created = {
    id:               empRow.id,
    employeeId:       empRow.employee_id,
    fullName:         empRow.full_name,
    email:            empRow.email,
    phone:            empRow.phone,
    photoUrl:         empRow.photo_url,
    bloodGroup:       empRow.blood_group,
    designation:      empRow.designation,
    canAccessApp:     empRow.can_access_app,
    appRole:          empRow.app_role,
    joiningDate:      empRow.joining_date,
    emergencyContact: empRow.emergency_contact,
    address:          empRow.address,
    notes:            empRow.notes,
    isActive:         empRow.is_active,
    authUserId:       empRow.auth_user_id,
    createdAt:        empRow.created_at,
  };

  console.log(
    `[provision] ✓ complete — employee ${created.employeeId} (${email}) is ready to log in`,
  );

  return NextResponse.json({ employee: created }, { status: 201 });
}

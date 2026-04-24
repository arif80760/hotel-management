// services/employeesService.ts
//
// ─── EMPLOYEES SERVICE ───────────────────────────────────────────────────────
//
// CRUD against the Supabase "employees" table.
//
// ARCHITECTURE NOTE — employees vs. app users:
//   An employee record is a hotel staff directory entry.
//   It is NOT the same as a Supabase auth.users login account.
//
//   can_access_app = false  →  directory record only; no login needed
//   can_access_app = true   →  employee is eligible for app access;
//                               auth.users account is created separately
//                               (future task — link via auth_user_id column)
//
// ─── SQL TO RUN IN SUPABASE ──────────────────────────────────────────────────
//
//   create table public.employees (
//     id                uuid        primary key default gen_random_uuid(),
//     employee_id       text        unique not null,
//     full_name         text        not null,
//     email             text,
//     phone             text,
//     photo_url         text,
//     blood_group       text,
//     designation       text        not null,
//     can_access_app    boolean     not null default false,
//     app_role          text        check (app_role in ('admin', 'staff')),
//     joining_date      date,
//     emergency_contact text,
//     address           text,
//     notes             text,
//     is_active         boolean     not null default true,
//     auth_user_id      uuid        references auth.users(id) on delete set null,
//     created_at        timestamptz not null default now(),
//     updated_at        timestamptz not null default now()
//   );
//
//   -- If the table already exists, add the auth_user_id column:
//   alter table public.employees
//     add column if not exists auth_user_id uuid references auth.users(id) on delete set null;
//   create index if not exists employees_auth_user_id_idx on public.employees(auth_user_id);
//
//   -- Link an employee to their login account:
//   update public.employees set auth_user_id = '<auth-user-uuid>' where employee_id = 'EMP-001';
//
//   alter table public.employees enable row level security;
//
//   -- All authenticated users can read employees
//   create policy "Authenticated can read employees"
//     on public.employees for select to authenticated using (true);
//
//   -- All authenticated users can write (admin-only gate is enforced in the app layer)
//   create policy "Authenticated can insert employees"
//     on public.employees for insert to authenticated with check (true);
//   create policy "Authenticated can update employees"
//     on public.employees for update to authenticated using (true);
//   create policy "Authenticated can delete employees"
//     on public.employees for delete to authenticated using (true);
//
// ─── SUPABASE STORAGE SETUP ──────────────────────────────────────────────────
//
//   1. In Supabase Dashboard → Storage → New bucket
//      Name: employee-photos
//      Public: ✓ (so photo URLs are directly accessible)
//
//   2. Storage policies (run in SQL editor):
//      create policy "Authenticated can upload photos"
//        on storage.objects for insert to authenticated
//        with check (bucket_id = 'employee-photos');
//      create policy "Anyone can view photos"
//        on storage.objects for select to public
//        using (bucket_id = 'employee-photos');
//      create policy "Authenticated can update photos"
//        on storage.objects for update to authenticated
//        using (bucket_id = 'employee-photos');
//
// ─────────────────────────────────────────────────────────────────────────────

import { supabase } from "@/lib/supabase";

// ─────────────────────────────────────────────────────────────
// TYPES (exported — used by EmployeesClient and Sidebar)
// ─────────────────────────────────────────────────────────────

export type Designation =
  | "General Manager"
  | "Manager"
  | "Receptionist"
  | "Cleaner"
  | "Room Attendant";

export type EmployeeAppRole = "admin" | "staff";

export type Employee = {
  id:               string;            // UUID from Supabase
  employeeId:       string;            // e.g. "EMP-001"
  fullName:         string;
  email:            string | null;
  phone:            string | null;
  photoUrl:         string | null;
  bloodGroup:       string | null;
  designation:      Designation;
  canAccessApp:     boolean;
  appRole:          EmployeeAppRole | null;
  joiningDate:      string | null;     // "YYYY-MM-DD"
  emergencyContact: string | null;
  address:          string | null;
  notes:            string | null;
  isActive:         boolean;
  authUserId:       string | null;  // FK → auth.users(id); null if no login account
  createdAt:        string;
};

// ─────────────────────────────────────────────────────────────
// DESIGNATION DEFAULTS
// Business rule: which designations get app access by default
// The user can always override can_access_app in the form.
// ─────────────────────────────────────────────────────────────

export const DESIGNATIONS: Designation[] = [
  "General Manager",
  "Manager",
  "Receptionist",
  "Cleaner",
  "Room Attendant",
];

export const DESIGNATION_DEFAULTS: Record<
  Designation,
  { canAccessApp: boolean; appRole: EmployeeAppRole | null }
> = {
  "General Manager": { canAccessApp: true,  appRole: "admin" },
  "Manager":         { canAccessApp: true,  appRole: "staff" },
  "Receptionist":    { canAccessApp: true,  appRole: "staff" },
  "Cleaner":         { canAccessApp: false, appRole: null    },
  "Room Attendant":  { canAccessApp: false, appRole: null    },
};

export const BLOOD_GROUPS = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"];

// ─────────────────────────────────────────────────────────────
// RAW ROW TYPE  (shape returned by Supabase)
// ─────────────────────────────────────────────────────────────

type EmployeeRow = {
  id:                string;
  employee_id:       string;
  full_name:         string;
  email:             string | null;
  phone:             string | null;
  photo_url:         string | null;
  blood_group:       string | null;
  designation:       string;
  can_access_app:    boolean;
  app_role:          string | null;
  joining_date:      string | null;
  emergency_contact: string | null;
  address:           string | null;
  notes:             string | null;
  is_active:         boolean;
  auth_user_id:      string | null;
  created_at:        string;
  updated_at:        string;
};

// ─────────────────────────────────────────────────────────────
// MAPPING HELPERS
// ─────────────────────────────────────────────────────────────

function mapEmployee(row: EmployeeRow): Employee {
  return {
    id:               row.id,
    employeeId:       row.employee_id,
    fullName:         row.full_name,
    email:            row.email,
    phone:            row.phone,
    photoUrl:         row.photo_url,
    bloodGroup:       row.blood_group,
    designation:      row.designation as Designation,
    canAccessApp:     row.can_access_app,
    appRole:          (row.app_role ?? null) as EmployeeAppRole | null,
    joiningDate:      row.joining_date,
    emergencyContact: row.emergency_contact,
    address:          row.address,
    notes:            row.notes,
    isActive:         row.is_active,
    authUserId:       row.auth_user_id ?? null,
    createdAt:        row.created_at,
  };
}

function toPayload(emp: Omit<Employee, "id" | "createdAt">) {
  return {
    employee_id:       emp.employeeId.trim(),
    full_name:         emp.fullName.trim(),
    email:             emp.email?.trim() || null,
    phone:             emp.phone?.trim() || null,
    photo_url:         emp.photoUrl?.trim() || null,
    blood_group:       emp.bloodGroup || null,
    designation:       emp.designation,
    can_access_app:    emp.canAccessApp,
    app_role:          emp.canAccessApp ? (emp.appRole ?? null) : null,
    joining_date:      emp.joiningDate || null,
    emergency_contact: emp.emergencyContact?.trim() || null,
    address:           emp.address?.trim() || null,
    notes:             emp.notes?.trim() || null,
    is_active:         emp.isActive,
  };
}

// ─────────────────────────────────────────────────────────────
// READ
// ─────────────────────────────────────────────────────────────

/**
 * Fetch all employees ordered by full_name.
 */
export async function getAllEmployees(): Promise<Employee[]> {
  const { data, error } = await supabase
    .from("employees")
    .select("*")
    .order("full_name");

  if (error) {
    console.error("──────────── [getAllEmployees] FAILED ────────────");
    console.error("  message:", error.message, "| code:", error.code);
    throw new Error(`[getAllEmployees] ${error.message}`);
  }

  return (data as EmployeeRow[]).map(mapEmployee);
}

// ─────────────────────────────────────────────────────────────
// CREATE
// ─────────────────────────────────────────────────────────────

/**
 * Insert a new employee. Returns the saved record with DB-generated UUID.
 */
export async function addEmployee(
  emp: Omit<Employee, "id" | "createdAt">,
): Promise<Employee> {
  const payload = toPayload(emp);
  console.log("[addEmployee] payload:", payload);

  const { data, error, status, statusText } = await supabase
    .from("employees")
    .insert(payload)
    .select()
    .single();

  if (error) {
    console.error("──────────── [addEmployee] INSERT FAILED ────────────");
    console.error("  message    :", error.message);
    console.error("  details    :", error.details);
    console.error("  hint       :", error.hint);
    console.error("  code       :", error.code);
    console.error("  HTTP status:", status, statusText);
    console.error("  payload    :", payload);
    console.error("────────────────────────────────────────────────────");
    throw new Error(
      `[addEmployee] Insert failed — ${error.message}` +
      (error.code    ? ` (code: ${error.code})`      : "") +
      (error.hint    ? ` | hint: ${error.hint}`       : "") +
      (error.details ? ` | details: ${error.details}` : ""),
    );
  }

  console.log("[addEmployee] succeeded, id:", (data as EmployeeRow).id);
  return mapEmployee(data as EmployeeRow);
}

// ─────────────────────────────────────────────────────────────
// UPDATE
// ─────────────────────────────────────────────────────────────

/**
 * Update any editable fields on an employee record.
 */
export async function updateEmployee(
  id: string,
  updates: Partial<Omit<Employee, "id" | "createdAt">>,
): Promise<void> {
  const partial: Record<string, unknown> = {};

  if (updates.employeeId       !== undefined) partial.employee_id       = updates.employeeId.trim();
  if (updates.fullName         !== undefined) partial.full_name         = updates.fullName.trim();
  if (updates.email            !== undefined) partial.email             = updates.email?.trim() || null;
  if (updates.phone            !== undefined) partial.phone             = updates.phone?.trim() || null;
  if (updates.photoUrl         !== undefined) partial.photo_url         = updates.photoUrl?.trim() || null;
  if (updates.bloodGroup       !== undefined) partial.blood_group       = updates.bloodGroup || null;
  if (updates.designation      !== undefined) partial.designation       = updates.designation;
  if (updates.canAccessApp     !== undefined) partial.can_access_app    = updates.canAccessApp;
  if (updates.appRole          !== undefined) partial.app_role          = updates.canAccessApp ? (updates.appRole ?? null) : null;
  if (updates.joiningDate      !== undefined) partial.joining_date      = updates.joiningDate || null;
  if (updates.emergencyContact !== undefined) partial.emergency_contact = updates.emergencyContact?.trim() || null;
  if (updates.address          !== undefined) partial.address           = updates.address?.trim() || null;
  if (updates.notes            !== undefined) partial.notes             = updates.notes?.trim() || null;
  if (updates.isActive         !== undefined) partial.is_active         = updates.isActive;

  console.log("[updateEmployee] id:", id, "| payload:", partial);

  const { error, status, statusText } = await supabase
    .from("employees")
    .update(partial)
    .eq("id", id);

  if (error) {
    console.error("──────────── [updateEmployee] UPDATE FAILED ────────────");
    console.error("  message    :", error.message);
    console.error("  details    :", error.details);
    console.error("  hint       :", error.hint);
    console.error("  code       :", error.code);
    console.error("  HTTP status:", status, statusText);
    console.error("  employee id:", id);
    console.error("────────────────────────────────────────────────────────");
    throw new Error(
      `[updateEmployee] Update failed — ${error.message}` +
      (error.code    ? ` (code: ${error.code})`      : "") +
      (error.hint    ? ` | hint: ${error.hint}`       : "") +
      (error.details ? ` | details: ${error.details}` : ""),
    );
  }

  console.log("[updateEmployee] succeeded for id:", id);
}

// ─────────────────────────────────────────────────────────────
// DELETE  (hard delete — use updateEmployee({isActive:false}) to deactivate)
// ─────────────────────────────────────────────────────────────

/**
 * Permanently delete an employee record.
 * For "leaving the company" use updateEmployee({ isActive: false }) instead.
 */
export async function deleteEmployee(id: string): Promise<void> {
  const { error, status, statusText } = await supabase
    .from("employees")
    .delete()
    .eq("id", id);

  if (error) {
    console.error("──────────── [deleteEmployee] DELETE FAILED ────────────");
    console.error("  message    :", error.message);
    console.error("  details    :", error.details);
    console.error("  hint       :", error.hint);
    console.error("  code       :", error.code);
    console.error("  HTTP status:", status, statusText);
    console.error("  employee id:", id);
    console.error("────────────────────────────────────────────────────────");
    throw new Error(
      `[deleteEmployee] Delete failed — ${error.message}` +
      (error.code    ? ` (code: ${error.code})`      : "") +
      (error.hint    ? ` | hint: ${error.hint}`       : "") +
      (error.details ? ` | details: ${error.details}` : ""),
    );
  }
}

// ─────────────────────────────────────────────────────────────
// PROFILE HELPERS
// ─────────────────────────────────────────────────────────────

/**
 * Fetch the employee record whose auth_user_id matches the logged-in
 * Supabase auth user.  Returns null when no linked record exists.
 */
export async function getEmployeeByAuthUserId(
  authUserId: string,
): Promise<Employee | null> {
  const { data, error } = await supabase
    .from("employees")
    .select("*")
    .eq("auth_user_id", authUserId)
    .maybeSingle();

  if (error) {
    console.error("──────────── [getEmployeeByAuthUserId] FAILED ────────────");
    console.error("  message:", error.message, "| code:", error.code);
    throw new Error(`[getEmployeeByAuthUserId] ${error.message}`);
  }

  return data ? mapEmployee(data as EmployeeRow) : null;
}

/**
 * Upload a profile photo to the "employee-photos" Storage bucket.
 * Overwrites any previous file for this employee.
 * Returns the public URL of the uploaded image.
 */
export async function uploadEmployeePhoto(
  employeeUuid: string,
  file: File,
): Promise<string> {
  const ext  = file.name.split(".").pop() ?? "jpg";
  const path = `${employeeUuid}/${Date.now()}.${ext}`;

  const { error: uploadError } = await supabase.storage
    .from("employee-photos")
    .upload(path, file, { upsert: true, contentType: file.type });

  if (uploadError) {
    console.error("──────────── [uploadEmployeePhoto] UPLOAD FAILED ────────────");
    console.error("  message:", uploadError.message);
    console.error("  path   :", path);
    console.error("─────────────────────────────────────────────────────────────");
    throw new Error(`[uploadEmployeePhoto] ${uploadError.message}`);
  }

  const { data } = supabase.storage
    .from("employee-photos")
    .getPublicUrl(path);

  return data.publicUrl;
}

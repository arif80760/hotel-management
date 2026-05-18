-- =============================================================
-- 2026-05-18-phase-e1-role-aware-rls.sql
-- Phase E1 — role-aware RLS: current_user_role() helper +
--            employees table policies.
--
-- EXECUTE MANUALLY in Supabase SQL Editor.
--
-- Context:
--   Phase D (B1→D4) locked the database to authenticated users only.
--   Phase E enforces the admin/staff role distinction at the RLS level.
--
-- employees table — why the split is not fully admin-only:
--   The self-service /profile page (accessible to both roles) reads and
--   writes the employee row linked by employees.auth_user_id = auth.uid():
--     • getEmployeeByAuthUserId() — SELECT WHERE auth_user_id = auth.uid()
--     • updateEmployee()          — UPDATE WHERE id = <own row>
--   If INSERT/DELETE were also open to staff, staff could create or
--   delete employee records. They cannot — those operations are admin-only.
--
--   Resulting split:
--     SELECT — admin: any row.  Staff: own row only (auth_user_id = uid).
--     INSERT — admin only.
--     UPDATE — admin: any row.  Staff: own row only (auth_user_id = uid).
--     DELETE — admin only.
--
-- current_user_role():
--   STABLE SECURITY DEFINER helper that reads the calling user's role
--   from public.profiles. SECURITY DEFINER is required because profiles
--   has RLS (Users can read own profile — USING (id = auth.uid())).
--   Without it the function executes as the caller's role and the RLS
--   guard on profiles blocks reads inside policy evaluation.
--   SET search_path prevents search-path injection.
--
-- This function becomes the standard pattern for all admin-only RLS
-- (future Accounts tables etc.) — use current_user_role() = 'admin'.
--
-- Post-migration verification:
--   -- Function exists:
--   SELECT proname FROM pg_proc WHERE proname = 'current_user_role';
--   -- Expected: 1 row.
--
--   -- Policies on employees:
--   SELECT policyname, cmd, qual
--   FROM   pg_policies
--   WHERE  schemaname = 'public' AND tablename = 'employees'
--   ORDER  BY cmd;
--   -- Expected: 4 rows, each with current_user_role() in qual.
-- =============================================================

BEGIN;

-- ── 1. current_user_role() helper ────────────────────────────

CREATE OR REPLACE FUNCTION public.current_user_role()
  RETURNS TEXT
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public
AS $$
  SELECT role FROM public.profiles WHERE id = auth.uid()
$$;

-- ── 2. Drop the 4 existing employees policies ─────────────────

DROP POLICY IF EXISTS "Authenticated can select employees" ON public.employees;
DROP POLICY IF EXISTS "Authenticated can insert employees" ON public.employees;
DROP POLICY IF EXISTS "Authenticated can update employees" ON public.employees;
DROP POLICY IF EXISTS "Authenticated can delete employees" ON public.employees;

-- ── 3. Recreate with role-aware conditions ────────────────────

-- SELECT: admin sees all rows; staff sees only their own linked record.
-- Serves both EmployeesClient (admin) and ProfileClient (both roles).
CREATE POLICY "Employees select — admin all, staff own row"
  ON public.employees FOR SELECT TO authenticated
  USING (
    current_user_role() = 'admin'
    OR auth_user_id = auth.uid()
  );

-- INSERT: admin only. Staff never create employee records.
CREATE POLICY "Employees insert — admin only"
  ON public.employees FOR INSERT TO authenticated
  WITH CHECK (current_user_role() = 'admin');

-- UPDATE: admin updates any row; staff updates their own row only.
-- Serves both EmployeesClient edits (admin) and ProfileClient saves (both).
CREATE POLICY "Employees update — admin all, staff own row"
  ON public.employees FOR UPDATE TO authenticated
  USING (
    current_user_role() = 'admin'
    OR auth_user_id = auth.uid()
  )
  WITH CHECK (
    current_user_role() = 'admin'
    OR auth_user_id = auth.uid()
  );

-- DELETE: admin only. No staff use case for deleting employee records.
CREATE POLICY "Employees delete — admin only"
  ON public.employees FOR DELETE TO authenticated
  USING (current_user_role() = 'admin');

COMMIT;

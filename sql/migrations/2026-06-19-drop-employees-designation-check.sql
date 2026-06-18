-- 2026-06-19-drop-employees-designation-check.sql
--
-- Removes the employees_designation_check CHECK constraint on employees.designation.
--
-- Why: designation is validated at the application layer via the DESIGNATIONS array
-- in services/employeesService.ts — the single source of truth that drives the
-- add/edit dropdown and the staff filter. The DB-level CHECK duplicated that list
-- and drifted out of sync: newly added roles (Laundry Boy, Security Guard, Chairman,
-- Managing Director, Director) typechecked and built fine but were rejected at INSERT
-- because the constraint still held the old whitelist. Dropping it makes designation
-- free TEXT again, with the dropdown as the sole guard, so future role additions need
-- only the frontend array (no paired SQL migration).
--
-- Safe: DROP CONSTRAINT only loosens validation; no existing row is touched.
-- Idempotent: IF EXISTS makes a re-run a no-op.

ALTER TABLE public.employees
  DROP CONSTRAINT IF EXISTS employees_designation_check;

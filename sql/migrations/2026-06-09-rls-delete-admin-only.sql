-- =============================================================
-- 2026-06-09-rls-delete-admin-only.sql
--
-- Restricts direct DELETE on bookings and booking_rooms to admins.
--
-- Background: RLS policies were wide-open ({authenticated} can do
-- anything). Direct DELETE is dangerous — any logged-in user could
-- wipe any booking. Direct INSERT/UPDATE are load-bearing: several
-- SECURITY INVOKER RPCs rely on RLS to gate their inserts/updates
-- for staff, so those stay open. Direct DELETE has no legitimate
-- path in the app (creation is via RPC, cancellation is a status
-- update, no flow deletes rows), so it's safe to lock down.
--
-- Also adds is_admin() helper (SECURITY DEFINER) so the policy can
-- check auth.uid() against profiles.role without tripping over
-- profiles' own RLS.
--
-- Notes:
--   * SELECT, INSERT, UPDATE remain open to authenticated (unchanged).
--   * SECURITY INVOKER RPCs (create_booking_with_rooms, etc) continue
--     to work — they run as the caller and their internal writes are
--     gated by RLS, but they don't delete, so the DELETE lock doesn't
--     affect them.
--   * Full role-based hardening (per-column grants, staff-specific
--     restrictions) remains a separate task; this is the safe
--     first tier.
-- =============================================================

-- Helper to check admin status (SECURITY DEFINER so it can read
-- profiles regardless of its own RLS).
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role = 'admin'
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated, service_role;

-- bookings: DELETE now admin-only
DROP POLICY IF EXISTS "Authenticated can delete bookings" ON public.bookings;
CREATE POLICY "Admins can delete bookings" ON public.bookings
  FOR DELETE TO authenticated
  USING (public.is_admin());

-- booking_rooms: DELETE now admin-only
DROP POLICY IF EXISTS "Authenticated can delete booking_rooms" ON public.booking_rooms;
CREATE POLICY "Admins can delete booking_rooms" ON public.booking_rooms
  FOR DELETE TO authenticated
  USING (public.is_admin());

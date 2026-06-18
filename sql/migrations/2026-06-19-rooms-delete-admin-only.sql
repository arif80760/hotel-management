-- 2026-06-19-rooms-delete-admin-only.sql
--
-- Restrict DELETE on public.rooms to admins.
--
-- Why: the existing "Authenticated can delete rooms" policy had qual = true, so any
-- logged-in staff member could delete a room. Every other structural/financial table
-- (bookings, booking_rooms, payments, loans, employees, account_transactions) already
-- gates DELETE behind admin. Rooms are referenced by bookings/booking_rooms, so an
-- accidental staff deletion would be disruptive. This brings rooms in line with that
-- least-privilege pattern. SELECT / INSERT / UPDATE on rooms are unchanged.

drop policy if exists "Authenticated can delete rooms" on public.rooms;

create policy "Admins can delete rooms"
  on public.rooms
  for delete
  using (is_admin());

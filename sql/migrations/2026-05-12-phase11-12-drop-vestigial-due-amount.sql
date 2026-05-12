-- ===========================================================================
-- Phase 11 #12: Drop vestigial bookings.due_amount column
-- File:    sql/migrations/2026-05-12-phase11-12-drop-vestigial-due-amount.sql
-- Date:    2026-05-12
--
-- Nature:
--   Column drop + view recreation.  No table data of value is lost:
--   due_amount has always been 0 by default and has never been written
--   by the application, triggers, or any RPC.  No schema additions.
--
-- Background:
--   Day 9 Batch 1 investigation confirmed that bookings.due_amount is
--   completely inert.  The column's own SQL comment (02-tables.sql
--   line 148) reads:
--
--     "VESTIGIAL: never read by app, never auto-updated. Candidate
--      for removal in future cleanup."
--
--   and its COMMENT ON COLUMN (02-tables.sql line 202) echoes:
--
--     "VESTIGIAL: never read by app layer, never auto-updated by any
--      trigger. Candidate for removal in future cleanup."
--
--   Full reference audit (Day 9 Batch 1 + Phase 11 #12 investigation):
--     sql/migrations/  — zero references
--     services/        — zero references
--     contexts/        — zero references
--     components/      — zero references
--     lib/             — one comment-only reference in mockData.ts
--                        ("dueAmount is derived at render via
--                        calcTrueDue() — not stored") confirming
--                        the column was intentionally never used
--     app/             — zero references to the DB column;
--                        BookingsClient.tsx uses a local JS variable
--                        `dueAmount` (camelCase) computed client-side
--                        via Math.max(0, grandTotal - amountPaidNum),
--                        entirely unrelated to bookings.due_amount
--
--   The only DB object referencing the column is the booking_summary
--   view (03-views.sql line 50: b.due_amount), which is dropped and
--   recreated without it in this migration.
--
-- Why Strategy B (explicit DROP VIEW → DROP COLUMN → CREATE VIEW)
-- over Strategy A (DROP COLUMN CASCADE):
--   CASCADE would silently sweep up any dependent views, including
--   view-on-view dependencies we might not know about at apply time.
--   Explicit DROP VIEW documents exactly what is being removed and
--   why.  Strategy B costs two extra lines; the explicitness is
--   worth it.  On a fresh DB both DROP IF EXISTS statements are
--   no-ops.
--
-- Schema files updated in the same commit as this migration:
--   sql/schema/02-tables.sql line 148  — column declaration removed
--   sql/schema/02-tables.sql line 202  — COMMENT ON COLUMN removed
--   sql/schema/03-views.sql  line 50   — b.due_amount line removed
--   A fresh DB rebuild after this commit will never create the column.
--   The DROP IF EXISTS statements in this migration become permanent
--   no-ops on fresh DBs.
--
-- Trigger interactions:
--   None.  due_amount does not appear in the OF clause of
--   trg_sync_payment_status (paid_amount, total_amount, status,
--   extra_charge_amount) nor in trg_sync_paid_amount (INSERT on
--   payments).  fn_sync_payment_status does not read or write
--   due_amount.  Dropping the column causes no trigger cascade.
--
-- Apply mode:
--   All sections are DDL — must be run via Supabase SQL Editor
--   (service role key returns 401 for DDL via PostgREST).
--   Single block — no multi-run requirement.
--   DROP IF EXISTS on both drop statements: safe no-op on fresh DBs.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- Section 1: Drop dependent view
--
-- booking_summary references b.due_amount in its SELECT list.
-- PostgreSQL will refuse to drop a column that a view depends on
-- unless the view is dropped first (or CASCADE is used — see header
-- for why we prefer explicit over CASCADE).
-- ---------------------------------------------------------------------------

DROP VIEW IF EXISTS public.booking_summary;


-- ---------------------------------------------------------------------------
-- Section 2: Drop the vestigial column
--
-- IF EXISTS is safe: on a fresh DB (where 02-tables.sql has already
-- been updated), the column will not exist and this is a no-op.
-- ---------------------------------------------------------------------------

ALTER TABLE public.bookings DROP COLUMN IF EXISTS due_amount;


-- ---------------------------------------------------------------------------
-- Section 3: Recreate booking_summary without due_amount
--
-- Identical to the previous definition (sql/schema/03-views.sql) with
-- exactly one line removed: b.due_amount (was line 50 of that file).
-- Every other column, alias, JOIN, and COMMENT is preserved verbatim.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW public.booking_summary AS
SELECT
  -- Booking core
  b.id,
  b.booking_ref,
  b.status,
  b.check_in_date,
  b.check_out_date,
  b.nights,
  b.total_guests,
  b.room_category_at_booking,

  -- Room details (current state)
  r.room_number,
  r.floor,
  r.category        AS room_category_current,
  r.status          AS room_status,
  r.price_per_night,

  -- Guest details (primary guest)
  g.name            AS guest_name,
  g.email           AS guest_email,
  g.phone           AS guest_phone,
  g.nationality     AS guest_nationality,
  g.vip             AS guest_vip,

  -- Financial summary
  b.total_amount,
  b.paid_amount,
  b.payment_status,

  -- Override
  b.override_checkout,
  b.override_reason,
  b.override_at,

  -- Lifecycle timestamps
  b.confirmed_at,
  b.checked_in_at,
  b.checked_out_at,
  b.cancelled_at,

  -- Audit timestamps
  b.created_at,
  b.updated_at

FROM public.bookings b
JOIN public.rooms  r ON r.id = b.room_id
JOIN public.guests g ON g.id = b.primary_guest_id;

COMMENT ON VIEW public.booking_summary IS
  'Denormalised booking list view — joins bookings, rooms, guests. '
  'Used by BookingsClient and RoomBoard. Does not include extra charges.';


-- ---------------------------------------------------------------------------
-- Section 4: Verification
--
-- pg_views and information_schema.columns are not reachable via
-- PostgREST.  Run both queries directly in the Supabase SQL Editor
-- after applying Sections 1–3.
--
-- 4a. Confirm the column is gone:
--
--   SELECT column_name
--   FROM information_schema.columns
--   WHERE table_schema = 'public'
--     AND table_name   = 'bookings'
--     AND column_name  = 'due_amount';
--
-- Expected: 0 rows.
-- If 1 row is returned, Section 2 did not execute correctly.
--
-- 4b. Confirm the view was recreated and no longer references due_amount:
--
--   SELECT definition
--   FROM pg_views
--   WHERE schemaname = 'public'
--     AND viewname   = 'booking_summary';
--
-- Expected: 1 row; the definition string must NOT contain 'due_amount'.
-- If 0 rows: Section 3 did not execute.
-- If 'due_amount' appears in the definition: Section 3 used the wrong
-- view body — drop and recreate manually.
-- ---------------------------------------------------------------------------


-- ===========================================================================
-- END OF MIGRATION
-- ===========================================================================

-- =============================================================
-- 2026-06-07-room-categories-rls.sql
-- Row Level Security for room_categories
-- (created in 2026-06-07-room-categories-table.sql).
--
-- Model (mirrors existing tables in 06-rls-policies.sql):
--   SELECT — any authenticated user. The room create/edit category
--            dropdown is used by all staff, so reads are not admin-gated.
--   INSERT / UPDATE — admin only, via current_user_role() = 'admin'
--            (matches the Accounts feature). UPDATE covers both renaming
--            and the is_active soft-retire toggle.
--   No DELETE policy — categories are retired with is_active = false,
--            never hard-deleted (rooms.category FK is ON DELETE RESTRICT).
--   anon — no policy, therefore no access (project-wide model).
--
-- Safely re-runnable: RLS enable and GRANTs are idempotent, and each
-- policy is dropped-if-exists before creation.
-- =============================================================

-- RLS was already enabled when the table was created ("Run and enable
-- RLS"); this keeps the migration self-contained and is a no-op if on.
ALTER TABLE public.room_categories ENABLE ROW LEVEL SECURITY;

-- Table-level grants. The RLS policies below are the real gate.
GRANT SELECT, INSERT, UPDATE ON public.room_categories TO authenticated;
GRANT ALL ON public.room_categories TO service_role;

-- SELECT — any authenticated user
DROP POLICY IF EXISTS "Room categories select — authenticated" ON public.room_categories;
CREATE POLICY "Room categories select — authenticated"
  ON public.room_categories FOR SELECT TO authenticated
  USING (true);

-- INSERT — admin only
DROP POLICY IF EXISTS "Room categories insert — admin only" ON public.room_categories;
CREATE POLICY "Room categories insert — admin only"
  ON public.room_categories FOR INSERT TO authenticated
  WITH CHECK (current_user_role() = 'admin');

-- UPDATE — admin only (rename + is_active toggle)
DROP POLICY IF EXISTS "Room categories update — admin only" ON public.room_categories;
CREATE POLICY "Room categories update — admin only"
  ON public.room_categories FOR UPDATE TO authenticated
  USING (current_user_role() = 'admin')
  WITH CHECK (current_user_role() = 'admin');

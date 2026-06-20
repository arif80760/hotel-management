-- 2026-06-20-activity-log-foundation.sql
-- Activity log — Phase 1 foundation: table, visibility helper, RLS, immutability.
-- Capture triggers are added in a follow-up migration, after column verification.

-- ── Table ──────────────────────────────────────────────────────────────────
create table if not exists public.activity_log (
  id           uuid        primary key default gen_random_uuid(),
  occurred_at  timestamptz not null    default now(),
  actor_id     uuid,                          -- auth.users id; null = system/service
  actor_name   text,                          -- snapshot of actor's name at log time
  action       text        not null,          -- e.g. 'booking.created','payment.recorded'
  entity_type  text,                          -- 'booking','payment','employee', ...
  entity_id    uuid,                          -- affected row id
  entity_label text,                          -- human label, e.g. 'BK-1090'
  summary      text        not null,          -- one-line human-readable description
  details      jsonb                          -- key fields (amount, method, status change)
);

create index if not exists idx_activity_log_occurred on public.activity_log (occurred_at desc);
create index if not exists idx_activity_log_actor    on public.activity_log (actor_id);
create index if not exists idx_activity_log_entity   on public.activity_log (entity_type, entity_id);
create index if not exists idx_activity_log_action   on public.activity_log (action);

-- ── Visibility: admins + Managers ──────────────────────────────────────────
-- profiles.role is only admin/staff, so "managers" are resolved via designation.
create or replace function public.can_view_activity_log()
returns boolean
language sql stable security definer set search_path = public as $$
  select
    public.current_user_role() = 'admin'
    or exists (
      select 1 from public.employees e
      where e.auth_user_id = auth.uid()
        and e.designation in ('Manager', 'General Manager')
    );
$$;

-- ── RLS: read for admins+managers; no client writes ────────────────────────
-- Writes come only from the SECURITY DEFINER capture trigger and the service-role
-- admin routes (both bypass RLS). No insert/update/delete policy => clients cannot
-- forge or alter log rows.
alter table public.activity_log enable row level security;

drop policy if exists "activity_log_select_admins_managers" on public.activity_log;
create policy "activity_log_select_admins_managers"
  on public.activity_log for select
  using ( public.can_view_activity_log() );

-- ── Immutability: append-only (even for admins / service-role) ──────────────
-- To ever purge logs (e.g. test-data cleanup), drop this trigger first, then re-add.
create or replace function public.fn_activity_log_immutable()
returns trigger language plpgsql as $$
begin
  raise exception 'activity_log is append-only — updates/deletes are not allowed';
end;
$$;

drop trigger if exists trg_activity_log_immutable on public.activity_log;
create trigger trg_activity_log_immutable
  before update or delete on public.activity_log
  for each row execute function public.fn_activity_log_immutable();

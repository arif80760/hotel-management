-- 2026-06-20-activity-log-capture-triggers.sql
--
-- Activity log — Phase 2: the capture trigger.
-- Depends on 2026-06-20-activity-log-foundation.sql (table + RLS + immutability).
--
-- ONE SECURITY DEFINER function, fn_capture_activity(), attached AFTER
-- INSERT/UPDATE/DELETE to: bookings, booking_rooms, payments, refunds,
-- account_transactions, employees, inventory_movements, day_closes.
--
-- HARD GUARANTEE: the entire body runs inside BEGIN ... EXCEPTION WHEN OTHERS
-- THEN RETURN NULL — a logging failure can NEVER abort the audited operation.
-- These are AFTER triggers, so the return value is ignored; we always RETURN NULL.
--
-- Only meaningful changes are logged (status transitions; skips updated_at-only
-- and trigger-synced churn like paid_amount/payment_status).
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.fn_capture_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id    uuid;
  v_actor_name  text;
  v_action      text;
  v_entity_type text;
  v_entity_id   uuid;
  v_entity_label text;
  v_summary     text;
  v_details     jsonb;
begin
  begin
    -- ── Actor snapshot ───────────────────────────────────────────────────
    v_actor_id := auth.uid();
    if v_actor_id is not null then
      select full_name into v_actor_name from public.profiles where id = v_actor_id;
      if v_actor_name is null then
        -- email fallback, guarded so an auth.users read issue can't lose the log
        begin
          select email into v_actor_name from auth.users where id = v_actor_id;
        exception when others then
          v_actor_name := null;
        end;
      end if;
    end if;
    v_actor_name := coalesce(v_actor_name, 'System');

    -- ════════════════════════════ BOOKINGS ══════════════════════════════
    if tg_table_name = 'bookings' then
      v_entity_type := 'booking';
      if tg_op = 'INSERT' then
        v_action := 'booking.created';
        v_entity_id := new.id; v_entity_label := new.booking_ref;
        v_summary := format('Created %s (%s, BDT %s)', new.booking_ref,
          coalesce((select name from public.guests where id = new.primary_guest_id), 'guest'),
          new.total_amount);
        v_details := jsonb_build_object('total_amount', new.total_amount, 'status', new.status, 'nights', new.nights);
      elsif tg_op = 'UPDATE' then
        if new.status is distinct from old.status then
          v_action := 'booking.' || new.status::text;
          v_entity_id := new.id; v_entity_label := new.booking_ref;
          v_summary := format('%s: %s → %s', new.booking_ref, old.status, new.status);
          v_details := jsonb_build_object('old', old.status, 'new', new.status);
        elsif ( new.total_amount               is distinct from old.total_amount
             or new.check_in_date              is distinct from old.check_in_date
             or new.check_out_date             is distinct from old.check_out_date
             or new.total_guests               is distinct from old.total_guests
             or new.additional_discount_amount is distinct from old.additional_discount_amount
             or new.extra_charge_amount        is distinct from old.extra_charge_amount ) then
          v_action := 'booking.updated';
          v_entity_id := new.id; v_entity_label := new.booking_ref;
          v_summary := format('Updated %s', new.booking_ref);
          v_details := jsonb_build_object('total_amount', new.total_amount);
        end if;
      elsif tg_op = 'DELETE' then
        v_action := 'booking.deleted';
        v_entity_id := old.id; v_entity_label := old.booking_ref;
        v_summary := format('Deleted %s', old.booking_ref);
        v_details := jsonb_build_object('total_amount', old.total_amount, 'status', old.status);
      end if;

    -- ══════════════════════════ BOOKING_ROOMS ═══════════════════════════
    elsif tg_table_name = 'booking_rooms' then
      v_entity_type := 'booking_room';
      if tg_op = 'UPDATE' and new.status is distinct from old.status then
        v_action := 'room.' || new.status::text;
        v_entity_id := new.id;
        v_entity_label := coalesce((select room_number from public.rooms where id = new.room_id), '?');
        v_summary := format('Room %s (%s): %s → %s',
          v_entity_label,
          coalesce((select booking_ref from public.bookings where id = new.booking_id), '?'),
          old.status, new.status);
        v_details := jsonb_build_object('old', old.status, 'new', new.status);
      end if;

    -- ════════════════════════════ PAYMENTS ══════════════════════════════
    elsif tg_table_name = 'payments' then
      v_entity_type := 'payment';
      if tg_op = 'INSERT' then
        v_action := 'payment.recorded'; v_entity_id := new.id;
        v_entity_label := coalesce((select booking_ref from public.bookings where id = new.booking_id), '?');
        v_summary := format('BDT %s via %s on %s', new.amount, new.method, v_entity_label);
        v_details := jsonb_build_object('amount', new.amount, 'method', new.method);
      elsif tg_op = 'DELETE' then
        v_action := 'payment.deleted'; v_entity_id := old.id;
        v_entity_label := coalesce((select booking_ref from public.bookings where id = old.booking_id), '?');
        v_summary := format('Deleted payment BDT %s on %s', old.amount, v_entity_label);
        v_details := jsonb_build_object('amount', old.amount, 'method', old.method);
      end if;

    -- ════════════════════════════ REFUNDS ═══════════════════════════════
    elsif tg_table_name = 'refunds' then
      v_entity_type := 'refund';
      if tg_op = 'INSERT' then
        v_action := 'refund.created'; v_entity_id := new.id;
        v_entity_label := coalesce((select booking_ref from public.bookings where id = new.booking_id), '?');
        v_summary := format('Refund BDT %s created on %s', new.amount, v_entity_label);
        v_details := jsonb_build_object('amount', new.amount, 'status', new.status);
      elsif tg_op = 'UPDATE' and new.status is distinct from old.status then
        v_action := 'refund.' || new.status;
        v_entity_id := new.id;
        v_entity_label := coalesce((select booking_ref from public.bookings where id = new.booking_id), '?');
        v_summary := format('Refund BDT %s %s on %s', new.amount, new.status, v_entity_label);
        v_details := jsonb_build_object('amount', new.amount, 'old', old.status, 'new', new.status);
      end if;

    -- ═══════════════════════ ACCOUNT_TRANSACTIONS ═══════════════════════
    elsif tg_table_name = 'account_transactions' then
      v_entity_type := 'cash';
      if tg_op = 'INSERT' then
        v_action := 'cash.' || new.type::text;
        v_entity_id := new.id;
        v_entity_label := coalesce(new.voucher_number, new.payee, new.type::text);
        v_summary := format('BDT %s %s', new.amount, replace(new.type::text, '_', ' '));
        v_details := jsonb_build_object('type', new.type, 'amount', new.amount);
      end if;

    -- ════════════════════════════ EMPLOYEES ═════════════════════════════
    elsif tg_table_name = 'employees' then
      v_entity_type := 'employee';
      -- Skip system/service-role changes — the admin routes log those themselves.
      if v_actor_id is null then
        return null;
      end if;
      if tg_op = 'INSERT' then
        v_action := 'employee.created'; v_entity_id := new.id; v_entity_label := new.full_name;
        v_summary := format('Added employee %s (%s)', new.full_name, new.designation);
        v_details := jsonb_build_object('designation', new.designation, 'is_active', new.is_active);
      elsif tg_op = 'UPDATE' then
        if new.is_active is distinct from old.is_active then
          v_action := case when new.is_active then 'employee.activated' else 'employee.deactivated' end;
          v_entity_id := new.id; v_entity_label := new.full_name;
          v_summary := format('%s %s', new.full_name, case when new.is_active then 'activated' else 'deactivated' end);
          v_details := jsonb_build_object('is_active', new.is_active);
        elsif new.designation is distinct from old.designation then
          v_action := 'employee.role_changed'; v_entity_id := new.id; v_entity_label := new.full_name;
          v_summary := format('%s: %s → %s', new.full_name, old.designation, new.designation);
          v_details := jsonb_build_object('old', old.designation, 'new', new.designation);
        elsif ( new.full_name is distinct from old.full_name
             or new.email     is distinct from old.email
             or new.phone     is distinct from old.phone
             or new.app_role  is distinct from old.app_role ) then
          v_action := 'employee.updated'; v_entity_id := new.id; v_entity_label := new.full_name;
          v_summary := format('Updated employee %s', new.full_name);
          v_details := jsonb_build_object('designation', new.designation);
        end if;
      elsif tg_op = 'DELETE' then
        v_action := 'employee.deleted'; v_entity_id := old.id; v_entity_label := old.full_name;
        v_summary := format('Deleted employee %s', old.full_name);
        v_details := jsonb_build_object('designation', old.designation);
      end if;

    -- ═══════════════════════ INVENTORY_MOVEMENTS ════════════════════════
    elsif tg_table_name = 'inventory_movements' then
      v_entity_type := 'inventory';
      if tg_op = 'INSERT' then
        v_action := 'inventory.' || new.type::text;
        v_entity_id := new.id;
        v_entity_label := coalesce((select name from public.inventory_items where id = new.item_id), '?');
        v_summary := format('%s: %s × %s', replace(new.type::text, '_', ' '), v_entity_label, new.quantity);
        v_details := jsonb_build_object('type', new.type, 'quantity', new.quantity);
      end if;

    -- ════════════════════════════ DAY_CLOSES ════════════════════════════
    elsif tg_table_name = 'day_closes' then
      v_entity_type := 'day_close';
      if tg_op = 'INSERT' then
        v_action := 'day.closed'; v_entity_id := new.id; v_entity_label := new.close_date::text;
        v_summary := format('Day closed for %s', new.close_date);
        v_details := jsonb_build_object('close_date', new.close_date, 'closing_balance', new.closing_balance);
      end if;
    end if;

    -- ── Write the log row (only when a meaningful action was set) ─────────
    if v_action is not null then
      insert into public.activity_log
        (actor_id, actor_name, action, entity_type, entity_id, entity_label, summary, details)
      values
        (v_actor_id, v_actor_name, v_action, v_entity_type, v_entity_id, v_entity_label, v_summary, v_details);
    end if;

    return null;
  exception when others then
    -- Logging must never break the audited write.
    return null;
  end;
end;
$$;

-- ── Attach to each audited table (AFTER, per-row) ───────────────────────────
drop trigger if exists trg_capture_activity on public.bookings;
create trigger trg_capture_activity after insert or update or delete on public.bookings
  for each row execute function public.fn_capture_activity();

drop trigger if exists trg_capture_activity on public.booking_rooms;
create trigger trg_capture_activity after insert or update or delete on public.booking_rooms
  for each row execute function public.fn_capture_activity();

drop trigger if exists trg_capture_activity on public.payments;
create trigger trg_capture_activity after insert or update or delete on public.payments
  for each row execute function public.fn_capture_activity();

drop trigger if exists trg_capture_activity on public.refunds;
create trigger trg_capture_activity after insert or update or delete on public.refunds
  for each row execute function public.fn_capture_activity();

drop trigger if exists trg_capture_activity on public.account_transactions;
create trigger trg_capture_activity after insert or update or delete on public.account_transactions
  for each row execute function public.fn_capture_activity();

drop trigger if exists trg_capture_activity on public.employees;
create trigger trg_capture_activity after insert or update or delete on public.employees
  for each row execute function public.fn_capture_activity();

drop trigger if exists trg_capture_activity on public.inventory_movements;
create trigger trg_capture_activity after insert or update or delete on public.inventory_movements
  for each row execute function public.fn_capture_activity();

drop trigger if exists trg_capture_activity on public.day_closes;
create trigger trg_capture_activity after insert or update or delete on public.day_closes
  for each row execute function public.fn_capture_activity();

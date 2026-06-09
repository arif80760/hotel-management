-- =============================================================
-- 2026-06-09-no-show-feature.sql
--
-- No-show booking lifecycle (DB side).
--
-- Captures two objects that were applied live during development and
-- are recorded here for repo reproducibility. Both are idempotent
-- (ADD VALUE IF NOT EXISTS / CREATE OR REPLACE), so re-running is safe.
--
--   1. A new booking_status enum value: 'no_show'.
--   2. mark_booking_no_show(p_booking_id) — flips a confirmed booking
--      and its confirmed rooms to 'no_show', keeps any amount paid
--      (deposit forfeited), and waives the remaining balance via the
--      additional_discount fields. Frees nothing physically — the room
--      board derives availability from booking status (a no_show room
--      reads Available), and the analytics RPCs exclude 'no_show'
--      (see 2026-06-09-no-show-exclude-from-analytics.sql).
--
-- ── IMPORTANT: enum value must be committed before it is USED ──
-- Postgres will not let a newly added enum value be used in the same
-- transaction that adds it. Applying this file statement-by-statement
-- in the Supabase SQL editor satisfies that (each statement is its own
-- transaction). An automated migration runner that wraps a file in a
-- single transaction must split this into two migrations: the ALTER
-- TYPE first, then the function. (CREATE OR REPLACE FUNCTION itself
-- only parses the plpgsql body lazily, but keeping them separate is
-- the safe, conventional approach.)
-- =============================================================

-- 1. Enum value ------------------------------------------------
ALTER TYPE public.booking_status ADD VALUE IF NOT EXISTS 'no_show';

-- 2. RPC -------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mark_booking_no_show(p_booking_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_status   public.booking_status;
  v_total    numeric;
  v_extra    numeric;
  v_discount numeric;
  v_paid     numeric;
  v_balance  numeric;
BEGIN
  SELECT status, total_amount,
         COALESCE(extra_charge_amount, 0),
         COALESCE(additional_discount_amount, 0),
         paid_amount
    INTO v_status, v_total, v_extra, v_discount, v_paid
  FROM public.bookings WHERE id = p_booking_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'booking % not found', p_booking_id;
  END IF;
  IF v_status <> 'confirmed' THEN
    RAISE EXCEPTION 'Only a confirmed booking can be marked no-show (current status: %).', v_status;
  END IF;

  UPDATE public.booking_rooms
  SET    status = 'no_show', updated_at = NOW()
  WHERE  booking_id = p_booking_id AND status = 'confirmed';

  v_balance := (v_total + v_extra) - v_discount - v_paid;
  IF v_balance > 0 THEN
    UPDATE public.bookings
    SET    additional_discount_amount = v_discount + v_balance,
           additional_discount_reason =
             CASE WHEN COALESCE(additional_discount_reason, '') = ''
                  THEN 'No-show: balance waived (deposit forfeited)'
                  ELSE additional_discount_reason || ' | No-show: balance waived (deposit forfeited)'
             END,
           additional_discount_by = auth.uid(),
           additional_discount_at = NOW()
    WHERE  id = p_booking_id;
  END IF;

  UPDATE public.bookings
  SET    status = 'no_show'
  WHERE  id = p_booking_id AND status IS DISTINCT FROM 'no_show';
END;
$function$;

GRANT EXECUTE ON FUNCTION public.mark_booking_no_show(uuid) TO authenticated, service_role;

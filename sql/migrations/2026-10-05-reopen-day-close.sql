-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-10-05 — Reopen Day: admin-only undo of the NEWEST day close.
-- RECORD OF LIVE STATE — applied by Arif in the Supabase SQL editor on
-- 2026-10-05 and probe-verified the same day.
--
-- Incident: a director accidentally closed 2026-10-05 at ~1:43 PM with zero
-- transactions recorded — until reopened, every entry made that day was
-- being carried forward to Oct 6 by the immutability trigger, splitting the
-- day's books across two dates. The Close Day button had NO confirmation
-- step at all (handleClose wired straight to onClick), and this was the
-- second accidental-close class (early closes were already a flagged
-- habit). The incident itself was fixed the same day with a guarded one-off
-- (DELETE of the Oct 5 snapshot, latest-only check, 0 carried rows to
-- restore at that point).
--
-- Reopen semantics:
--   • LATEST close only, hard-refused otherwise — reopening an older day
--     would unlock a historical span that later snapshots still chain off.
--   • day_closes is snapshot-only (close_date, opening/closing balance,
--     closed_by/at); the immutability trigger derives its lock from
--     MAX(close_date), so deleting the newest row moves the boundary back
--     with zero other writes.
--   • Rows the deleted close carried forward (carried_forward_from =
--     close_date AND txn_date = close_date + 1) are RESTORED: txn_date back
--     to the true date, marker cleared, the 'Carried forward — collected …'
--     note suffix stripped (our own format, exact strip). Without this the
--     books stay split one day over — the exact incident shape. Rows
--     carried by OLDER closes are untouched. Trigger-legal because the
--     restore runs after the DELETE moved the boundary back.
--   • Reason is mandatory and written to activity_log (action
--     'day_reopened') with the deleted snapshot's figures; trg_capture_activity
--     additionally auto-logs the DELETE row itself — two audit entries.
--
-- SECURITY DEFINER is deliberate (exception to the deny_refund INVOKER
-- preference): the reason entry must INSERT into activity_log, which has no
-- INSERT policy — only definer paths write it (same as fn_capture_activity).
-- The explicit is_admin() check replaces RLS, with the standing
-- service-context exemption (auth.uid() IS NULL: SQL editor / migrations),
-- mirroring trg_enforce_override_is_admin. The DELETE policy below is
-- defense-in-depth for any non-RPC path (day_closes previously had NO
-- UPDATE/DELETE policy = default-deny).
--
-- Client half (same batch): Close Day button now opens a confirmation
-- dialog (date, opening, net activity, closing, end-of-trading warning,
-- CHECKBOX acknowledgement gating the button, red callout when the day has
-- zero transactions); closed-day card gets an admin-only "Reopen day"
-- button with consequences + mandatory reason (dayCloseService.reopenDay).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE POLICY "Day close delete — admin only"
  ON public.day_closes FOR DELETE
  USING (is_admin());

CREATE OR REPLACE FUNCTION public.reopen_latest_day_close(p_close_date date, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_latest   date;
  v_restored int;
  v_row      public.day_closes%ROWTYPE;
  v_actor    uuid := auth.uid();
BEGIN
  IF v_actor IS NOT NULL AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'reopen_latest_day_close: only admins can reopen a day.';
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'reopen_latest_day_close: a reason is required — it is the record of why the close was undone.';
  END IF;

  SELECT MAX(close_date) INTO v_latest FROM public.day_closes;
  IF v_latest IS NULL THEN
    RAISE EXCEPTION 'reopen_latest_day_close: no day closes exist.';
  END IF;
  IF p_close_date IS DISTINCT FROM v_latest THEN
    RAISE EXCEPTION 'reopen_latest_day_close: only the LATEST close (%) can be reopened — got %. Reopening an older day would break the carry-forward chain.',
      v_latest, p_close_date;
  END IF;

  SELECT * INTO v_row FROM public.day_closes WHERE close_date = p_close_date FOR UPDATE;

  DELETE FROM public.day_closes WHERE close_date = p_close_date;

  -- Restore the rows THIS close carried forward (and only those).
  UPDATE public.account_transactions
  SET txn_date = carried_forward_from,
      carried_forward_from = NULL,
      note = NULLIF(regexp_replace(note, '( · )?Carried forward — collected .*$', ''), '')
  WHERE carried_forward_from = p_close_date
    AND txn_date = p_close_date + 1
    AND deleted_at IS NULL;
  GET DIAGNOSTICS v_restored = ROW_COUNT;

  INSERT INTO public.activity_log (actor_id, action, entity_type, entity_label, summary, details)
  VALUES (
    v_actor, 'day_reopened', 'day_close', p_close_date::text,
    'Day ' || p_close_date || ' reopened — ' || btrim(p_reason),
    jsonb_build_object(
      'close_date', p_close_date, 'reason', btrim(p_reason), 'restored_rows', v_restored,
      'opening_balance', v_row.opening_balance, 'closing_balance', v_row.closing_balance,
      'originally_closed_at', v_row.closed_at, 'originally_closed_by', v_row.closed_by
    )
  );

  RETURN jsonb_build_object('close_date', p_close_date, 'restored_rows', v_restored);
END;
$function$;

REVOKE ALL ON FUNCTION public.reopen_latest_day_close(date, text) FROM anon;

-- ─────────────────────────────────────────────────────────────────────────────
-- Verification (2026-10-05, ROLLBACK-wrapped): synthetic close of today →
-- an insert dated today was carry-forward-stamped to today+1 with the
-- annotation (observed live, first probe run); reopening the PREVIOUS
-- (non-latest) close refused with the LATEST message; reopening today
-- returned restored_rows = 1, moved the row back to today, cleared the
-- marker, stripped the note suffix exactly ('probe entry'), removed the
-- day_closes row, and wrote the 'day_reopened' activity entry. PASSED.
-- First probe run also demonstrated constraint integrity: a manual
-- revenue_in without category/payee was rejected by
-- chk_account_transactions_revenue_expense_integrity and the whole
-- transaction rolled back clean (probe switched to 'injection').
-- ─────────────────────────────────────────────────────────────────────────────

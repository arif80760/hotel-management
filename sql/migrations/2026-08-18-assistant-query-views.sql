-- =============================================================
-- 2026-08-18-assistant-query-views.sql
-- Assistant dynamic-query layer: rule-encoding views + read-only roles.
--
-- RECORD OF LIVE STATE — applied in the Supabase SQL editor on
-- 2026-08-18 ("Ran both sql with success" — Arif). Committed for
-- history; SQL below is VERBATIM what was applied.
--
-- DESIGN (approved 2026-08-18): the AI assistant gains a third layer —
-- a query_hotel_data tool that lets the model write a SELECT against
-- these views ONLY, executed through dedicated Postgres roles whose
-- grants (not the prompt) are the security boundary. The fixed tools
-- remain the fast path; this is the escape hatch for questions they
-- cannot express.
--
-- BUSINESS RULES ENCODED ONCE, IN THE VIEWS:
--   • soft-deletes (deleted_at) excluded everywhere
--   • is_test_data flags rows before live operation (2026-07-30)
--   • kind whitelist: operating / remuneration / adjustment split into
--     separate views; v_unclassified_expenses catches any FOURTH kind
--     loudly instead of letting it vanish
--   • refunds (expense_out + booking_payment_id) are their own view —
--     they net against revenue, never count as expenses
--   • central fund: payment_method comes from payments.method,
--     descriptive only — never to_account_id
--   • true due = total + extra_charge − additional_discount − paid
--     (early deduction already inside total — never subtracted again)
--   • room truth from booking_rooms (never bookings.room_id or
--     rooms.status); active rooms only; blocking whitelist
--     ('confirmed','checked_in'); cancelled/no-show never block
--
-- ROLES: assistant_ro (all views, admin questions) and
-- assistant_staff_ro (v_room_status + v_live_bookings only). NOLOGIN —
-- reached via the SECURITY DEFINER wrapper assistant_query() with
-- SET LOCAL ROLE (separate migration once applied). No table grants,
-- no writes, no function EXECUTE. statement_timeout 3s at role level
-- (and re-set per call in the wrapper, since SET LOCAL ROLE does not
-- trigger login-time role settings).
-- =============================================================

-- ── 1. Views ─────────────────────────────────────────────────

CREATE VIEW v_revenue AS
SELECT t.txn_date,
       t.amount,
       (t.booking_payment_id IS NOT NULL)          AS is_booking_payment,
       rc.name                                     AS manual_category,   -- null for booking payments
       p.method                                    AS payment_method,    -- descriptive only (central fund)
       (t.txn_date < DATE '2026-07-30')            AS is_test_data,
       t.note
FROM   account_transactions t
LEFT   JOIN revenue_categories rc ON rc.id = t.revenue_category_id
LEFT   JOIN payments p            ON p.id = t.booking_payment_id
WHERE  t.type = 'revenue_in' AND t.deleted_at IS NULL;

CREATE VIEW v_refunds AS
SELECT t.txn_date, t.amount,
       (t.txn_date < DATE '2026-07-30') AS is_test_data, t.note
FROM   account_transactions t
WHERE  t.type = 'expense_out' AND t.booking_payment_id IS NOT NULL
  AND  t.deleted_at IS NULL;

CREATE VIEW v_operating_expenses AS
SELECT t.txn_date, t.amount,
       COALESCE(ec.name, 'Uncategorised')          AS category,
       ei.name                                     AS item,
       COALESCE(e.full_name, t.payee)              AS paid_to,
       (t.txn_date < DATE '2026-07-30')            AS is_test_data,
       t.note
FROM   account_transactions t
LEFT   JOIN expense_categories ec ON ec.id = t.category_id
LEFT   JOIN expense_items ei      ON ei.id = t.expense_item_id
LEFT   JOIN employees e           ON e.id = t.employee_id
WHERE  t.type = 'expense_out' AND t.booking_payment_id IS NULL
  AND  t.deleted_at IS NULL
  AND  COALESCE(ec.kind, 'operating') = 'operating';

CREATE VIEW v_remuneration AS
SELECT t.txn_date, t.amount,
       COALESCE(e.full_name, t.payee)   AS recipient,
       e.designation,
       (t.txn_date < DATE '2026-07-30') AS is_test_data,
       t.note
FROM   account_transactions t
JOIN   expense_categories ec ON ec.id = t.category_id AND ec.kind = 'remuneration'
LEFT   JOIN employees e      ON e.id = t.employee_id
WHERE  t.type = 'expense_out' AND t.booking_payment_id IS NULL
  AND  t.deleted_at IS NULL;

CREATE VIEW v_adjustments AS
SELECT t.txn_date, t.amount, ec.name AS category,
       (t.txn_date < DATE '2026-07-30') AS is_test_data, t.note
FROM   account_transactions t
JOIN   expense_categories ec ON ec.id = t.category_id AND ec.kind = 'adjustment'
WHERE  t.type = 'expense_out' AND t.booking_payment_id IS NULL
  AND  t.deleted_at IS NULL;

CREATE VIEW v_unclassified_expenses AS
SELECT t.txn_date, t.amount, ec.name AS category, ec.kind, t.note
FROM   account_transactions t
JOIN   expense_categories ec ON ec.id = t.category_id
WHERE  t.type = 'expense_out' AND t.booking_payment_id IS NULL
  AND  t.deleted_at IS NULL
  AND  ec.kind NOT IN ('operating', 'remuneration', 'adjustment');

CREATE VIEW v_live_bookings AS
SELECT b.booking_ref, g.name AS guest, r.room_number,
       br.check_in_date, br.check_out_date, br.actual_checkout_date,
       br.nights, br.booking_rate, br.status AS room_status,
       b.status AS booking_status,
       b.total_amount, b.paid_amount,
       (COALESCE(b.total_amount,0) + COALESCE(b.extra_charge_amount,0)
        - COALESCE(b.additional_discount_amount,0)
        - COALESCE(b.paid_amount,0))            AS due,
       (b.created_at < TIMESTAMPTZ '2026-07-30 00:00:00+06') AS is_test_data
FROM   booking_rooms br
JOIN   bookings b ON b.id = br.booking_id
LEFT   JOIN guests g ON g.id = b.primary_guest_id
LEFT   JOIN rooms r  ON r.id = br.room_id;

CREATE VIEW v_room_status AS
SELECT r.room_number, rc.name AS category, rc.price,
       EXISTS (SELECT 1 FROM booking_rooms br
               WHERE br.room_id = r.id AND br.status = 'checked_in') AS occupied_now,
       (SELECT b.booking_ref FROM booking_rooms br JOIN bookings b ON b.id = br.booking_id
        WHERE br.room_id = r.id AND br.status = 'checked_in' LIMIT 1) AS current_booking
FROM   rooms r
JOIN   room_categories rc ON rc.slug = r.category
WHERE  r.is_active = true;

CREATE VIEW v_outstanding_dues AS
SELECT booking_ref, guest, room_number, check_in_date, check_out_date,
       booking_status, due, is_test_data
FROM   v_live_bookings
WHERE  booking_status IN ('confirmed', 'checked_in') AND due > 0.01;

-- ── 2. Roles + grants (the security boundary) ────────────────

CREATE ROLE assistant_ro       NOLOGIN;
CREATE ROLE assistant_staff_ro NOLOGIN;
GRANT USAGE ON SCHEMA public TO assistant_ro, assistant_staff_ro;
GRANT SELECT ON v_revenue, v_refunds, v_operating_expenses, v_remuneration,
               v_adjustments, v_unclassified_expenses, v_live_bookings,
               v_room_status, v_outstanding_dues            TO assistant_ro;
GRANT SELECT ON v_room_status, v_live_bookings              TO assistant_staff_ro;
ALTER ROLE assistant_ro       SET statement_timeout = '3s';
ALTER ROLE assistant_staff_ro SET statement_timeout = '3s';

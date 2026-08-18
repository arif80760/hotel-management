// app/api/assistant/queryTool.ts
//
// ─── query_hotel_data — VIEW-BACKED DYNAMIC QUERY (SERVER-ONLY) ──────────────
//
// The escape hatch alongside the fixed tools (design approved 2026-08-18):
// the model writes ONE SELECT against the v_* views recorded in
// sql/migrations/2026-08-18-assistant-query-views.sql. The views encode the
// business rules once; the SECURITY BOUNDARY is Postgres grants, not this
// code and not the prompt:
//
//   • The connection logs in as assistant_login — a NOINHERIT role with NO
//     privileges of its own. Until SET LOCAL ROLE runs, the session can
//     read nothing. Nothing in this executor may weaken that.
//   • Per query: BEGIN → SET LOCAL ROLE assistant_ro|assistant_staff_ro
//     (chosen from the SERVER-SIDE profile in route.ts — never from any
//     client-supplied value; the identifier comes from a fixed map here,
//     never string input) → SET LOCAL statement_timeout='3s' → the model's
//     SELECT inside a LIMIT envelope → COMMIT (SET LOCAL dies with the
//     transaction either way).
//   • Code-level guards (belt to the grants' braces): SELECT-only prefix,
//     NO semicolons anywhere — node-postgres's simple query protocol would
//     happily run "SELECT 1; RESET ROLE; SELECT …" as three statements, so
//     multi-statement input is rejected outright, never trusted.
//   • Rows hard-capped at 200 with an explicit truncated flag (fetches 201
//     to detect the cap) so a truncated sum is never presented as a total.
//
// Serverless connection handling: one tiny module-level Pool (max 3, short
// idle timeout, allowExitOnIdle) against the Supabase TRANSACTION pooler —
// the free-tier pooler has limited slots (15/60 seen in use 2026-08-18), so
// clients are always release()d in finally and idle sockets close fast.
// ─────────────────────────────────────────────────────────────────────────────

import { Pool } from "pg";

export type QueryRole = "assistant_ro" | "assistant_staff_ro";

// Fixed identifier map — the SET ROLE target is never built from input.
const ROLE_SQL: Record<QueryRole, string> = {
  assistant_ro: "SET LOCAL ROLE assistant_ro",
  assistant_staff_ro: "SET LOCAL ROLE assistant_staff_ro",
};

const ROW_CAP = 200;
const MAX_SQL_LENGTH = 4000;

// ── Pool (module singleton; survives warm lambda reuse) ──────────────────────
const g = globalThis as typeof globalThis & { _assistantPool?: Pool };

function getPool(): Pool {
  if (g._assistantPool) return g._assistantPool;
  const url = process.env.ASSISTANT_DB_URL;
  if (!url) {
    throw new Error(
      "ASSISTANT_DB_URL is not set — the dynamic query tool is not configured on this server.",
    );
  }
  g._assistantPool = new Pool({
    connectionString: url,
    max: 3,                       // free-tier pooler slots are scarce
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 8_000,
    allowExitOnIdle: true,
    ssl: { rejectUnauthorized: false },   // Supabase pooler TLS
  });
  return g._assistantPool;
}

// ── Guards (enforced BEFORE the SQL touches a connection) ────────────────────

/** Throws with a model-readable message when the SQL is not a single SELECT. */
function assertSingleSelect(sql: string): string {
  const trimmed = sql.trim().replace(/;\s*$/, "");   // tolerate one trailing ';'
  if (!trimmed) throw new Error("Empty SQL.");
  if (trimmed.length > MAX_SQL_LENGTH) {
    throw new Error(`SQL too long (${trimmed.length} chars; max ${MAX_SQL_LENGTH}).`);
  }
  if (!/^select\b/i.test(trimmed)) {
    throw new Error("Only a SELECT statement is allowed (start the query with SELECT).");
  }
  if (trimmed.includes(";")) {
    // Rejects multi-statement strings outright — including semicolons inside
    // literals (rare in analytics SQL; rewrite without them).
    throw new Error("A single statement only — remove every ';' from the query.");
  }
  return trimmed;
}

// ── Executor ────────────────────────────────────────────────────────────────

export async function runHotelQuery(
  role: QueryRole,
  rawSql: string,
): Promise<{
  sql: string;
  rows: unknown[];
  row_count: number;
  truncated: boolean;
  meta: { executed_as: QueryRole; row_cap: number; note: string };
}> {
  const sql = assertSingleSelect(rawSql);
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(ROLE_SQL[role]);
    await client.query("SET LOCAL statement_timeout = '3s'");
    // +1 row over the cap to detect truncation; inner ORDER BY/LIMIT stay valid.
    const wrapped =
      `SELECT COALESCE(jsonb_agg(t), '[]'::jsonb) AS rows ` +
      `FROM (SELECT * FROM (${sql}) q LIMIT ${ROW_CAP + 1}) t`;
    const result = await client.query(wrapped);
    await client.query("COMMIT");

    const all = (result.rows[0]?.rows ?? []) as unknown[];
    const truncated = all.length > ROW_CAP;
    const rows = truncated ? all.slice(0, ROW_CAP) : all;
    return {
      sql,
      rows,
      row_count: rows.length,
      truncated,
      meta: {
        executed_as: role,
        row_cap: ROW_CAP,
        note: truncated
          ? `Result truncated at ${ROW_CAP} rows — aggregate (GROUP BY / SUM) or add a WHERE instead of listing; do NOT present these rows as a complete total.`
          : "Complete result.",
      },
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    // Surface the real Postgres error (message + SQLSTATE) so the model can
    // correct its SQL on the single permitted retry.
    const pgErr = err as { message?: string; code?: string };
    throw new Error(
      `SQL error${pgErr.code ? ` [${pgErr.code}]` : ""}: ${pgErr.message ?? String(err)}`,
    );
  } finally {
    client.release();
  }
}

// ── Tool schemas (view catalog lives in the description) ─────────────────────

const COMMON_RULES =
  "Rules already encoded in the views: soft-deleted rows are excluded; is_test_data=true marks rows " +
  "from before live operation began (2026-07-30) — filter is_test_data = false unless the user explicitly " +
  "asks about test data, and SAY SO when a range includes it. Write ONE PostgreSQL SELECT — no semicolons, " +
  "no writes, nothing but the views listed here (table access is denied at the database level). " +
  `Results are capped at 200 rows (a truncated flag tells you) — aggregate rather than list. ` +
  "Prefer the named tools when one answers the question; use this only when they cannot.";

const STAFF_CATALOG =
  "Views available to you:\n" +
  "- v_room_status(room_number, category, price, occupied_now boolean, current_booking): active rooms only; " +
  "occupancy derived from bookings, not the physical room column.\n" +
  "- v_live_bookings(booking_ref, guest, room_number, check_in_date, check_out_date, actual_checkout_date, " +
  "nights, booking_rate, room_status, booking_status, total_amount, paid_amount, due, is_test_data): one row per " +
  "booking-room; statuses are lowercase ('confirmed','checked_in','checked_out','checked_out_early','cancelled','no_show'); " +
  "due is the true outstanding balance (already accounts for extras, discounts and early-departure deductions).";

const ADMIN_CATALOG =
  "Views available to you:\n" +
  "- v_revenue(txn_date, amount, is_booking_payment boolean, manual_category, payment_method, is_test_data, note): " +
  "every revenue receipt. payment_method is DESCRIPTIVE only — all revenue lands in Cash in Hand (central fund). " +
  "Refunds are NOT netted here; net revenue = v_revenue minus v_refunds.\n" +
  "- v_refunds(txn_date, amount, is_test_data, note): refund payouts — net these against revenue; they are never expenses.\n" +
  "- v_operating_expenses(txn_date, amount, category, item, paid_to, is_test_data, note): operating-kind costs only.\n" +
  "- v_remuneration(txn_date, amount, recipient, designation, is_test_data, note): director payments — appropriation of " +
  "profit, NOT an expense; never add to operating.\n" +
  "- v_adjustments(txn_date, amount, category, is_test_data, note): corrections (test-data write-offs) — belong in NO total.\n" +
  "- v_unclassified_expenses(txn_date, amount, category, kind, note): rows with an unknown kind — normally empty; " +
  "if non-empty, flag it loudly.\n" +
  "- v_live_bookings(booking_ref, guest, room_number, check_in_date, check_out_date, actual_checkout_date, nights, " +
  "booking_rate, room_status, booking_status, total_amount, paid_amount, due, is_test_data): one row per booking-room; " +
  "lowercase statuses; due = true outstanding balance.\n" +
  "- v_room_status(room_number, category, price, occupied_now, current_booking): active rooms, booking-derived occupancy.\n" +
  "- v_outstanding_dues(booking_ref, guest, room_number, check_in_date, check_out_date, booking_status, due, is_test_data): " +
  "active bookings with due > 0.";

function queryToolSchema(catalog: string) {
  return {
    name: "query_hotel_data",
    description:
      `Run a custom read-only SQL SELECT against the hotel's curated views — the escape hatch for questions ` +
      `no other tool can answer (custom groupings, averages, cross-view joins, unusual filters). ${COMMON_RULES}\n\n${catalog}`,
    strict: true,
    input_schema: {
      type: "object" as const,
      properties: {
        sql: { type: "string", description: "One PostgreSQL SELECT statement against the listed views. No semicolons." },
      },
      required: ["sql"],
      additionalProperties: false,
    },
  };
}

export const QUERY_TOOL_ADMIN = queryToolSchema(ADMIN_CATALOG);
export const QUERY_TOOL_STAFF = queryToolSchema(STAFF_CATALOG);

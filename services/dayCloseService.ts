// services/dayCloseService.ts
//
// ─── DAY-CLOSE SERVICE ───────────────────────────────────────────────────────
//
// Reads + writes for the day-close mechanism.
// Spec: docs/architecture/accounts.md §11 / §14
//
// ─── SCHEMA (migrated 2026-05-24 — sql/migrations/2026-05-24-day-close.sql) ──
//
//   -- day_closes: one row per closed day. close_date UNIQUE, Cash in Hand
//   --   only. opening_balance and closing_balance NUMERIC(12,2). closed_by
//   --   nullable (NULL only on the bootstrap seed row). RLS enabled with
//   --   SELECT + INSERT policies for authenticated; no UPDATE/DELETE.
//
//   -- Immutability trigger on account_transactions: blocks writes where
//   --   txn_date <= MAX(day_closes.close_date). Enforced at the DB level.
//
// This service exposes the Path B (MVP) surface:
//   getDayCloseStatus()   — last-closed date, missed-days backlog, opening for today
//   getMissedDays()       — ISO dates between last-closed+1 and today-1 (exclusive)
//   closeDay(closeDate)   — close today; refuses if backlog exists or date <> today
//
// Catch-up UI (closing a backlog day with its own review screen) is NOT
// implemented in Path B. getMissedDays exists so the UI can render a banner.
//
// Bootstrap: the migration seeded 2026-05-23 with closing_balance =
// current Cash in Hand at apply time. Today (2026-05-24) is the first
// user-facing close.
//
// Known caveat (deferred): todayIso() uses the JS Date in the local zone,
// while the DB immutability trigger uses Postgres current_date. On a server
// in UTC+6 (Bangladesh), these align except at the UTC midnight boundary.
// Practical risk is low — closes happen in evenings, well inside the
// aligned window. A future refactor should route "what is today" through
// Postgres for total consistency.
//
// ─────────────────────────────────────────────────────────────────────────────

import { supabase } from "@/lib/supabase";
import { ACCOUNT_IDS } from "@/services/accountsService";

// ─────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────

export type DayClose = {
  id:              string;
  closeDate:       string;       // "YYYY-MM-DD"
  openingBalance:  number;
  closingBalance:  number;
  closedBy:        string | null;
  closedAt:        string;       // ISO timestamp
};

export type DayCloseStatus = {
  lastClosedDate:       string;       // "YYYY-MM-DD"
  missedDays:           string[];     // each "YYYY-MM-DD", oldest first
  canCloseToday:        boolean;      // true iff missedDays.length === 0 and today > lastClosed
  todaysOpeningBalance: number;       // = lastClosed.closing_balance
};

export type CloseDayResult =
  | { ok: true;  row: DayClose }
  | { ok: false; reason: "backlog" | "wrong_date" | "not_authenticated" | "already_closed" | "db_error"; message: string };

// ─────────────────────────────────────────────────────────────
// HELPERS — date math (ISO YYYY-MM-DD strings, no timezone games)
// ─────────────────────────────────────────────────────────────

// Today's date as YYYY-MM-DD in the local zone.
function todayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Add days to a YYYY-MM-DD string, return YYYY-MM-DD.
// Positive n moves forward, negative backward. UTC arithmetic to avoid DST.
function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + n);
  const yy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

// Strict string comparison works for YYYY-MM-DD (lexicographic == chronological).
function isoLte(a: string, b: string): boolean { return a <= b; }

// ─────────────────────────────────────────────────────────────
// ROW MAPPING — snake_case from DB → camelCase in TS
// ─────────────────────────────────────────────────────────────

type DayCloseRow = {
  id:                string;
  close_date:        string;
  opening_balance:   string | number;
  closing_balance:   string | number;
  closed_by:         string | null;
  closed_at:         string;
};

function mapDayClose(r: DayCloseRow): DayClose {
  return {
    id:             r.id,
    closeDate:      r.close_date,
    openingBalance: typeof r.opening_balance === "string" ? parseFloat(r.opening_balance) : r.opening_balance,
    closingBalance: typeof r.closing_balance === "string" ? parseFloat(r.closing_balance) : r.closing_balance,
    closedBy:       r.closed_by,
    closedAt:       r.closed_at,
  };
}

// ─────────────────────────────────────────────────────────────
// QUERIES
// ─────────────────────────────────────────────────────────────

/**
 * Returns the day-close status:
 *   - lastClosedDate: most recent close_date in day_closes
 *   - missedDays: ISO dates between lastClosed+1 and today-1 (exclusive of today)
 *   - canCloseToday: true iff missedDays is empty AND today is strictly after lastClosed
 *   - todaysOpeningBalance: closing_balance of the lastClosedDate row
 *
 * Assumes day_closes is non-empty (the migration seeded a bootstrap row).
 * If it is empty, throws — that's a bootstrap failure, not a runtime
 * condition to recover from.
 */
export async function getDayCloseStatus(): Promise<DayCloseStatus> {
  const { data, error } = await supabase
    .from("day_closes")
    .select("*")
    .order("close_date", { ascending: false })
    .limit(1)
    .single();

  if (error || !data) {
    throw new Error(`getDayCloseStatus: day_closes is empty or unreadable (${error?.message ?? "no data"}). Bootstrap row missing?`);
  }

  const lastClose = mapDayClose(data as DayCloseRow);
  const today = todayIso();

  // Build missedDays: every date strictly between lastClosedDate and today.
  const missedDays: string[] = [];
  let cursor = addDays(lastClose.closeDate, 1);
  while (isoLte(cursor, addDays(today, -1))) {
    missedDays.push(cursor);
    cursor = addDays(cursor, 1);
  }

  return {
    lastClosedDate:       lastClose.closeDate,
    missedDays,
    canCloseToday:        missedDays.length === 0 && !isoLte(today, lastClose.closeDate),
    todaysOpeningBalance: lastClose.closingBalance,
  };
}

/**
 * Returns ISO dates between lastClosed+1 and today-1 (exclusive of today),
 * oldest first. Empty array if no backlog.
 *
 * Convenience wrapper around getDayCloseStatus for the UI banner.
 */
export async function getMissedDays(): Promise<string[]> {
  const status = await getDayCloseStatus();
  return status.missedDays;
}

// ─────────────────────────────────────────────────────────────
// MUTATIONS
// ─────────────────────────────────────────────────────────────

/**
 * Close a day. Path B (MVP): only "Close Today" is allowed.
 *
 *  - Refuses if closeDate is not today.
 *  - Refuses if backlog exists (must close oldest-first per §11.3, but
 *    the UI for that ships next shift).
 *  - Refuses if today is already closed.
 *  - Computes opening_balance from prior close's closing_balance.
 *  - Computes closing_balance = opening + today's Cash in Hand net delta.
 *  - Inserts the row with closed_by from the auth session.
 */
export async function closeDay(closeDate: string): Promise<CloseDayResult> {
  // 1. Date guard: only today.
  const today = todayIso();
  if (closeDate !== today) {
    return {
      ok: false,
      reason: "wrong_date",
      message: `closeDay: only today (${today}) can be closed in this version. Got: ${closeDate}.`,
    };
  }

  // 2. Auth: need a user id for closed_by.
  const { data: userResult, error: userError } = await supabase.auth.getUser();
  if (userError || !userResult?.user) {
    return {
      ok: false,
      reason: "not_authenticated",
      message: `closeDay: no authenticated user (${userError?.message ?? "user is null"}).`,
    };
  }
  const userId = userResult.user.id;

  // 3. Status: backlog and already-closed checks.
  const status = await getDayCloseStatus();
  if (status.lastClosedDate === closeDate) {
    return { ok: false, reason: "already_closed", message: `closeDay: ${closeDate} is already closed.` };
  }
  if (status.missedDays.length > 0) {
    return {
      ok: false,
      reason: "backlog",
      message: `closeDay: cannot close ${closeDate} — ${status.missedDays.length} day(s) before it are still unclosed. Close oldest-first.`,
    };
  }

  // 4. Compute closing + INSERT — delegated to shared helper.
  return _performClose(closeDate, status.todaysOpeningBalance, userId);
}

// ─────────────────────────────────────────────────────────────
// SHARED CLOSE LOGIC — used by both closeDay() and closePastDay().
//
// Given a date, its opening balance (chain-preserved from prior close),
// and the user id of the closer, this:
//   - reads all Cash in Hand transactions on that date
//   - computes the net delta (in-out)
//   - inserts the day_closes row
//   - returns the success/error CloseDayResult
//
// All auth/ordering/already-closed guards live in the public callers.
// This function does no validation beyond what the DB enforces.
// ─────────────────────────────────────────────────────────────

async function _performClose(
  closeDate: string,
  opening: number,
  userId: string,
): Promise<CloseDayResult> {
  // 1. Sum Cash in Hand net delta on closeDate. Exclude soft-deleted rows
  // — they don't represent real money movement and must not contribute to
  // the closing balance. This filter is critical: without it, deleting a
  // row after close would produce a chain inconsistency.
  const { data: txnRows, error: txnError } = await supabase
    .from("account_transactions")
    .select("amount, from_account_id, to_account_id")
    .eq("txn_date", closeDate)
    .is("deleted_at", null);

  if (txnError) {
    return {
      ok: false,
      reason: "db_error",
      message: `_performClose: failed to read transactions for ${closeDate} (${txnError.message}).`,
    };
  }

  const cashId = ACCOUNT_IDS.cash;
  let netDelta = 0;
  for (const r of (txnRows ?? []) as Array<{ amount: string | number; from_account_id: string | null; to_account_id: string | null }>) {
    const amt = typeof r.amount === "string" ? parseFloat(r.amount) : r.amount;
    if (r.to_account_id   === cashId) netDelta += amt;
    if (r.from_account_id === cashId) netDelta -= amt;
  }

  const closing = +(opening + netDelta).toFixed(2);   // NUMERIC(12,2) parity

  // 2. Insert.
  const { data: insertedRow, error: insertError } = await supabase
    .from("day_closes")
    .insert({
      close_date:      closeDate,
      opening_balance: opening,
      closing_balance: closing,
      closed_by:       userId,
    })
    .select("*")
    .single();

  if (insertError || !insertedRow) {
    return {
      ok: false,
      reason: "db_error",
      message: `_performClose: insert failed for ${closeDate} (${insertError?.message ?? "no row returned"}).`,
    };
  }

  return { ok: true, row: mapDayClose(insertedRow as DayCloseRow) };
}


// ─────────────────────────────────────────────────────────────
// CATCH-UP — closing past missed days.
//
// Oldest-first enforced at the service level. closePastDay() refuses
// any date that is not exactly missedDays[0]. This keeps the chain
// strictly contiguous: each day's opening = prior day's closing.
//
// Closing balance for a past day is computed the same way as today:
// opening + that day's Cash in Hand net delta. The immutability trigger
// won't fire on the INSERT because day_closes itself is not gated by
// the trigger (the trigger is on account_transactions only).
// ─────────────────────────────────────────────────────────────

/**
 * Close a specific past (missed) day. Must be the OLDEST missed day —
 * see lockedordering policy. Anything else is refused at service level,
 * regardless of UI state.
 *
 *   - Refuses if closeDate is today (use closeDay for that).
 *   - Refuses if closeDate is not in current missedDays.
 *   - Refuses if closeDate is not the oldest entry in missedDays.
 *   - Refuses if not authenticated.
 *   - Computes opening from the close just prior (missedDays[0] is always
 *     preceded by a closed day in this model — that's what makes it the
 *     oldest *missed* day).
 *   - Delegates to _performClose for the compute + INSERT.
 */
export async function closePastDay(closeDate: string): Promise<CloseDayResult> {
  const today = todayIso();

  // 1. Not-today guard.
  if (closeDate === today) {
    return {
      ok: false,
      reason: "wrong_date",
      message: `closePastDay: ${closeDate} is today — use closeDay() instead.`,
    };
  }

  // 2. Auth.
  const { data: userResult, error: userError } = await supabase.auth.getUser();
  if (userError || !userResult?.user) {
    return {
      ok: false,
      reason: "not_authenticated",
      message: `closePastDay: no authenticated user (${userError?.message ?? "user is null"}).`,
    };
  }
  const userId = userResult.user.id;

  // 3. Status + ordering.
  const status = await getDayCloseStatus();
  if (status.missedDays.length === 0) {
    return {
      ok: false,
      reason: "wrong_date",
      message: `closePastDay: no missed days currently — nothing to catch up.`,
    };
  }
  if (status.missedDays[0] !== closeDate) {
    return {
      ok: false,
      reason: "wrong_date",
      message: `closePastDay: ${closeDate} is not the oldest missed day. Oldest is ${status.missedDays[0]} — close that first.`,
    };
  }

  // 4. Opening for this day = prior day's close. Since closeDate is
  //    missedDays[0], the day before it is by definition the most
  //    recently closed day. So opening = status.lastClosedDate's closing
  //    = todaysOpeningBalance (which we already have).
  const opening = status.todaysOpeningBalance;

  // 5. Delegate to shared helper.
  return _performClose(closeDate, opening, userId);
}


// ─────────────────────────────────────────────────────────────
// CATCH-UP — review data for the catch-up card.
//
// The Close Day card needs to render: opening, list of Cash in Hand
// transactions, computed closing preview. For today, the card pulls
// those from already-loaded state. For a past day, the card needs to
// fetch them. This function bundles that fetch.
// ─────────────────────────────────────────────────────────────

export type PastDayActivity = {
  closeDate:       string;
  opening:         number;
  netDelta:        number;
  closingPreview:  number;
  transactions:    Array<{
    id:             string;
    type:           string;
    amount:         number;
    fromAccountId:  string | null;
    toAccountId:    string | null;
    note:           string | null;
  }>;
};

/**
 * Returns the review data for a single missed day: opening balance,
 * list of Cash in Hand transactions on that date, and the closing
 * preview that would result from closing it now.
 *
 * Does NOT check ordering — caller responsible for showing the right
 * day. The service-level ordering enforcement happens at closePastDay()
 * time.
 *
 *   - Refuses if closeDate is today.
 *   - Refuses if closeDate is already closed.
 *   - Returns transactions oldest-first within the day (by created_at).
 */
export async function getPastDayActivity(closeDate: string): Promise<PastDayActivity> {
  const today = todayIso();
  if (closeDate === today) {
    throw new Error(`getPastDayActivity: ${closeDate} is today — not a past day.`);
  }

  // Confirm it's actually missed (not already closed). Cheap sanity check.
  const status = await getDayCloseStatus();
  if (!status.missedDays.includes(closeDate)) {
    throw new Error(`getPastDayActivity: ${closeDate} is not in current missed-days list. (Already closed, or future.)`);
  }

  // Opening = prior day's closing. Since closeDate is in missedDays,
  // the close just before missedDays[0] is lastClosedDate. But if
  // closeDate is missedDays[N] for N>0, we need the closing of
  // missedDays[N-1] — which doesn't exist yet (it's also missed).
  // In the oldest-first model, the UI only ever calls this for
  // missedDays[0], so we can use lastClosedDate's closing.
  // Guard: refuse if not oldest.
  if (status.missedDays[0] !== closeDate) {
    throw new Error(`getPastDayActivity: ${closeDate} is not the oldest missed day. Oldest is ${status.missedDays[0]}.`);
  }

  const opening = status.todaysOpeningBalance;

  // Fetch this day's transactions touching Cash in Hand.
  const cashId = ACCOUNT_IDS.cash;
  const { data: txnRows, error: txnError } = await supabase
    .from("account_transactions")
    .select("id, type, amount, from_account_id, to_account_id, note")
    .eq("txn_date", closeDate)
    .or(`from_account_id.eq.${cashId},to_account_id.eq.${cashId}`)
    .is("deleted_at", null)
    .order("created_at", { ascending: true });

  if (txnError) {
    throw new Error(`getPastDayActivity: failed to read transactions for ${closeDate} (${txnError.message}).`);
  }

  let netDelta = 0;
  const transactions = (txnRows ?? []).map((r: { id: string; type: string; amount: string | number; from_account_id: string | null; to_account_id: string | null; note: string | null }) => {
    const amt = typeof r.amount === "string" ? parseFloat(r.amount) : r.amount;
    if (r.to_account_id   === cashId) netDelta += amt;
    if (r.from_account_id === cashId) netDelta -= amt;
    return {
      id:            r.id,
      type:          r.type,
      amount:        amt,
      fromAccountId: r.from_account_id,
      toAccountId:   r.to_account_id,
      note:          r.note,
    };
  });

  const closingPreview = +(opening + netDelta).toFixed(2);

  return {
    closeDate,
    opening,
    netDelta,
    closingPreview,
    transactions,
  };
}

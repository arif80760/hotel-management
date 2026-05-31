// services/revenueService.ts
//
// ─── REVENUE SERVICE ─────────────────────────────────────────────────────────
//
// Reads + writes for user-recorded revenue_in rows on account_transactions.
// Spec: docs/architecture/accounts.md §7 (Categories).
//
// Mirror of expensesService.ts (Day 21 Phase 4C) with these differences:
//   - No voucher_number generation (vouchers are outbound; a rent receipt
//     would be a separate artifact, deferred to Phase R-D).
//   - to_account_id is user-picked (not hardcoded). All four buckets are
//     valid revenue destinations: Cash in Hand, Bank, bKash, Nagad.
//   - from_account_id is NULL (Stage 1's chk_txn_accounts enforces this for
//     revenue_in type).
//   - No employee_id linkage. Revenue goes straight into a bucket; there's
//     no "staff member who received it on behalf of the hotel" concept.
//   - payee is REQUIRED (the tenant/source name). Different semantic from
//     expense's optional payee. Phase R-A CHECK enforces NOT NULL on
//     revenue_in user rows.
//
// ─── SCHEMA TARGETS ──────────────────────────────────────────────────────────
//
//   account_transactions row for user revenue:
//     type                = 'revenue_in'
//     txn_date            = user-picked
//     amount              = user-picked, > 0
//     to_account_id       = user-picked bucket UUID
//     from_account_id     = NULL
//     revenue_category_id = user-picked from revenue_categories
//     payee               = tenant/source name (free text)
//     note                = optional free text
//     booking_payment_id  = NULL (booking-derived rows are a separate code
//                           path created by fn_sync_account_transactions —
//                           not via this service)
//     voucher_number      = NULL
//     employee_id         = NULL
//     category_id         = NULL  (this column is for EXPENSE categories
//                           per Day 21 Phase 4A; revenue uses the new
//                           revenue_category_id column)
//
// Phase R-A's chk_account_transactions_revenue_expense_integrity branch C
// enforces revenue_category_id + payee NOT NULL on user revenue rows.
//
// Returns flat data (FK IDs, no joined names). The UI resolves names via
// lookup maps from getRevenueCategories + getAccounts. This matches the
// Day 21 lesson on flat selects — avoids PostgREST nested-join typing
// issues.
//
// ─────────────────────────────────────────────────────────────────────────────

import { supabase } from "@/lib/supabase";

// ─────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────

export type Revenue = {
  id:                  string;
  txnDate:             string;     // "YYYY-MM-DD"
  amount:              number;
  toAccountId:         string;     // bucket UUID
  revenueCategoryId:   string;
  payee:               string;     // tenant/source name
  note:                string | null;
  createdAt:           string;
  createdBy:           string | null;
};

// Input for creating a new revenue. The form constructs this; the service
// validates and inserts.
export type NewRevenue = {
  txnDate:           string;        // "YYYY-MM-DD"
  amount:            number;        // positive
  toAccountId:       string;        // bucket UUID
  revenueCategoryId: string;        // FK to revenue_categories
  payee:             string;        // required
  note?:             string;
};

export type RevenueFilters = {
  fromDate?: string;
  toDate?:   string;
};

// ─────────────────────────────────────────────────────────────
// READ
// ─────────────────────────────────────────────────────────────

/**
 * List user-recorded revenue (type=revenue_in AND booking_payment_id IS NULL),
 * newest first.
 */
export async function getRevenues(filters: RevenueFilters = {}): Promise<Revenue[]> {
  let query = supabase
    .from("account_transactions")
    .select("id, txn_date, amount, to_account_id, revenue_category_id, payee, note, created_at, created_by")
    .eq("type", "revenue_in")
    .is("booking_payment_id", null)
    .is("deleted_at", null)
    .order("txn_date", { ascending: false })
    .order("created_at", { ascending: false });

  if (filters.fromDate) query = query.gte("txn_date", filters.fromDate);
  if (filters.toDate)   query = query.lte("txn_date", filters.toDate);

  const { data, error } = await query;

  if (error) {
    console.error("──────────── [getRevenues] FAILED ────────────");
    console.error("  message:", error.message, "| code:", error.code);
    throw new Error(`[getRevenues] ${error.message}`);
  }

  type Row = {
    id: string;
    txn_date: string;
    amount: string | number;
    to_account_id: string;
    revenue_category_id: string | null;
    payee: string | null;
    note: string | null;
    created_at: string;
    created_by: string | null;
  };

  return ((data ?? []) as Row[]).map((r) => ({
    id:                r.id,
    txnDate:           r.txn_date,
    amount:            typeof r.amount === "string" ? parseFloat(r.amount) : r.amount,
    toAccountId:       r.to_account_id,
    revenueCategoryId: r.revenue_category_id ?? "",
    payee:             r.payee ?? "",
    note:              r.note,
    createdAt:         r.created_at,
    createdBy:         r.created_by,
  }));
}

/**
 * Returns distinct payee values from prior revenue rows, for free-text
 * autocomplete (tenant names recur, rent is monthly).
 */
export async function getDistinctRevenuePayees(): Promise<string[]> {
  const { data, error } = await supabase
    .from("account_transactions")
    .select("payee")
    .eq("type", "revenue_in")
    .is("booking_payment_id", null)
    .not("payee", "is", null)
    .is("deleted_at", null);

  if (error) {
    console.error("──────────── [getDistinctRevenuePayees] FAILED ────────────");
    console.error("  message:", error.message, "| code:", error.code);
    throw new Error(`[getDistinctRevenuePayees] ${error.message}`);
  }

  const seen = new Set<string>();
  for (const row of (data ?? []) as Array<{ payee: string | null }>) {
    if (row.payee) seen.add(row.payee);
  }
  return Array.from(seen).sort((a, b) => a.localeCompare(b));
}

/**
 * Fetch a single revenue row by ID. Returns null if not found, not a
 * user-recorded revenue_in, or soft-deleted. Used by the future receipt
 * page (Phase R-D).
 */
export async function getRevenueById(id: string): Promise<Revenue | null> {
  const { data, error } = await supabase
    .from("account_transactions")
    .select("id, type, txn_date, amount, to_account_id, revenue_category_id, payee, note, booking_payment_id, created_at, created_by, deleted_at")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    console.error("──────────── [getRevenueById] FAILED ────────────");
    console.error("  message:", error.message, "| code:", error.code);
    throw new Error(`[getRevenueById] ${error.message}`);
  }

  if (!data) return null;
  if (data.type !== "revenue_in") return null;
  if (data.booking_payment_id !== null) return null;
  if (data.deleted_at !== null) return null;

  return {
    id:                data.id,
    txnDate:           data.txn_date,
    amount:            typeof data.amount === "string" ? parseFloat(data.amount) : data.amount,
    toAccountId:       data.to_account_id,
    revenueCategoryId: data.revenue_category_id ?? "",
    payee:             data.payee ?? "",
    note:              data.note,
    createdAt:         data.created_at,
    createdBy:         data.created_by,
  };
}

// ─────────────────────────────────────────────────────────────
// WRITE
// ─────────────────────────────────────────────────────────────

/**
 * Create a new user revenue. Validates required fields, inserts the
 * row, returns the new Revenue.
 *
 * Throws on validation failure or DB error. The DB-level CHECK
 * (chk_account_transactions_revenue_expense_integrity, branch C)
 * provides the final safety net.
 */
export async function createRevenue(input: NewRevenue): Promise<Revenue> {
  // ── Validate ─────────────────────────────────────────────
  if (!input.txnDate) throw new Error("[createRevenue] txnDate is required.");
  if (!(input.amount > 0)) throw new Error("[createRevenue] amount must be positive.");
  if (!input.toAccountId) throw new Error("[createRevenue] toAccountId is required.");
  if (!input.revenueCategoryId) throw new Error("[createRevenue] revenueCategoryId is required.");
  if (!input.payee?.trim()) throw new Error("[createRevenue] payee is required.");

  // ── Auth lookup for created_by ───────────────────────────
  const { data: authData } = await supabase.auth.getUser();
  const createdBy = authData?.user?.id ?? null;

  // ── Build payload ────────────────────────────────────────
  const payload = {
    type:                  "revenue_in" as const,
    txn_date:              input.txnDate,
    amount:                input.amount,
    from_account_id:       null,
    to_account_id:         input.toAccountId,
    revenue_category_id:   input.revenueCategoryId,
    payee:                 input.payee.trim(),
    note:                  input.note?.trim() || null,
    created_by:            createdBy,
  };

  // ── Insert ───────────────────────────────────────────────
  const { data, error } = await supabase
    .from("account_transactions")
    .insert(payload)
    .select("id, txn_date, amount, to_account_id, revenue_category_id, payee, note, created_at, created_by")
    .single();

  if (error || !data) {
    console.error("──────────── [createRevenue] INSERT FAILED ────────────");
    console.error("  message:", error?.message, "| code:", error?.code, "| details:", error?.details, "| hint:", error?.hint);
    throw new Error(`[createRevenue] ${error?.message ?? "no row returned"}`);
  }

  const r = data as {
    id: string;
    txn_date: string;
    amount: string | number;
    to_account_id: string;
    revenue_category_id: string;
    payee: string;
    note: string | null;
    created_at: string;
    created_by: string | null;
  };

  return {
    id:                r.id,
    txnDate:           r.txn_date,
    amount:            typeof r.amount === "string" ? parseFloat(r.amount) : r.amount,
    toAccountId:       r.to_account_id,
    revenueCategoryId: r.revenue_category_id,
    payee:             r.payee,
    note:              r.note,
    createdAt:         r.created_at,
    createdBy:         r.created_by,
  };
}

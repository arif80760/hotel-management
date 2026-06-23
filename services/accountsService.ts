// services/accountsService.ts
//
// ─── ACCOUNTS SERVICE ────────────────────────────────────────────────────────
//
// Reads + writes for the Accounts feature (daybook).
// Spec: docs/architecture/accounts.md
//
// ─── SCHEMA (already migrated — Stage 1 + Stage 2) ───────────────────────────
//
//   -- accounts: the four fixed money buckets (Stage 1, fixed UUIDs)
//   --   Cash in Hand a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11 is_spendable=true
//   --   Bank         b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22
//   --   bKash        c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33
//   --   Nagad        d0eebc99-9c0b-4ef8-bb6d-6bb9bd380a44
//
//   -- account_transactions (Stage 1): one row per money movement.
//   --   amount always positive; direction via from_account_id/to_account_id.
//   --   chk_txn_accounts CHECK enforces valid from/to per type.
//
//   -- account_balances (Stage 2 view): one row per bucket with computed
//   --   balance = sum(inflows) - sum(outflows). security_invoker=true.
//
// This service exposes the Stage 2 + Stage 2.5 surface:
//   getAccounts()       — the four buckets
//   getBalances()       — the four buckets with computed balance
//   getTransactions()   — transaction rows, optional date range filter
//   createTransaction() — insert a 'transfer' or 'injection' ONLY
//   updateTransaction() — edit a manual row; refuses rows with booking_payment_id set
//   deleteTransaction() — hard delete a manual row; same guard
//
// Manual entry is deliberately limited to 'transfer' and 'injection'.
// revenue_in / expense_out / loan_received / loan_repayment get their
// own dedicated feature stages later.
//
// ─────────────────────────────────────────────────────────────────────────────

import { supabase } from "@/lib/supabase";

// ─────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────

// Fixed bucket UUIDs (Stage 1). Stable references — never name-lookup.
export const ACCOUNT_IDS = {
  cash:  "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
  bank:  "b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22",
  bkash: "c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33",
  nagad: "d0eebc99-9c0b-4ef8-bb6d-6bb9bd380a44",
} as const;

// Full enum exists in the DB; Stage 2 manual entry uses only these two.
export type ManualTxnType = "transfer" | "injection";

// All six DB enum values — for typing rows read back from the table.
export type AccountTxnType =
  | "revenue_in"
  | "expense_out"
  | "transfer"
  | "injection"
  | "loan_received"
  | "loan_repayment";

export type Account = {
  id:          string;
  name:        string;
  isSpendable: boolean;
};

export type AccountBalance = {
  accountId:   string;
  name:        string;
  isSpendable: boolean;
  balance:     number;
};

export type AccountTransaction = {
  id:                string;
  txnDate:           string;          // "YYYY-MM-DD"
  type:              AccountTxnType;
  amount:            number;
  fromAccountId:     string | null;
  toAccountId:       string | null;
  note:              string | null;
  bookingPaymentId:  string | null;   // FK to payments.id; non-null means auto-generated
  categoryId:        string | null;   // FK to expense_categories; set on user expense_out rows
  revenueCategoryId: string | null;   // FK to revenue_categories; set on user revenue_in rows
  createdBy:         string | null;   // auth.users(id) of the recorder
  createdAt:         string;
  editedAt:          string | null;   // ISO timestamp of most recent edit; null if never edited
  editedBy:          string | null;   // auth.users(id) of most recent editor; null if never edited
  deletedAt:         string | null;   // ISO timestamp of soft delete; null if live (filtered out of reads)
  deletedBy:         string | null;   // auth.users(id) of soft-deleter; null if live
  lenderName:        string | null;   // joined from loans.lender_name via loan_id FK; null when no linked loan
};

// Input for a manual daybook entry (transfer or injection only).
export type NewManualTransaction = {
  type:          ManualTxnType;
  txnDate:       string;             // "YYYY-MM-DD"
  amount:        number;             // positive
  fromAccountId: string | null;      // required for transfer; null for injection
  toAccountId:   string | null;      // required for both
  note:          string | null;
};

export type TransactionFilters = {
  fromDate?:       string;                 // inclusive "YYYY-MM-DD"
  toDate?:         string;                 // inclusive "YYYY-MM-DD"
  // When true, include soft-deleted rows in the result. Defaults to false:
  // getTransactions filters them out so the cashbook never accidentally shows
  // a deleted row in operational views. Set true only for audit/forensic views.
  includeDeleted?: boolean;
};

// ─────────────────────────────────────────────────────────────
// RAW ROW TYPES
// ─────────────────────────────────────────────────────────────

type AccountRow = {
  id:            string;
  name:          string;
  is_spendable:  boolean;
};

type AccountBalanceRow = {
  account_id:    string;
  name:          string;
  is_spendable:  boolean;
  balance:       number;
};

type AccountTransactionRow = {
  id:                 string;
  txn_date:           string;
  type:               string;
  amount:             number;
  from_account_id:    string | null;
  to_account_id:      string | null;
  note:               string | null;
  booking_payment_id: string | null;
  // Present only in getTransactions (select extended to include category cols).
  category_id?:         string | null;
  revenue_category_id?: string | null;
  created_by:         string | null;
  created_at:         string;
  edited_at:          string | null;
  edited_by:          string | null;
  deleted_at:         string | null;
  deleted_by:         string | null;
  // Embedded relation — present only in getTransactions (which selects loans(lender_name)).
  // Supabase/PostgREST returns an array even for a to-one FK; take index [0].
  loans:              { lender_name: string }[] | null;
};

// ─────────────────────────────────────────────────────────────
// MAPPING HELPERS
// ─────────────────────────────────────────────────────────────

function mapAccount(row: AccountRow): Account {
  return {
    id:          row.id,
    name:        row.name,
    isSpendable: row.is_spendable,
  };
}

function mapBalance(row: AccountBalanceRow): AccountBalance {
  return {
    accountId:   row.account_id,
    name:        row.name,
    isSpendable: row.is_spendable,
    balance:     Number(row.balance),
  };
}

function mapTransaction(row: AccountTransactionRow): AccountTransaction {
  return {
    id:                row.id,
    txnDate:           row.txn_date,
    type:              row.type as AccountTxnType,
    amount:            Number(row.amount),
    fromAccountId:     row.from_account_id,
    toAccountId:       row.to_account_id,
    note:              row.note,
    bookingPaymentId:  row.booking_payment_id,
    categoryId:        row.category_id ?? null,
    revenueCategoryId: row.revenue_category_id ?? null,
    createdBy:         row.created_by,
    createdAt:         row.created_at,
    editedAt:          row.edited_at,
    editedBy:          row.edited_by,
    deletedAt:         row.deleted_at,
    deletedBy:         row.deleted_by,
    lenderName:        row.loans?.[0]?.lender_name ?? null,
  };
}

// ─────────────────────────────────────────────────────────────
// READ
// ─────────────────────────────────────────────────────────────

/**
 * Fetch the four money buckets, ordered by name.
 */
export async function getAccounts(): Promise<Account[]> {
  const { data, error } = await supabase
    .from("accounts")
    .select("id, name, is_spendable")
    .order("name");

  if (error) {
    console.error("──────────── [getAccounts] FAILED ────────────");
    console.error("  message:", error.message, "| code:", error.code);
    throw new Error(`[getAccounts] ${error.message}`);
  }

  return (data as AccountRow[]).map(mapAccount);
}

/**
 * Fetch the four buckets with computed balances, ordered by name.
 */
export async function getBalances(): Promise<AccountBalance[]> {
  const { data, error } = await supabase
    .from("account_balances")
    .select("account_id, name, is_spendable, balance")
    .order("name");

  if (error) {
    console.error("──────────── [getBalances] FAILED ────────────");
    console.error("  message:", error.message, "| code:", error.code);
    throw new Error(`[getBalances] ${error.message}`);
  }

  return (data as AccountBalanceRow[]).map(mapBalance);
}

/**
 * Fetch transactions, newest first, with an optional inclusive date range.
 */
export async function getTransactions(
  filters: TransactionFilters = {},
): Promise<AccountTransaction[]> {
  let query = supabase
    .from("account_transactions")
    .select("id, txn_date, type, amount, from_account_id, to_account_id, note, booking_payment_id, category_id, revenue_category_id, created_by, created_at, edited_at, edited_by, deleted_at, deleted_by, loans(lender_name)")
    .order("txn_date", { ascending: false })
    .order("created_at", { ascending: false });

  // Soft-deleted rows are invisible by default. Audit/forensic views can opt
  // in via filters.includeDeleted = true.
  if (!filters.includeDeleted) query = query.is("deleted_at", null);

  if (filters.fromDate) query = query.gte("txn_date", filters.fromDate);
  if (filters.toDate)   query = query.lte("txn_date", filters.toDate);

  const { data, error } = await query;

  if (error) {
    console.error("──────────── [getTransactions] FAILED ────────────");
    console.error("  message:", error.message, "| code:", error.code);
    throw new Error(`[getTransactions] ${error.message}`);
  }

  return (data as AccountTransactionRow[]).map(mapTransaction);
}

// ─────────────────────────────────────────────────────────────
// CREATE  (manual daybook entry — 'transfer' or 'injection' ONLY)
// ─────────────────────────────────────────────────────────────

/**
 * Insert a manual daybook transaction. Stage 2 supports only
 * 'transfer' and 'injection'. Validation mirrors the DB
 * chk_txn_accounts constraint so the DB is never the first defense:
 *   transfer  — needs from + to, and they must differ
 *   injection — needs to, must NOT have from
 * Amount must be a positive number.
 */
export async function createTransaction(
  input: NewManualTransaction,
): Promise<AccountTransaction> {
  // ── client-side validation (mirrors chk_txn_accounts) ──
  if (input.type !== "transfer" && input.type !== "injection") {
    throw new Error(
      `[createTransaction] Unsupported type '${input.type}' — ` +
      `Stage 2 manual entry allows only 'transfer' or 'injection'.`,
    );
  }
  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    throw new Error("[createTransaction] Amount must be a positive number.");
  }
  if (!input.txnDate) {
    throw new Error("[createTransaction] A transaction date is required.");
  }

  if (input.type === "transfer") {
    if (!input.fromAccountId || !input.toAccountId) {
      throw new Error("[createTransaction] A transfer needs both a source and a destination bucket.");
    }
    if (input.fromAccountId === input.toAccountId) {
      throw new Error("[createTransaction] A transfer's source and destination must be different buckets.");
    }
  }

  if (input.type === "injection") {
    if (!input.toAccountId) {
      throw new Error("[createTransaction] An injection needs a destination bucket.");
    }
    if (input.fromAccountId) {
      throw new Error("[createTransaction] An injection must not have a source bucket.");
    }
  }

  // Record who entered this transaction (account_transactions.created_by).
  const { data: authData } = await supabase.auth.getUser();
  const createdBy = authData.user?.id ?? null;

  const payload = {
    txn_date:        input.txnDate,
    type:            input.type,
    amount:          input.amount,
    from_account_id: input.type === "injection" ? null : input.fromAccountId,
    to_account_id:   input.toAccountId,
    note:            input.note?.trim() || null,
    created_by:      createdBy,
  };

  console.log("[createTransaction] payload:", payload);

  const { data, error, status, statusText } = await supabase
    .from("account_transactions")
    .insert(payload)
    .select("id, txn_date, type, amount, from_account_id, to_account_id, note, booking_payment_id, created_by, created_at, edited_at, edited_by, deleted_at, deleted_by")
    .single();

  if (error) {
    console.error("──────────── [createTransaction] INSERT FAILED ────────────");
    console.error("  message    :", error.message);
    console.error("  details    :", error.details);
    console.error("  hint       :", error.hint);
    console.error("  code       :", error.code);
    console.error("  HTTP status:", status, statusText);
    console.error("  payload    :", payload);
    console.error("────────────────────────────────────────────────────────────");
    throw new Error(
      `[createTransaction] Insert failed — ${error.message}` +
      (error.code    ? ` (code: ${error.code})`      : "") +
      (error.hint    ? ` | hint: ${error.hint}`       : "") +
      (error.details ? ` | details: ${error.details}` : ""),
    );
  }

  console.log("[createTransaction] succeeded, id:", (data as AccountTransactionRow).id);
  return mapTransaction(data as AccountTransactionRow);
}

// ─────────────────────────────────────────────────────────────
// UPDATE  (manual daybook entry — 'transfer' or 'injection' ONLY)
// ─────────────────────────────────────────────────────────────

/**
 * Update an existing manual daybook transaction. Stage 2 supports
 * only 'transfer' and 'injection'. Same validation as createTransaction,
 * plus a server-side guard refusing edits to rows linked to a payment
 * (booking_payment_id is non-null). Those rows are auto-generated by
 * the booking-payment integration and the daybook is read-only on them.
 */
export async function updateTransaction(
  id:    string,
  input: NewManualTransaction,
): Promise<AccountTransaction> {
  // ── client-side validation (mirrors createTransaction) ──
  if (input.type !== "transfer" && input.type !== "injection") {
    throw new Error(
      `[updateTransaction] Unsupported type '${input.type}' — ` +
      `Stage 2 manual entry allows only 'transfer' or 'injection'.`,
    );
  }
  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    throw new Error("[updateTransaction] Amount must be a positive number.");
  }
  if (!input.txnDate) {
    throw new Error("[updateTransaction] A transaction date is required.");
  }

  if (input.type === "transfer") {
    if (!input.fromAccountId || !input.toAccountId) {
      throw new Error("[updateTransaction] A transfer needs both a source and a destination bucket.");
    }
    if (input.fromAccountId === input.toAccountId) {
      throw new Error("[updateTransaction] A transfer's source and destination must be different buckets.");
    }
  }

  if (input.type === "injection") {
    if (!input.toAccountId) {
      throw new Error("[updateTransaction] An injection needs a destination bucket.");
    }
    if (input.fromAccountId) {
      throw new Error("[updateTransaction] An injection must not have a source bucket.");
    }
  }

  // ── Manual-row guard ──
  // Fetch first so we can refuse cleanly if this row is auto-generated.
  // (Auto-rows have booking_payment_id set; we don't allow editing them
  // from the daybook — the fix lives in the source booking/payment.)
  const { data: existing, error: fetchErr } = await supabase
    .from("account_transactions")
    .select("id, booking_payment_id")
    .eq("id", id)
    .single();

  if (fetchErr) {
    console.error("──────────── [updateTransaction] FETCH FAILED ────────────");
    console.error("  message:", fetchErr.message, "| code:", fetchErr.code);
    throw new Error(`[updateTransaction] ${fetchErr.message}`);
  }
  if (existing.booking_payment_id !== null) {
    throw new Error(
      "[updateTransaction] This transaction is linked to a booking payment and cannot be edited from the daybook. " +
      "Edit the source booking payment instead.",
    );
  }

  // ── Audit: who is editing? Same pattern as createTransaction.
  //    Fails open — if auth is unavailable, edited_by stays null
  //    rather than blocking the edit entirely.
  const { data: editAuth } = await supabase.auth.getUser();
  const editedBy = editAuth?.user?.id ?? null;

  // ── Build payload — note: created_by is NOT updated on edit;
  //    the original recorder remains the row's attributed owner.
  //    edited_at / edited_by ARE updated each edit (overwriting any
  //    prior edit's stamps — most-recent-edit semantics, not history).
  const payload = {
    txn_date:        input.txnDate,
    type:            input.type,
    amount:          input.amount,
    from_account_id: input.type === "injection" ? null : input.fromAccountId,
    to_account_id:   input.toAccountId,
    note:            input.note?.trim() || null,
    edited_at:       new Date().toISOString(),
    edited_by:       editedBy,
  };

  console.log("[updateTransaction] id:", id, "| payload:", payload);

  const { data, error, status, statusText } = await supabase
    .from("account_transactions")
    .update(payload)
    .eq("id", id)
    .select("id, txn_date, type, amount, from_account_id, to_account_id, note, booking_payment_id, created_by, created_at, edited_at, edited_by, deleted_at, deleted_by")
    .single();

  if (error) {
    console.error("──────────── [updateTransaction] UPDATE FAILED ────────────");
    console.error("  message    :", error.message);
    console.error("  details    :", error.details);
    console.error("  hint       :", error.hint);
    console.error("  code       :", error.code);
    console.error("  HTTP status:", status, statusText);
    console.error("  id         :", id);
    console.error("  payload    :", payload);
    console.error("────────────────────────────────────────────────────────────");
    throw new Error(
      `[updateTransaction] Update failed — ${error.message}` +
      (error.code    ? ` (code: ${error.code})`      : "") +
      (error.hint    ? ` | hint: ${error.hint}`       : "") +
      (error.details ? ` | details: ${error.details}` : ""),
    );
  }

  console.log("[updateTransaction] succeeded, id:", id);
  return mapTransaction(data as AccountTransactionRow);
}

// ─────────────────────────────────────────────────────────────
// DELETE  (manual daybook entry only — hard delete)
// ─────────────────────────────────────────────────────────────

/**
 * Permanently delete a manual daybook transaction. Same guard as
 * updateTransaction — refuses to delete rows linked to a payment
 * (booking_payment_id is non-null). Hard delete; the row is gone.
 * For reversing an auto-row, edit the source booking payment.
 */
export async function deleteTransaction(id: string): Promise<void> {
  // ── Manual-row guard ──
  const { data: existing, error: fetchErr } = await supabase
    .from("account_transactions")
    .select("id, booking_payment_id")
    .eq("id", id)
    .single();

  if (fetchErr) {
    console.error("──────────── [deleteTransaction] FETCH FAILED ────────────");
    console.error("  message:", fetchErr.message, "| code:", fetchErr.code);
    throw new Error(`[deleteTransaction] ${fetchErr.message}`);
  }
  if (existing.booking_payment_id !== null) {
    throw new Error(
      "[deleteTransaction] This transaction is linked to a booking payment and cannot be deleted from the daybook. " +
      "Delete the source booking payment instead.",
    );
  }

  // Audit: who is deleting? Mirrors updateTransaction's edited_by pattern.
  // Fails open — if auth lookup fails, deleted_by stays null rather than
  // blocking the delete entirely. The row still gets a deleted_at stamp.
  const { data: delAuth } = await supabase.auth.getUser();
  const deletedBy = delAuth?.user?.id ?? null;

  console.log("[deleteTransaction] soft-deleting id:", id, "| deleted_by:", deletedBy);

  // Soft delete: UPDATE deleted_at = now() (+ deleted_by) instead of DELETE.
  // Soft-deleted rows are filtered out of all reads (getTransactions
  // adds .is("deleted_at", null); account_balances view filters via
  // its LEFT JOIN). The DB-level immutability trigger fires on UPDATE,
  // so soft-deleting a row in a closed period is rejected — UI should
  // disable the trash icon on closed-day rows.
  const { error, status, statusText } = await supabase
    .from("account_transactions")
    .update({
      deleted_at: new Date().toISOString(),
      deleted_by: deletedBy,
    })
    .eq("id", id)
    .is("deleted_at", null);

  if (error) {
    console.error("──────────── [deleteTransaction] SOFT DELETE FAILED ────────────");
    console.error("  message    :", error.message);
    console.error("  details    :", error.details);
    console.error("  hint       :", error.hint);
    console.error("  code       :", error.code);
    console.error("  HTTP status:", status, statusText);
    console.error("  id         :", id);
    console.error("────────────────────────────────────────────────────────────");
    throw new Error(
      `[deleteTransaction] Delete failed — ${error.message}` +
      (error.code    ? ` (code: ${error.code})`      : "") +
      (error.hint    ? ` | hint: ${error.hint}`       : "") +
      (error.details ? ` | details: ${error.details}` : ""),
    );
  }

  console.log("[deleteTransaction] succeeded, id:", id);
}

// ─────────────────────────────────────────────────────────────
// CSV EXPORT  (Stage 2.5 — client-side CSV string generation)
// ─────────────────────────────────────────────────────────────
//
// Pure function: takes already-fetched transactions + the four accounts
// (for bucket name lookup) and returns a CSV string. The caller is
// responsible for triggering the download. No DB access.
//
// Filter respected by virtue of the caller passing in the already-filtered
// transactions array (whatever's currently displayed on the daybook).
//
// Columns:
//   Date            — YYYY-MM-DD
//   Type            — pretty label (Revenue, Expense, Transfer, ...)
//   From bucket     — bucket name or empty
//   To bucket       — bucket name or empty
//   Amount (BDT)    — numeric, positive
//   Note            — free text (CSV-escaped if it contains commas/quotes/newlines)
//   Source          — "Manual" for daybook entries, "Booking payment" for
//                      auto-rows linked to a payment. Helps the accountant
//                      tell why a row exists.
//
// "Recorded by" is intentionally omitted in v1 — see Day 19 handoff for
// rationale. Easy to add later as another column without breaking old
// exports.

const TXN_TYPE_LABELS: Record<string, string> = {
  revenue_in:     "Revenue",
  expense_out:    "Expense",
  transfer:       "Transfer",
  injection:      "Cash Injection",
  loan_received:  "Loan Received",
  loan_repayment: "Loan Repayment",
};

// Escape a value for CSV per RFC 4180:
//   - if value contains comma, double-quote, or newline, wrap in double quotes
//   - any double-quote inside the value becomes ""
function csvEscape(value: string): string {
  if (value === "" || value === null || value === undefined) return "";
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Convert a list of transactions to a CSV string.
 *
 * @param transactions  The rows to export (typically the currently-filtered
 *                      list from AccountsClient state).
 * @param accounts      The four bucket accounts (for UUID → name lookup).
 * @returns             A CSV string with a header row + one row per transaction.
 *                      Ends with a trailing newline.
 */
export function transactionsToCsv(
  transactions: AccountTransaction[],
  accounts:     Account[],
): string {
  // UUID -> bucket name lookup
  const bucketName: Record<string, string> = {};
  for (const a of accounts) bucketName[a.id] = a.name;

  // Header row
  const lines: string[] = [
    ["Date", "Type", "From bucket", "To bucket", "Amount (BDT)", "Note", "Source"]
      .map(csvEscape)
      .join(","),
  ];

  // Data rows
  for (const t of transactions) {
    const typeLabel = TXN_TYPE_LABELS[t.type] ?? t.type;
    const fromName  = t.fromAccountId ? (bucketName[t.fromAccountId] ?? "Unknown") : "";
    const toName    = t.toAccountId   ? (bucketName[t.toAccountId]   ?? "Unknown") : "";
    const source    = t.bookingPaymentId === null ? "Manual" : "Booking payment";

    const row = [
      t.txnDate,
      typeLabel,
      fromName,
      toName,
      // Amount: render as plain number string (Intl formatting belongs in the UI,
      // not the export — spreadsheets handle their own number formatting).
      String(t.amount),
      t.note ?? "",
      source,
    ];

    lines.push(row.map(csvEscape).join(","));
  }

  return lines.join("\n") + "\n";
}

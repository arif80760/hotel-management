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
// This service exposes ONLY the Stage 2 surface:
//   getAccounts()       — the four buckets
//   getBalances()       — the four buckets with computed balance
//   getTransactions()   — transaction rows, optional date range filter
//   createTransaction() — insert a 'transfer' or 'injection' ONLY
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
  id:               string;
  txnDate:          string;          // "YYYY-MM-DD"
  type:             AccountTxnType;
  amount:           number;
  fromAccountId:    string | null;
  toAccountId:      string | null;
  note:             string | null;
  createdBy:        string | null;   // auth.users(id) of the recorder
  createdAt:        string;
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
  fromDate?: string;                 // inclusive "YYYY-MM-DD"
  toDate?:   string;                 // inclusive "YYYY-MM-DD"
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
  created_by:         string | null;
  created_at:         string;
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
    id:            row.id,
    txnDate:       row.txn_date,
    type:          row.type as AccountTxnType,
    amount:        Number(row.amount),
    fromAccountId: row.from_account_id,
    toAccountId:   row.to_account_id,
    note:          row.note,
    createdBy:     row.created_by,
    createdAt:     row.created_at,
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
    .select("id, txn_date, type, amount, from_account_id, to_account_id, note, created_by, created_at")
    .order("txn_date", { ascending: false })
    .order("created_at", { ascending: false });

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
    .select("id, txn_date, type, amount, from_account_id, to_account_id, note, created_by, created_at")
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

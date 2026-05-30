// services/expensesService.ts
//
// ─── EXPENSE SERVICE ─────────────────────────────────────────────────────────
//
// Reads + writes for user-recorded expense_out rows on account_transactions.
// Spec: docs/architecture/accounts.md §4 / §5.
//
// ─── SCHEMA (existing, from Stage 1 + Day 21 Phase 4A) ───────────────────────
//
//   account_transactions:
//     type             = 'expense_out'
//     from_account_id  = Cash in Hand bucket UUID (always — per §4)
//     to_account_id    = NULL
//     amount           > 0
//     voucher_number   = generated via next_voucher_number() RPC
//     category_id      FK → expense_categories(id), NOT NULL on user expenses
//     payee            TEXT (free-text vendor name) — exactly one of this or
//     employee_id      UUID FK → employees(id)      — these two is set
//     note             TEXT (item description, free)
//     booking_payment_id = NULL (booking-derived rows are a separate code path
//                         created by fn_sync_account_transactions — not via
//                         this service)
//
// CHECK constraint chk_account_transactions_expense_out_integrity enforces
// the above invariants at the DB level. This service builds inputs that pass
// the constraint; the DB rejects anything that doesn't.
//
// Voucher numbers come from public.next_voucher_number() — a PG function that
// auto-creates a year-scoped sequence (voucher_seq_2026, etc.) and returns
// 'EV-YYYY-NNNN'. Called via supabase.rpc("next_voucher_number").
//
// ─────────────────────────────────────────────────────────────────────────────

import { supabase } from "@/lib/supabase";
import { ACCOUNT_IDS } from "@/services/accountsService";

// ─────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────

// Returned by getExpenses / createExpense. Category names and employee names
// are NOT joined here — the UI resolves them via lookup maps from
// getExpenseCategories() / getAllEmployees(). This matches the rest of the
// codebase's pattern (see app/accounts/cashbook for the same approach with
// account names).
export type Expense = {
  id:             string;
  txnDate:        string;     // "YYYY-MM-DD"
  amount:         number;
  voucherNumber:  string;
  categoryId:     string;
  payee:          string | null;   // free-text payee (exclusive with employeeId)
  employeeId:     string | null;   // FK to employees (exclusive with payee)
  note:           string | null;
  createdAt:      string;
  createdBy:      string | null;
};

// Input for creating a new expense. The form constructs this; the service
// generates voucher_number and validates the exclusive-payee invariant.
export type NewExpense = {
  txnDate:      string;        // "YYYY-MM-DD"
  amount:       number;        // positive
  categoryId:   string;        // FK to expense_categories
  payeeMode:    "employee" | "vendor";
  employeeId?:  string;        // required if payeeMode === 'employee'
  payee?:       string;        // required if payeeMode === 'vendor'
  note?:        string;
};

export type ExpenseFilters = {
  fromDate?: string;
  toDate?:   string;
};

// ─────────────────────────────────────────────────────────────
// READ
// ─────────────────────────────────────────────────────────────

/**
 * List user-recorded expenses (type=expense_out AND booking_payment_id IS NULL),
 * newest first. Joined with expense_categories and employees for display.
 */
export async function getExpenses(filters: ExpenseFilters = {}): Promise<Expense[]> {
  let query = supabase
    .from("account_transactions")
    .select("id, txn_date, amount, voucher_number, category_id, payee, employee_id, note, created_at, created_by")
    .eq("type", "expense_out")
    .is("booking_payment_id", null)
    .is("deleted_at", null)
    .order("txn_date", { ascending: false })
    .order("created_at", { ascending: false });

  if (filters.fromDate) query = query.gte("txn_date", filters.fromDate);
  if (filters.toDate)   query = query.lte("txn_date", filters.toDate);

  const { data, error } = await query;

  if (error) {
    console.error("──────────── [getExpenses] FAILED ────────────");
    console.error("  message:", error.message, "| code:", error.code);
    throw new Error(`[getExpenses] ${error.message}`);
  }

  type Row = {
    id: string;
    txn_date: string;
    amount: string | number;
    voucher_number: string | null;
    category_id: string | null;
    payee: string | null;
    employee_id: string | null;
    note: string | null;
    created_at: string;
    created_by: string | null;
  };

  return ((data ?? []) as Row[]).map((r) => ({
    id:            r.id,
    txnDate:       r.txn_date,
    amount:        typeof r.amount === "string" ? parseFloat(r.amount) : r.amount,
    voucherNumber: r.voucher_number ?? "",   // should never be null on user expenses (CHECK enforces)
    categoryId:    r.category_id ?? "",
    payee:         r.payee,
    employeeId:    r.employee_id,
    note:          r.note,
    createdAt:     r.created_at,
    createdBy:     r.created_by,
  }));
}

/**
 * Returns distinct payee values from prior expenses, for free-text autocomplete.
 * Empty array if nothing recorded yet.
 */
export async function getDistinctPayees(): Promise<string[]> {
  const { data, error } = await supabase
    .from("account_transactions")
    .select("payee")
    .eq("type", "expense_out")
    .is("booking_payment_id", null)
    .not("payee", "is", null)
    .is("deleted_at", null);

  if (error) {
    console.error("──────────── [getDistinctPayees] FAILED ────────────");
    console.error("  message:", error.message, "| code:", error.code);
    throw new Error(`[getDistinctPayees] ${error.message}`);
  }

  const seen = new Set<string>();
  for (const row of (data ?? []) as Array<{ payee: string | null }>) {
    if (row.payee) seen.add(row.payee);
  }
  return Array.from(seen).sort((a, b) => a.localeCompare(b));
}

// ─────────────────────────────────────────────────────────────
// WRITE
// ─────────────────────────────────────────────────────────────

/**
 * Create a new user expense. Generates voucher_number via RPC, validates
 * exclusive-payee, inserts. Returns the new Expense.
 *
 * The from_account_id is hardcoded to Cash in Hand (per architecture §4 —
 * "always funded from Cash in Hand").
 *
 * Throws on validation failure or DB error. DB-level CHECK provides the
 * final safety net.
 */
export async function createExpense(input: NewExpense): Promise<Expense> {
  // ── Validate ─────────────────────────────────────────────
  if (!input.txnDate) throw new Error("[createExpense] txnDate is required.");
  if (!(input.amount > 0)) throw new Error("[createExpense] amount must be positive.");
  if (!input.categoryId) throw new Error("[createExpense] categoryId is required.");

  if (input.payeeMode === "employee") {
    if (!input.employeeId) throw new Error("[createExpense] employeeId required when payeeMode='employee'.");
    if (input.payee)       throw new Error("[createExpense] payee must be empty when payeeMode='employee'.");
  } else if (input.payeeMode === "vendor") {
    if (!input.payee?.trim()) throw new Error("[createExpense] payee required when payeeMode='vendor'.");
    if (input.employeeId)     throw new Error("[createExpense] employeeId must be empty when payeeMode='vendor'.");
  } else {
    throw new Error(`[createExpense] unknown payeeMode: ${input.payeeMode}`);
  }

  // ── Generate voucher number ──────────────────────────────
  const { data: voucherData, error: voucherErr } = await supabase.rpc("next_voucher_number");
  if (voucherErr || !voucherData) {
    console.error("──────────── [createExpense] VOUCHER RPC FAILED ────────────");
    console.error("  message:", voucherErr?.message, "| code:", voucherErr?.code);
    throw new Error(`[createExpense] voucher number generation failed (${voucherErr?.message ?? "no data"}).`);
  }
  const voucherNumber: string = String(voucherData);

  // ── Auth lookup for created_by ───────────────────────────
  const { data: authData } = await supabase.auth.getUser();
  const createdBy = authData?.user?.id ?? null;

  // ── Build payload ────────────────────────────────────────
  const payload = {
    type:               "expense_out" as const,
    txn_date:           input.txnDate,
    amount:             input.amount,
    from_account_id:    ACCOUNT_IDS.cash,
    to_account_id:      null,
    voucher_number:     voucherNumber,
    category_id:        input.categoryId,
    payee:              input.payeeMode === "vendor"   ? input.payee!.trim() : null,
    employee_id:        input.payeeMode === "employee" ? input.employeeId!   : null,
    note:               input.note?.trim() || null,
    created_by:         createdBy,
  };

  // ── Insert ───────────────────────────────────────────────
  const { data, error } = await supabase
    .from("account_transactions")
    .insert(payload)
    .select("id, txn_date, amount, voucher_number, category_id, payee, employee_id, note, created_at, created_by")
    .single();

  if (error || !data) {
    console.error("──────────── [createExpense] INSERT FAILED ────────────");
    console.error("  message:", error?.message, "| code:", error?.code, "| details:", error?.details, "| hint:", error?.hint);
    throw new Error(`[createExpense] ${error?.message ?? "no row returned"}`);
  }

  const r = data as {
    id: string;
    txn_date: string;
    amount: string | number;
    voucher_number: string;
    category_id: string;
    payee: string | null;
    employee_id: string | null;
    note: string | null;
    created_at: string;
    created_by: string | null;
  };

  return {
    id:            r.id,
    txnDate:       r.txn_date,
    amount:        typeof r.amount === "string" ? parseFloat(r.amount) : r.amount,
    voucherNumber: r.voucher_number,
    categoryId:    r.category_id,
    payee:         r.payee,
    employeeId:    r.employee_id,
    note:          r.note,
    createdAt:     r.created_at,
    createdBy:     r.created_by,
  };
}

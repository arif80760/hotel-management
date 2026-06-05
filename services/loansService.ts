// services/loansService.ts
//
// ─── LOANS SERVICE ────────────────────────────────────────────────────────────
//
// Reads + writes for the Loans feature (Stage 6).
// A "loan" is money the hotel borrows from a third party.
// Principal only — no interest. Repaid-so-far is DERIVED from linked
// loan_repayment account_transactions, not stored on the loans row.
//
// ─── SCHEMA ───────────────────────────────────────────────────────────────────
//
//   loans
//     id, lender_name, principal, received_date, due_date?, note?, created_by,
//     created_at, updated_at
//
//   account_transactions (existing table)
//     type = 'loan_received'  → to_account_id NOT NULL, from_account_id NULL
//     type = 'loan_repayment' → from_account_id NOT NULL, to_account_id NULL
//     loan_id FK → loans.id (set null on loan delete, index exists)
//
// ─── ATOMICITY NOTE ──────────────────────────────────────────────────────────
//
//   createLoan does two sequential Supabase writes (loans INSERT then
//   account_transactions INSERT). If the second fails, we issue a compensating
//   DELETE on the loans row. This is NOT a true DB transaction — a crash between
//   the two writes could leave an orphan loan row. Acceptable for this stage.
//
// ─────────────────────────────────────────────────────────────────────────────

import { supabase } from "@/lib/supabase";
import type { AccountTxnType } from "@/services/accountsService";

// ─────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────

export type Loan = {
  id:           string;
  lenderName:   string;
  principal:    number;
  receivedDate: string;   // "YYYY-MM-DD"
  dueDate:      string | null;
  note:         string | null;
  createdBy:    string | null;
  createdAt:    string;
  updatedAt:    string;
};

/** Loan with derived repayment fields computed from linked transactions. */
export type LoanWithStatus = Loan & {
  repaid:      number;    // sum of all loan_repayment amounts for this loan
  outstanding: number;    // principal - repaid (floored to 0)
  status:      "outstanding" | "repaid";
};

/** Input for recording a new loan received. */
export type NewLoan = {
  lenderName:        string;
  principal:         number;
  receivedDate:      string;   // "YYYY-MM-DD"
  dueDate?:          string | null;
  note?:             string | null;
  /** Which account received the cash — loan_received: to_account_id NOT NULL */
  toAccountId:       string;
};

/** Input for recording a loan repayment. */
export type NewLoanRepayment = {
  loanId:       string;
  amount:       number;
  txnDate:      string;   // "YYYY-MM-DD"
  /** Which account the repayment was paid from — loan_repayment: from_account_id NOT NULL */
  fromAccountId: string;
  note?:         string | null;
};

/** A single loan repayment transaction row. */
export type LoanRepayment = {
  id:            string;
  loanId:        string;
  txnDate:       string;
  amount:        number;
  fromAccountId: string;
  note:          string | null;
  createdAt:     string;
};

// ─────────────────────────────────────────────────────────────
// RAW ROW TYPES
// ─────────────────────────────────────────────────────────────

type LoanRow = {
  id:            string;
  lender_name:   string;
  principal:     number;
  received_date: string;
  due_date:      string | null;
  note:          string | null;
  created_by:    string | null;
  created_at:    string;
  updated_at:    string;
};

type RepaymentRow = {
  id:              string;
  loan_id:         string | null;
  txn_date:        string;
  amount:          number;
  from_account_id: string | null;
  note:            string | null;
  created_at:      string;
};

// ─────────────────────────────────────────────────────────────
// MAPPERS
// ─────────────────────────────────────────────────────────────

function mapLoan(r: LoanRow): Loan {
  return {
    id:           r.id,
    lenderName:   r.lender_name,
    principal:    Number(r.principal),
    receivedDate: r.received_date,
    dueDate:      r.due_date,
    note:         r.note,
    createdBy:    r.created_by,
    createdAt:    r.created_at,
    updatedAt:    r.updated_at,
  };
}

function mapRepayment(r: RepaymentRow): LoanRepayment {
  return {
    id:            r.id,
    loanId:        r.loan_id ?? "",
    txnDate:       r.txn_date,
    amount:        Number(r.amount),
    fromAccountId: r.from_account_id ?? "",
    note:          r.note,
    createdAt:     r.created_at,
  };
}

// ─────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────

/**
 * Record a new loan received.
 *
 * Writes two rows:
 *   1. loans INSERT
 *   2. account_transactions INSERT (type = 'loan_received')
 *
 * If the second write fails, compensating DELETE on the loans row.
 */
export async function createLoan(input: NewLoan): Promise<Loan> {
  // 1. Insert the loan row.
  const { data: loanData, error: loanErr } = await supabase
    .from("loans")
    .insert({
      lender_name:   input.lenderName,
      principal:     input.principal,
      received_date: input.receivedDate,
      due_date:      input.dueDate ?? null,
      note:          input.note ?? null,
    })
    .select()
    .single();

  if (loanErr || !loanData) {
    throw new Error(loanErr?.message ?? "Failed to create loan record.");
  }

  const loan = loanData as LoanRow;

  // 2. Insert the linked account_transaction (loan_received).
  //    chk_txn_accounts: loan_received → to NOT NULL, from NULL.
  const { error: txnErr } = await supabase
    .from("account_transactions")
    .insert({
      type:            "loan_received" as AccountTxnType,
      txn_date:        input.receivedDate,
      amount:          input.principal,
      from_account_id: null,
      to_account_id:   input.toAccountId,
      loan_id:         loan.id,
      note:            input.note ?? null,
    });

  if (txnErr) {
    // Compensating delete — best-effort, ignore error.
    await supabase.from("loans").delete().eq("id", loan.id);
    throw new Error(
      `Loan row created but failed to record cash movement: ${txnErr.message}. Loan record rolled back.`
    );
  }

  return mapLoan(loan);
}

/**
 * List all loans, each with derived repayment fields.
 *
 * Fetches all loans + all non-deleted loan_repayment transactions,
 * then computes repaid/outstanding/status client-side per loan.
 */
export async function listLoans(): Promise<LoanWithStatus[]> {
  const [loansRes, repRes] = await Promise.all([
    supabase.from("loans").select("*").order("received_date", { ascending: false }),
    supabase
      .from("account_transactions")
      .select("id, loan_id, txn_date, amount, from_account_id, note, created_at")
      .eq("type", "loan_repayment" as AccountTxnType)
      .is("deleted_at", null),
  ]);

  if (loansRes.error) throw new Error(loansRes.error.message);
  if (repRes.error)   throw new Error(repRes.error.message);

  // Sum repayments per loan_id.
  const repaidMap = new Map<string, number>();
  for (const row of (repRes.data ?? []) as RepaymentRow[]) {
    if (!row.loan_id) continue;
    repaidMap.set(row.loan_id, (repaidMap.get(row.loan_id) ?? 0) + Number(row.amount));
  }

  return ((loansRes.data ?? []) as LoanRow[]).map((r) => {
    const loan      = mapLoan(r);
    const repaid    = repaidMap.get(r.id) ?? 0;
    const outstanding = Math.max(0, loan.principal - repaid);
    return {
      ...loan,
      repaid,
      outstanding,
      status: outstanding <= 0 ? "repaid" : "outstanding",
    };
  });
}

/**
 * Record a repayment against an existing loan.
 *
 * Inserts a single account_transaction of type 'loan_repayment'.
 * chk_txn_accounts: loan_repayment → from NOT NULL, to NULL.
 */
export async function recordLoanRepayment(input: NewLoanRepayment): Promise<LoanRepayment> {
  const { data, error } = await supabase
    .from("account_transactions")
    .insert({
      type:            "loan_repayment" as AccountTxnType,
      txn_date:        input.txnDate,
      amount:          input.amount,
      from_account_id: input.fromAccountId,
      to_account_id:   null,
      loan_id:         input.loanId,
      note:            input.note ?? null,
    })
    .select("id, loan_id, txn_date, amount, from_account_id, note, created_at")
    .single();

  if (error || !data) {
    throw new Error(error?.message ?? "Failed to record loan repayment.");
  }

  return mapRepayment(data as RepaymentRow);
}

/**
 * Fetch all repayment transactions for a single loan, newest first.
 */
export async function getLoanRepayments(loanId: string): Promise<LoanRepayment[]> {
  const { data, error } = await supabase
    .from("account_transactions")
    .select("id, loan_id, txn_date, amount, from_account_id, note, created_at")
    .eq("type", "loan_repayment" as AccountTxnType)
    .eq("loan_id", loanId)
    .is("deleted_at", null)
    .order("txn_date", { ascending: false });

  if (error) throw new Error(error.message);

  return ((data ?? []) as RepaymentRow[]).map(mapRepayment);
}

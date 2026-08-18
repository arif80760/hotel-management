// app/api/assistant/financialTools.ts
//
// ─── ASSISTANT FINANCIAL TOOLS (ADMIN-ONLY, SERVER-ONLY) ─────────────────────
//
// Step 2 (2026-08-18, design approved by Arif). These schemas are appended to
// the model's tool menu ONLY when profiles.role === 'admin' (enforced in
// route.ts) — a staff request never sees them, so the model cannot call them.
// The route also guards dispatch by role as defense in depth.
//
// Business rules encoded (design report §1; confirmed by Arif since):
//   • expense_categories.kind whitelist: EXACTLY operating | remuneration |
//     adjustment. 'remuneration' = appropriation of profit, excluded from
//     operating expenses. 'adjustment' = corrections (the "Software Test
//     Data" pre-launch write-offs, ৳510,849) — belongs in NEITHER bucket,
//     always its own labelled line. Any unknown fourth kind is surfaced
//     LOUDLY in meta.warnings and its own bucket, never silently classified.
//   • Refunds (expense_out with booking_payment_id set) net against revenue
//     by default, matching the P&L page; labelled in meta. They are NEVER
//     counted as operating expenses.
//   • Central fund (2026-08-16): payment method is descriptive only —
//     method breakdowns come from payments.method, never to_account_id;
//     balances carry the central-fund note.
//   • Live operation started 2026-07-30 (LAUNCH_DATE). Any range crossing it
//     gets a meta warning — pre-launch rows are test data.
//   • Soft-deleted rows (deleted_at) excluded everywhere.
//   • Category identity is id/system_key, never display name for LOGIC —
//     name input from the model is resolved against the live table.
//   • PostgREST caps a select at 1000 rows — all row fetches page, so
//     wide ranges can't silently truncate a total.
//
// Every tool returns { figures..., meta } — meta echoes the period, filters,
// exclusions, and warnings for the receipt panel.
// ─────────────────────────────────────────────────────────────────────────────

import type { SupabaseClient } from "@supabase/supabase-js";

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** First day of real operation — everything earlier is test data. */
export const LAUNCH_DATE = "2026-07-30";

const KNOWN_KINDS = ["operating", "remuneration", "adjustment"] as const;

const CENTRAL_FUND_NOTE =
  "Since 2026-08-16 ALL revenue lands in Cash in Hand (the central fund) regardless of payment method; " +
  "payment method is descriptive only. Bank/bKash/Nagad balances change only via explicit transfers and drawdowns.";

function assertISODate(value: unknown, name: string): string {
  if (typeof value !== "string" || !ISO_DATE_RE.test(value)) {
    throw new Error(`${name} must be an ISO date (YYYY-MM-DD); got: ${String(value)}`);
  }
  return value;
}

function assertRange(from: string, to: string): void {
  if (to < from) throw new Error(`'to' (${to}) is before 'from' (${from}).`);
}

function launchWarning(from: string): string | null {
  return from < LAUNCH_DATE
    ? `Range starts before live operation began (${LAUNCH_DATE}) — earlier rows are TEST DATA and are included in these figures. Interpret with care.`
    : null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Paged select — PostgREST caps at 1000 rows per request; wide ranges must
 *  not silently truncate. `build` returns a fresh filtered builder each page. */
async function pagedRows<T>(
  build: () => PromiseLike<{ data: T[] | null; error: { message: string } | null }> & {
    range: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>;
  },
  label: string,
): Promise<T[]> {
  const PAGE = 1000;
  const rows: T[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await build().range(offset, offset + PAGE - 1);
    if (error) throw new Error(`${label} read failed: ${error.message}`);
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE) return rows;
  }
}

// ─── Tool schemas (appended to the menu for admins only) ─────────────────────

export const FINANCIAL_TOOL_SCHEMAS = [
  {
    name: "get_revenue_summary",
    description:
      "Total revenue RECEIVED for a date range: by source (booking payments vs each manual revenue category), by payment method (descriptive), refunds netted by default. Call for questions about revenue, income, takings, or money received. Optionally exclude manual revenue categories by name.",
    strict: true,
    input_schema: {
      type: "object" as const,
      properties: {
        from: { type: "string", description: "Start date YYYY-MM-DD (inclusive)" },
        to:   { type: "string", description: "End date YYYY-MM-DD (inclusive)" },
        exclude_categories: {
          type: ["array", "null"],
          items: { type: "string" },
          description: "Manual revenue category names to exclude; null for none",
        },
        net_refunds: { type: ["boolean", "null"], description: "Subtract refunds (default true, matching the P&L); null = default" },
      },
      required: ["from", "to", "exclude_categories", "net_refunds"],
      additionalProperties: false,
    },
  },
  {
    name: "get_expense_summary",
    description:
      "Expenses PAID for a date range, split by kind: operating expenses (with by-category breakdown), director remuneration (appropriation of profit, NOT an expense), and adjustment corrections (neither). Call for questions about expenses, costs, spending, or a specific expense category. Refund payouts are excluded (they net against revenue).",
    strict: true,
    input_schema: {
      type: "object" as const,
      properties: {
        from: { type: "string", description: "Start date YYYY-MM-DD (inclusive)" },
        to:   { type: "string", description: "End date YYYY-MM-DD (inclusive)" },
        category: { type: ["string", "null"], description: "Optional expense category name to filter to; null for all" },
      },
      required: ["from", "to", "category"],
      additionalProperties: false,
    },
  },
  {
    name: "get_remuneration",
    description:
      "Director/MD remuneration paid in a date range, grouped by recipient, with individual payments. Call for questions about director payments, MD/Chairman remuneration, or what a named director received.",
    strict: true,
    input_schema: {
      type: "object" as const,
      properties: {
        from: { type: "string", description: "Start date YYYY-MM-DD (inclusive)" },
        to:   { type: "string", description: "End date YYYY-MM-DD (inclusive)" },
        recipient: { type: ["string", "null"], description: "Optional recipient name to filter to; null for all recipients" },
      },
      required: ["from", "to", "recipient"],
      additionalProperties: false,
    },
  },
  {
    name: "get_profit_summary",
    description:
      "The profit & loss ladder for a date range: revenue → less refunds → net revenue → less operating expenses → net profit → less director remuneration → retained profit (adjustment corrections shown separately, outside the ladder). Call for questions about profit, loss, margin, or overall financial performance.",
    strict: true,
    input_schema: {
      type: "object" as const,
      properties: {
        from: { type: "string", description: "Start date YYYY-MM-DD (inclusive)" },
        to:   { type: "string", description: "End date YYYY-MM-DD (inclusive)" },
      },
      required: ["from", "to"],
      additionalProperties: false,
    },
  },
  {
    name: "get_account_balances",
    description:
      "Current balance of every money account (Cash in Hand, Bank, bKash, Nagad, …). Call for questions about balances, how much money is in an account, or cash on hand right now.",
    strict: true,
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
];

// ─── Shared row fetchers ─────────────────────────────────────────────────────

type TxnRow = {
  id: string;
  txn_date: string;
  amount: number;
  booking_payment_id: string | null;
  revenue_category_id: string | null;
  category_id: string | null;
  employee_id: string | null;
  payee: string | null;
  note: string | null;
};

type ExpenseCategoryRow = { id: string; name: string; kind: string | null };

function txnSelect(db: SupabaseClient, type: "revenue_in" | "expense_out", from: string, to: string) {
  return () => db
    .from("account_transactions")
    .select("id, txn_date, amount, booking_payment_id, revenue_category_id, category_id, employee_id, payee, note")
    .eq("type", type)
    .is("deleted_at", null)
    .gte("txn_date", from)
    .lte("txn_date", to)
    .order("txn_date", { ascending: true })
    .order("id", { ascending: true });
}

async function fetchExpenseCategories(db: SupabaseClient): Promise<ExpenseCategoryRow[]> {
  const { data, error } = await db.from("expense_categories").select("id, name, kind");
  if (error) throw new Error(`expense_categories read failed: ${error.message}`);
  return data ?? [];
}

/** Split non-refund expense rows into the three whitelisted kinds; anything
 *  else lands in `unknown` with a loud warning composed by the caller.
 *  Missing/NULL kind = operating (CLAUDE.md rev 31). */
function splitByKind(rows: TxnRow[], cats: ExpenseCategoryRow[]) {
  const kindById = new Map(cats.map((c) => [c.id, c.kind ?? "operating"]));
  const nameById = new Map(cats.map((c) => [c.id, c.name]));
  const buckets = {
    operating: [] as TxnRow[],
    remuneration: [] as TxnRow[],
    adjustment: [] as TxnRow[],
    unknown: [] as { row: TxnRow; kind: string }[],
  };
  for (const row of rows) {
    const kind = row.category_id ? (kindById.get(row.category_id) ?? "operating") : "operating";
    if (kind === "operating" || kind === "remuneration" || kind === "adjustment") {
      buckets[kind].push(row);
    } else {
      buckets.unknown.push({ row, kind });
    }
  }
  return { buckets, nameById };
}

function unknownKindWarning(unknown: { row: TxnRow; kind: string }[]): string | null {
  if (unknown.length === 0) return null;
  const kinds = [...new Set(unknown.map((u) => u.kind))].join(", ");
  const total = round2(unknown.reduce((s, u) => s + u.row.amount, 0));
  return `UNRECOGNISED expense kind(s) [${kinds}] on ${unknown.length} row(s) totalling ৳${total} — ` +
    `NOT included in any bucket. The known kinds are ${KNOWN_KINDS.join("/")}; a new kind was added to ` +
    `expense_categories and this assistant needs updating before those rows can be classified.`;
}

const sum = (rows: TxnRow[]) => round2(rows.reduce((s, r) => s + r.amount, 0));

// ─── get_revenue_summary ─────────────────────────────────────────────────────

export async function getRevenueSummary(
  db: SupabaseClient,
  input: { from: string; to: string; exclude_categories: string[] | null; net_refunds: boolean | null },
) {
  const from = assertISODate(input.from, "from");
  const to = assertISODate(input.to, "to");
  assertRange(from, to);
  const netRefunds = input.net_refunds ?? true;

  const [revenueRows, refundRows, catsRes] = await Promise.all([
    pagedRows<TxnRow>(txnSelect(db, "revenue_in", from, to) as never, "revenue"),
    pagedRows<TxnRow>(txnSelect(db, "expense_out", from, to) as never, "refunds")
      .then((rows) => rows.filter((r) => r.booking_payment_id !== null)),
    db.from("revenue_categories").select("id, name"),
  ]);
  if (catsRes.error) throw new Error(`revenue_categories read failed: ${catsRes.error.message}`);
  const catNameById = new Map((catsRes.data ?? []).map((c) => [c.id, c.name]));

  // Resolve exclusions against the LIVE category list (names are renameable).
  const excludedIds = new Set<string>();
  const excludedNames: string[] = [];
  for (const raw of input.exclude_categories ?? []) {
    const q = raw.trim().toLowerCase();
    if (!q) continue;
    const match = (catsRes.data ?? []).find((c) => c.name.toLowerCase() === q)
      ?? (catsRes.data ?? []).find((c) => c.name.toLowerCase().includes(q));
    if (!match) {
      throw new Error(`Unknown revenue category "${raw}". Categories: ${(catsRes.data ?? []).map((c) => c.name).join(", ") || "(none)"}`);
    }
    excludedIds.add(match.id);
    excludedNames.push(match.name);
  }
  const kept = revenueRows.filter((r) => !(r.revenue_category_id && excludedIds.has(r.revenue_category_id)));
  const excludedAmount = round2(sum(revenueRows) - sum(kept));

  // By source: booking payments vs each manual category.
  const bySource = new Map<string, { total: number; entries: number }>();
  for (const r of kept) {
    const label = r.booking_payment_id !== null
      ? "Room / booking payments"
      : (r.revenue_category_id ? (catNameById.get(r.revenue_category_id) ?? "Unknown category") : "Uncategorised manual");
    const cur = bySource.get(label) ?? { total: 0, entries: 0 };
    cur.total += r.amount; cur.entries += 1;
    bySource.set(label, cur);
  }

  // By payment method — DESCRIPTIVE only (central fund). Batched .in() lookups.
  // Chunk of 100 — the ids travel in the GET query string, and larger chunks
  // overflow the request-URL/header limit on wide ranges (seen live at 400).
  const paymentIds = kept.filter((r) => r.booking_payment_id).map((r) => r.booking_payment_id as string);
  const methodByPayment = new Map<string, string>();
  for (let i = 0; i < paymentIds.length; i += 100) {
    const { data, error } = await db.from("payments").select("id, method").in("id", paymentIds.slice(i, i + 100));
    if (error) throw new Error(`payments read failed: ${error.message}`);
    for (const p of data ?? []) methodByPayment.set(p.id, p.method);
  }
  const byMethod = new Map<string, number>();
  for (const r of kept) {
    if (!r.booking_payment_id) continue;
    const m = methodByPayment.get(r.booking_payment_id) ?? "unknown";
    byMethod.set(m, (byMethod.get(m) ?? 0) + r.amount);
  }

  const gross = sum(kept);
  const refunds = sum(refundRows);
  const warnings = [launchWarning(from)].filter(Boolean);

  return {
    period: { from, to },
    gross_revenue: gross,
    refunds: netRefunds ? refunds : 0,
    net_revenue: netRefunds ? round2(gross - refunds) : gross,
    by_source: [...bySource.entries()]
      .map(([source, v]) => ({ source, total: round2(v.total), entries: v.entries }))
      .sort((a, b) => b.total - a.total),
    booking_payments_by_method: [...byMethod.entries()]
      .map(([method, total]) => ({ method, total: round2(total) }))
      .sort((a, b) => b.total - a.total),
    meta: {
      period: `${from} to ${to} (inclusive, hotel-local dates)`,
      refunds: netRefunds
        ? `netted against revenue (৳${refunds} across ${refundRows.length} refund payouts) — matching the P&L`
        : `NOT netted (net_refunds=false); ৳${refunds} of refunds exist in this range`,
      exclusions: excludedNames.length
        ? `excluded categories: ${excludedNames.join(", ")} (৳${excludedAmount} removed)`
        : "no categories excluded",
      payment_method_note: `Method is as recorded on the payment — descriptive only. ${CENTRAL_FUND_NOTE}`,
      voided_excluded: true,
      revenue_entries: kept.length,
      warnings,
    },
  };
}

// ─── get_expense_summary ─────────────────────────────────────────────────────

export async function getExpenseSummary(
  db: SupabaseClient,
  input: { from: string; to: string; category: string | null },
) {
  const from = assertISODate(input.from, "from");
  const to = assertISODate(input.to, "to");
  assertRange(from, to);

  const [allRows, cats] = await Promise.all([
    pagedRows<TxnRow>(txnSelect(db, "expense_out", from, to) as never, "expenses"),
    fetchExpenseCategories(db),
  ]);
  let rows = allRows.filter((r) => r.booking_payment_id === null); // refunds are NOT expenses

  // Optional category filter, resolved against the live table.
  let filterName: string | null = null;
  if (input.category && input.category.trim() !== "") {
    const q = input.category.trim().toLowerCase();
    const match = cats.find((c) => c.name.toLowerCase() === q)
      ?? cats.find((c) => c.name.toLowerCase().includes(q));
    if (!match) throw new Error(`Unknown expense category "${input.category}". Categories: ${cats.map((c) => c.name).join(", ")}`);
    rows = rows.filter((r) => r.category_id === match.id);
    filterName = `${match.name} (kind: ${match.kind ?? "operating"})`;
  }

  const { buckets, nameById } = splitByKind(rows, cats);

  const byCat = new Map<string, number>();
  for (const r of buckets.operating) {
    const name = r.category_id ? (nameById.get(r.category_id) ?? "Uncategorised") : "Uncategorised";
    byCat.set(name, (byCat.get(name) ?? 0) + r.amount);
  }

  const warnings = [launchWarning(from), unknownKindWarning(buckets.unknown)].filter(Boolean);

  return {
    period: { from, to },
    operating_expenses: {
      total: sum(buckets.operating),
      by_category: [...byCat.entries()]
        .map(([category, total]) => ({ category, total: round2(total) }))
        .sort((a, b) => b.total - a.total),
      entries: buckets.operating.length,
    },
    remuneration: {
      total: sum(buckets.remuneration),
      entries: buckets.remuneration.length,
      note: "Appropriation of profit — NOT an operating expense; excluded from expense/profit totals.",
    },
    adjustment: {
      total: sum(buckets.adjustment),
      entries: buckets.adjustment.length,
      note: "Corrections (e.g. pre-launch test-data write-offs) — neither a cost nor a payment; belongs in NO expense total.",
    },
    unclassified: buckets.unknown.length
      ? { total: round2(buckets.unknown.reduce((s, u) => s + u.row.amount, 0)), entries: buckets.unknown.length }
      : null,
    meta: {
      period: `${from} to ${to} (inclusive, hotel-local dates)`,
      filter: filterName ?? "all categories",
      refund_payouts_excluded: "refund disbursements are not expenses — they net against revenue",
      voided_excluded: true,
      warnings,
    },
  };
}

// ─── get_remuneration ────────────────────────────────────────────────────────

export async function getRemuneration(
  db: SupabaseClient,
  input: { from: string; to: string; recipient: string | null },
) {
  const from = assertISODate(input.from, "from");
  const to = assertISODate(input.to, "to");
  assertRange(from, to);

  const cats = await fetchExpenseCategories(db);
  const remunIds = new Set(cats.filter((c) => c.kind === "remuneration").map((c) => c.id));
  if (remunIds.size === 0) throw new Error("No expense category with kind='remuneration' exists.");

  const rows = (await pagedRows<TxnRow>(txnSelect(db, "expense_out", from, to) as never, "remuneration"))
    .filter((r) => r.booking_payment_id === null && r.category_id !== null && remunIds.has(r.category_id));

  // Recipient names: employees.full_name for employee-linked rows; payee text otherwise.
  const employeeIds = [...new Set(rows.map((r) => r.employee_id).filter(Boolean))] as string[];
  const employeeById = new Map<string, { name: string; designation: string | null }>();
  if (employeeIds.length) {
    const { data, error } = await db.from("employees")
      .select("id, full_name, designation").in("id", employeeIds);
    if (error) throw new Error(`employees read failed: ${error.message}`);
    for (const e of data ?? []) employeeById.set(e.id, { name: e.full_name, designation: e.designation });
  }
  const recipientOf = (r: TxnRow) =>
    r.employee_id ? (employeeById.get(r.employee_id)?.name ?? "Unknown employee") : (r.payee ?? "Unnamed recipient");

  let filtered = rows;
  let filterNote = "all recipients";
  if (input.recipient && input.recipient.trim() !== "") {
    const q = input.recipient.trim().toLowerCase();
    filtered = rows.filter((r) => recipientOf(r).toLowerCase().includes(q));
    filterNote = `recipient matching "${input.recipient}"`;
    if (filtered.length === 0) {
      const names = [...new Set(rows.map(recipientOf))];
      throw new Error(`No remuneration to "${input.recipient}" in ${from}–${to}. Recipients in this range: ${names.join(", ") || "(none)"}`);
    }
  }

  const byRecipient = new Map<string, { total: number; payments: number; designation: string | null }>();
  for (const r of filtered) {
    const name = recipientOf(r);
    const cur = byRecipient.get(name) ?? {
      total: 0, payments: 0,
      designation: r.employee_id ? (employeeById.get(r.employee_id)?.designation ?? null) : null,
    };
    cur.total += r.amount; cur.payments += 1;
    byRecipient.set(name, cur);
  }

  const payments = filtered.slice(0, 100).map((r) => ({
    date: r.txn_date, recipient: recipientOf(r), amount: round2(r.amount), note: r.note,
  }));

  const warnings = [launchWarning(from)].filter(Boolean);

  return {
    period: { from, to },
    total: sum(filtered),
    by_recipient: [...byRecipient.entries()]
      .map(([recipient, v]) => ({ recipient, designation: v.designation, total: round2(v.total), payments: v.payments }))
      .sort((a, b) => b.total - a.total),
    payments,
    payments_truncated: filtered.length > 100 ? `${filtered.length - 100} more payments not listed` : null,
    meta: {
      period: `${from} to ${to} (inclusive, hotel-local dates)`,
      filter: filterNote,
      classification: "rows in categories with kind='remuneration' (resolved by kind, never by name) — appropriation of profit, not an expense",
      voided_excluded: true,
      warnings,
    },
  };
}

// ─── get_profit_summary ──────────────────────────────────────────────────────

export async function getProfitSummary(
  db: SupabaseClient,
  input: { from: string; to: string },
) {
  const from = assertISODate(input.from, "from");
  const to = assertISODate(input.to, "to");
  assertRange(from, to);

  const [revenueRows, expenseAll, cats] = await Promise.all([
    pagedRows<TxnRow>(txnSelect(db, "revenue_in", from, to) as never, "revenue"),
    pagedRows<TxnRow>(txnSelect(db, "expense_out", from, to) as never, "expenses"),
    fetchExpenseCategories(db),
  ]);
  const refundRows = expenseAll.filter((r) => r.booking_payment_id !== null);
  const { buckets } = splitByKind(expenseAll.filter((r) => r.booking_payment_id === null), cats);

  const revenue = sum(revenueRows);
  const refunds = sum(refundRows);
  const operating = sum(buckets.operating);
  const remuneration = sum(buckets.remuneration);
  const adjustment = sum(buckets.adjustment);

  const netRevenue = round2(revenue - refunds);
  const netProfit = round2(netRevenue - operating);
  const retained = round2(netProfit - remuneration);

  const warnings = [launchWarning(from), unknownKindWarning(buckets.unknown)].filter(Boolean);

  return {
    period: { from, to },
    ladder: {
      revenue,
      less_refunds: refunds,
      net_revenue: netRevenue,
      less_operating_expenses: operating,
      net_profit: netProfit,
      less_director_remuneration: remuneration,
      retained_profit: retained,
    },
    net_margin_percent: netRevenue > 0 ? round2((netProfit / netRevenue) * 100) : 0,
    adjustment_corrections: {
      total: adjustment,
      note: "Adjustment-kind rows (pre-launch test-data write-offs) — deliberately OUTSIDE the ladder: neither a cost nor a payment.",
    },
    meta: {
      period: `${from} to ${to} (inclusive, hotel-local dates)`,
      semantics: "revenue − refunds = net revenue; − operating = net profit; − remuneration (appropriation) = retained. Checkout write-off discounts create no transaction and are invisible here by design.",
      voided_excluded: true,
      warnings,
    },
  };
}

// ─── get_account_balances ────────────────────────────────────────────────────

export async function getAccountBalances(db: SupabaseClient) {
  const { data, error } = await db
    .from("account_balances")
    .select("account_id, name, is_spendable, balance")
    .order("name");
  if (error) throw new Error(`account_balances read failed: ${error.message}`);

  const accounts = (data ?? []).map((a) => ({
    name: a.name,
    balance: round2(Number(a.balance)),
    role: a.is_spendable ? "central fund (all revenue lands here)" : "moves only via explicit transfers/drawdowns",
  }));

  return {
    accounts,
    total: round2(accounts.reduce((s, a) => s + a.balance, 0)),
    meta: {
      as_of: "current balances (all history to date)",
      central_fund: CENTRAL_FUND_NOTE,
      historical_note:
        "Balances before 2026-08-16 accumulated under the old method→account mapping; a refund on a pre-changeover payment debits Cash in Hand while the original credit stays put (known one-off artifact).",
    },
  };
}

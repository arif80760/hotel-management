// app/accounts/cashbook/report/[date]/page.tsx
//
// Server wrapper for the printable Daily Cashbook Report.
//   - Admin-only role guard (same pattern as voucher/cashbook/expense).
//   - Reconstructs the day entirely from account_transactions — closed
//     days are immutable (fn_check_account_transactions_immutability),
//     so a re-queried report is deterministic and reprints identically.
//     day_closes stores NO snapshot and its opening/closing figures are
//     CASH IN HAND ONLY; the other accounts are computed here and the
//     page says so.
//   - READ ONLY. Writes nothing; does not touch closeDay/closePastDay.
//
// Route: /accounts/cashbook/report/[date]  where [date] is YYYY-MM-DD.

import { redirect, notFound } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabaseServer";
import CashbookReportClient, {
  type ReportAccountSection,
  type ReportData,
} from "./CashbookReportClient";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ date: string }>;
}

// Direction semantics copied from CashbookClient.txnDirection — kept in
// sync by convention (this codebase inlines per-feature helpers).
function txnDirection(type: string): "in" | "out" | "neutral" {
  switch (type) {
    case "revenue_in":
    case "injection":
    case "loan_received":
      return "in";
    case "expense_out":
    case "loan_repayment":
      return "out";
    case "transfer":
    default:
      return "neutral";
  }
}

const num = (v: string | number | null | undefined): number =>
  v == null ? 0 : typeof v === "string" ? parseFloat(v) : v;

// PostgREST embeds can come back array OR object — handle both.
function embedded<T>(v: T | T[] | null | undefined): T | null {
  if (v == null) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

export default async function CashbookReportPage({ params }: PageProps) {
  const { date } = await params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) notFound();

  const sc = await createSupabaseServerClient();
  const { data: { user } } = await sc.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await sc
    .from("profiles").select("role").eq("id", user.id).single();
  if (profile?.role !== "admin") redirect("/");

  // ── Accounts + current balances (resolved from the table, not names) ──
  const { data: acctRows, error: acctErr } = await sc
    .from("accounts").select("id, name, is_spendable");
  if (acctErr || !acctRows) notFound();

  const { data: balRows, error: balErr } = await sc
    .from("account_balances").select("account_id, balance");
  if (balErr || !balRows) notFound();
  const balanceNow = new Map<string, number>(balRows.map((b) => [b.account_id as string, num(b.balance)]));

  // ── Transactions from `date` onward — opening(acct) = balanceNow − net(≥ date).
  //    Deterministic for closed days because rows ≤ last close are immutable. ──
  const { data: fwdRows, error: fwdErr } = await sc
    .from("account_transactions")
    .select("txn_date, amount, from_account_id, to_account_id")
    .gte("txn_date", date)
    .is("deleted_at", null);
  if (fwdErr) notFound();

  const netOnward = new Map<string, number>(); // txn_date >= date
  const netOfDay  = new Map<string, number>(); // txn_date === date
  for (const r of fwdRows ?? []) {
    const amt = num(r.amount);
    const add = (m: Map<string, number>, id: string | null, d: number) => {
      if (id) m.set(id, (m.get(id) ?? 0) + d);
    };
    add(netOnward, r.to_account_id, amt);
    add(netOnward, r.from_account_id, -amt);
    if (r.txn_date === date) {
      add(netOfDay, r.to_account_id, amt);
      add(netOfDay, r.from_account_id, -amt);
    }
  }

  // ── The day's transactions (voided rows excluded, like the cashbook) ──
  const { data: dayRows, error: dayErr } = await sc
    .from("account_transactions")
    .select("id, type, amount, from_account_id, to_account_id, note, voucher_number, booking_payment_id, category_id, revenue_category_id, expense_item_id, employee_id, payee")
    .eq("txn_date", date)
    .is("deleted_at", null)
    .order("created_at", { ascending: true });
  if (dayErr) notFound();
  const dayTxns = dayRows ?? [];

  // ── day_closes — first read surface for this table (write-only until now) ──
  const { data: closeRow } = await sc
    .from("day_closes")
    .select("close_date, opening_balance, closing_balance, closed_by, closed_at")
    .eq("close_date", date)
    .maybeSingle();

  let closedByName: string | null = null;
  if (closeRow?.closed_by) {
    const { data: emp } = await sc
      .from("employees").select("full_name")
      .eq("auth_user_id", closeRow.closed_by).maybeSingle();
    closedByName = emp?.full_name ?? null;
  }

  // ── Label lookups — one batched id→name read each, never per row ──
  const [{ data: expCats }, { data: revCats }, { data: expItems }, { data: emps }] = await Promise.all([
    sc.from("expense_categories").select("id, name"),
    sc.from("revenue_categories").select("id, name"),
    sc.from("expense_items").select("id, name"),
    sc.from("employees").select("id, full_name"),
  ]);
  const expCatName  = new Map<string, string>((expCats  ?? []).map((r) => [r.id as string, r.name as string]));
  const revCatName  = new Map<string, string>((revCats  ?? []).map((r) => [r.id as string, r.name as string]));
  const itemName    = new Map<string, string>((expItems ?? []).map((r) => [r.id as string, r.name as string]));
  const empName     = new Map<string, string>((emps     ?? []).map((r) => [r.id as string, r.full_name as string]));

  // ── Room revenue labels: payments → booking_ref, booking_rooms → rooms.
  //    Same data path as getRoomsForBookingPayments (NEVER bookings.room_id). ──
  const paymentIds = [...new Set(dayTxns.filter((t) => t.type === "revenue_in" && t.booking_payment_id).map((t) => t.booking_payment_id as string))];
  const roomsByPayment = new Map<string, { bookingRef: string; roomNumbers: string[] }>();
  if (paymentIds.length > 0) {
    const { data: pays } = await sc
      .from("payments")
      .select("id, booking_id, bookings!booking_id(booking_ref)")
      .in("id", paymentIds);
    const bookingIds = [...new Set((pays ?? []).map((p) => p.booking_id as string).filter(Boolean))];
    const roomsByBooking = new Map<string, string[]>();
    if (bookingIds.length > 0) {
      const { data: brs } = await sc
        .from("booking_rooms")
        .select("booking_id, rooms(room_number)")
        .in("booking_id", bookingIds);
      for (const br of brs ?? []) {
        const room = embedded(br.rooms as { room_number: string } | { room_number: string }[] | null);
        if (!room?.room_number) continue;
        const list = roomsByBooking.get(br.booking_id as string) ?? [];
        list.push(String(room.room_number));
        roomsByBooking.set(br.booking_id as string, list);
      }
      for (const list of roomsByBooking.values()) list.sort((a, b) => Number(a) - Number(b));
    }
    for (const p of pays ?? []) {
      const booking = embedded(p.bookings as { booking_ref: string | null } | { booking_ref: string | null }[] | null);
      roomsByPayment.set(p.id as string, {
        bookingRef:  booking?.booking_ref ?? "",
        roomNumbers: roomsByBooking.get(p.booking_id as string) ?? [],
      });
    }
  }

  // ── Label derivation — SAME rules as CashbookClient.deriveLabel so the
  //    paper matches the screen exactly. ──
  const acctName = new Map<string, string>(acctRows.map((a) => [a.id as string, a.name as string]));
  type DayTxn = (typeof dayTxns)[number];
  const deriveLabel = (t: DayTxn): string => {
    switch (t.type) {
      case "loan_received":  return "Loan received";
      case "loan_repayment": return "Loan repayment";
      case "injection":      return "Cash injection";
      case "transfer":       return "Transfer";
      case "revenue_in": {
        if (t.booking_payment_id) {
          const info = roomsByPayment.get(t.booking_payment_id as string);
          if (info && info.roomNumbers.length > 0) {
            const nums   = info.roomNumbers;
            const prefix = nums.length === 1 ? "Room" : "Rooms";
            const shown  = nums.length <= 2 ? nums.join(", ") : `${nums.slice(0, 2).join(", ")} +${nums.length - 2}`;
            const ref    = info.bookingRef ? ` · ${info.bookingRef}` : "";
            return `Room revenue · ${prefix} ${shown}${ref}`;
          }
          return "Room revenue";
        }
        return (t.revenue_category_id && revCatName.get(t.revenue_category_id as string)) || "Other revenue";
      }
      case "expense_out": {
        const base = (t.category_id && expCatName.get(t.category_id as string)) || "Expense";
        const item = t.expense_item_id ? itemName.get(t.expense_item_id as string) : undefined;
        const receiver = (t.employee_id ? empName.get(t.employee_id as string) : undefined)
          ?? ((t.payee as string | null)?.trim() || undefined);
        return [base, item, receiver].filter(Boolean).join(" · ");
      }
      default: return String(t.type).replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    }
  };

  const flowText = (t: DayTxn): string => {
    const from = t.from_account_id ? acctName.get(t.from_account_id as string) ?? "Unknown" : null;
    const to   = t.to_account_id   ? acctName.get(t.to_account_id   as string) ?? "Unknown" : null;
    if (from && to) return `${from} → ${to}`;
    if (to)   return `→ ${to}`;
    if (from) return `${from} →`;
    return "";
  };

  // ── Per-account sections (Cash in Hand first, then alphabetical —
  //    same ordering rule as the cashbook balance cards) ──
  const orderedAccounts = [...acctRows].sort((a, b) => {
    if (a.is_spendable && !b.is_spendable) return -1;
    if (!a.is_spendable && b.is_spendable) return 1;
    return String(a.name).localeCompare(String(b.name));
  });

  const isClosed = !!closeRow;
  const sections: ReportAccountSection[] = orderedAccounts.map((a) => {
    const id = a.id as string;
    const computedOpening = (balanceNow.get(id) ?? 0) - (netOnward.get(id) ?? 0);
    const computedClosing = computedOpening + (netOfDay.get(id) ?? 0);
    // Cash in Hand on a closed day: show the STORED day-close figures —
    // that is the audited record. Other accounts are always computed.
    const useStored = isClosed && !!a.is_spendable;
    let totalIn = 0, totalOut = 0;
    const rows = dayTxns
      .filter((t) => t.from_account_id === id || t.to_account_id === id)
      .map((t) => {
        const amt = num(t.amount);
        const incoming = t.to_account_id === id;
        if (incoming) totalIn += amt; else totalOut += amt;
        return {
          id:      t.id as string,
          voucher: (t.voucher_number as string | null) ?? "",
          label:   deriveLabel(t),
          note:    (t.note as string | null) ?? "",
          flow:    flowText(t),
          sign:    incoming ? "+" : "−",
          amount:  amt,
        };
      });
    return {
      accountId:  id,
      name:       String(a.name),
      isCash:     !!a.is_spendable,
      opening:    useStored ? num(closeRow!.opening_balance) : +computedOpening.toFixed(2),
      closing:    useStored ? num(closeRow!.closing_balance) : +computedClosing.toFixed(2),
      fromStored: useStored,
      totalIn:    +totalIn.toFixed(2),
      totalOut:   +totalOut.toFixed(2),
      rows,
    };
  });

  // ── Grand totals over UNIQUE transactions (transfers are internal —
  //    counted once, separately, so they can't inflate in/out) ──
  let grandIn = 0, grandOut = 0, grandTransfers = 0;
  for (const t of dayTxns) {
    const amt = num(t.amount);
    const dir = txnDirection(String(t.type));
    if (dir === "in") grandIn += amt;
    else if (dir === "out") grandOut += amt;
    else grandTransfers += amt;
  }

  const report: ReportData = {
    date,
    isClosed,
    closedByName,
    closedAt: (closeRow?.closed_at as string | null) ?? null,
    sections,
    grandIn:        +grandIn.toFixed(2),
    grandOut:       +grandOut.toFixed(2),
    grandTransfers: +grandTransfers.toFixed(2),
    txnCount:       dayTxns.length,
  };

  return <CashbookReportClient report={report} />;
}

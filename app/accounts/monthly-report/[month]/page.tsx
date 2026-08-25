// app/accounts/monthly-report/[month]/page.tsx
//
// Server wrapper for the printable Monthly Owner Report.
//   - Admin-only role guard (same pattern as the daily cashbook report).
//   - READ ONLY — everything is computed from live tables at render time.
//   - Route: /accounts/monthly-report/[month]  where [month] is YYYY-MM.
//
// Business rules applied (CLAUDE.md):
//   • Occupancy uses the CORRECTED denominator: active rooms only, and only
//     rooms currently active count in the numerator too; occupied nights are
//     derived from booking_rooms (never rooms.status), statuses excluding
//     cancelled/no_show, half-open [check_in, COALESCE(actual_checkout,
//     check_out)) — the same semantics as the availability guard.
//   • Money: soft-deleted rows excluded; refunds (booking_payment_id set)
//     net against collections, never expenses; three-kind whitelist
//     (operating / remuneration / adjustment; unknown kinds surfaced) —
//     the SAME classification as the corrected P&L, not a reimplementation
//     of different rules.
//   • Dues movement is computed from bookings' CURRENT effective totals
//     (total + extra − additional discount) and signed payments by date:
//     opening = billed(created before month) − paid(before month);
//     new = billed(created in month); collected = paid(in month);
//     closing = opening + new − collected. Cancelled bookings are excluded
//     entirely (money not expected). The page footnotes that historical
//     figures use current booking totals (write-offs and early-departure
//     deductions apply retroactively) — this is a management view, not a
//     point-in-time audit reconstruction.
//   • Months touching the pre-2026-07-30 boundary carry a test-data banner.

import { redirect, notFound } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabaseServer";
import type { SupabaseClient } from "@supabase/supabase-js";
import MonthlyReportClient, { type MonthlyReportData, type MonthMetrics } from "./MonthlyReportClient";

export const dynamic = "force-dynamic";

const LAUNCH_DATE = "2026-07-30";

interface PageProps { params: Promise<{ month: string }> }

const num = (v: string | number | null | undefined): number =>
  v == null ? 0 : typeof v === "string" ? parseFloat(v) : v;

// Same noon-anchored day-diff convention as calcNights (CLAUDE.md date rule).
function daysBetween(fromISO: string, toISOExclusive: string): number {
  return Math.round(
    (new Date(`${toISOExclusive}T12:00:00`).getTime() - new Date(`${fromISO}T12:00:00`).getTime()) / 86_400_000,
  );
}
function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
/** [from, toExclusive) for a YYYY-MM month. */
function monthRange(month: string): { from: string; toExclusive: string } {
  const [y, m] = month.split("-").map(Number);
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return { from: `${month}-01`, toExclusive: `${ny}-${String(nm).padStart(2, "0")}-01` };
}
function prevMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  const py = m === 1 ? y - 1 : y;
  const pm = m === 1 ? 12 : m - 1;
  return `${py}-${String(pm).padStart(2, "0")}`;
}

async function paged<T>(build: (fromRow: number, toRow: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const PAGE = 1000;
  const rows: T[] = [];
  for (let o = 0; ; o += PAGE) {
    const { data, error } = await build(o, o + PAGE - 1);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE) return rows;
  }
}

// ── One month's metrics (reused for the prior month's deltas) ──
async function computeMonth(sc: SupabaseClient, month: string): Promise<MonthMetrics> {
  const { from, toExclusive } = monthRange(month);
  const today = todayISO();
  // Current month: measure elapsed days only (through today).
  const measuredToExclusive = toExclusive <= today ? toExclusive : daysBetween(from, today) >= 0 ? nextDay(today) : from;
  function nextDay(iso: string): string {
    const d = new Date(`${iso}T12:00:00`); d.setDate(d.getDate() + 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  const elapsedDays = Math.max(0, daysBetween(from, measuredToExclusive));
  const toInclusive = elapsedDays > 0 ? prevDay(measuredToExclusive) : from;
  function prevDay(iso: string): string {
    const d = new Date(`${iso}T12:00:00`); d.setDate(d.getDate() - 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  // ── Occupancy: active rooms only, booking_rooms-derived ──
  const [{ data: activeRooms }, occRows] = await Promise.all([
    sc.from("rooms").select("id").eq("is_active", true),
    paged<{ room_id: string; check_in_date: string; check_out_date: string; actual_checkout_date: string | null; status: string }>(
      (a, b) => sc.from("booking_rooms")
        .select("room_id, check_in_date, check_out_date, actual_checkout_date, status")
        .not("status", "in", "(cancelled,no_show)")
        .lt("check_in_date", measuredToExclusive)
        .order("id")
        .range(a, b),
    ),
  ]);
  const activeRoomIds = new Set((activeRooms ?? []).map((r) => r.id as string));
  let occupiedNights = 0;
  for (const r of occRows) {
    if (!activeRoomIds.has(r.room_id)) continue;
    const end = r.actual_checkout_date ?? r.check_out_date;
    const s = r.check_in_date > from ? r.check_in_date : from;
    const e = end < measuredToExclusive ? end : measuredToExclusive;
    if (e > s) occupiedNights += daysBetween(s, e);
  }
  const roomNights = activeRoomIds.size * elapsedDays;
  const occupancyPct = roomNights > 0 ? Math.round((occupiedNights / roomNights) * 1000) / 10 : 0;

  // ── Money: transactions in the month (soft-deletes excluded) ──
  const txns = await paged<{ type: string; amount: number; booking_payment_id: string | null; category_id: string | null }>(
    (a, b) => sc.from("account_transactions")
      .select("type, amount, booking_payment_id, category_id")
      .is("deleted_at", null)
      .gte("txn_date", from)
      .lt("txn_date", toExclusive)
      .order("id")
      .range(a, b),
  );
  const { data: cats } = await sc.from("expense_categories").select("id, name, kind");
  const kindById = new Map((cats ?? []).map((c) => [c.id as string, (c.kind as string | null) ?? "operating"]));
  const nameById = new Map((cats ?? []).map((c) => [c.id as string, c.name as string]));

  let roomRevenue = 0, totalCollections = 0, refunds = 0;
  let operating = 0, remuneration = 0, adjustment = 0, unknownKindTotal = 0;
  const unknownKinds = new Set<string>();
  const opByCat = new Map<string, number>();
  for (const t of txns) {
    const amt = num(t.amount);
    if (t.type === "revenue_in") {
      totalCollections += amt;
      if (t.booking_payment_id) roomRevenue += amt;
    } else if (t.type === "expense_out") {
      if (t.booking_payment_id) { refunds += amt; continue; }
      const kind = t.category_id ? (kindById.get(t.category_id) ?? "operating") : "operating";
      if (kind === "remuneration") remuneration += amt;
      else if (kind === "adjustment") adjustment += amt;
      else if (kind === "operating") {
        operating += amt;
        const nm = t.category_id ? (nameById.get(t.category_id) ?? "Uncategorised") : "Uncategorised";
        opByCat.set(nm, (opByCat.get(nm) ?? 0) + amt);
      } else { unknownKindTotal += amt; unknownKinds.add(kind); }
    }
  }

  // ── Dues movement (current-values basis; cancelled excluded) ──
  const bookings = await paged<{ id: string; created_at: string; status: string; total_amount: number | null; extra_charge_amount: number | null; additional_discount_amount: number | null }>(
    (a, b) => sc.from("bookings")
      .select("id, created_at, status, total_amount, extra_charge_amount, additional_discount_amount")
      .neq("status", "cancelled")
      .order("id")
      .range(a, b),
  );
  const payments = await paged<{ booking_id: string; amount: number; created_at: string }>(
    (a, b) => sc.from("payments").select("booking_id, amount, created_at").order("id").range(a, b),
  );
  const keptBookingIds = new Set(bookings.map((b) => b.id));
  const eff = (b: (typeof bookings)[number]) =>
    num(b.total_amount) + num(b.extra_charge_amount) - num(b.additional_discount_amount);
  // created_at is timestamptz; month boundaries in Dhaka wall-clock.
  const fromTs = `${from}T00:00:00+06:00`;
  const toTs = `${toExclusive}T00:00:00+06:00`;

  let billedBefore = 0, billedInMonth = 0;
  for (const b of bookings) {
    if (b.created_at < fromTs) billedBefore += eff(b);
    else if (b.created_at < toTs) billedInMonth += eff(b);
  }
  let paidBefore = 0, paidInMonth = 0;
  for (const p of payments) {
    if (!keptBookingIds.has(p.booking_id)) continue;   // cancelled excluded both sides
    if (p.created_at < fromTs) paidBefore += num(p.amount);
    else if (p.created_at < toTs) paidInMonth += num(p.amount);
  }
  const openingDues = +(billedBefore - paidBefore).toFixed(2);
  const closingDues = +(openingDues + billedInMonth - paidInMonth).toFixed(2);

  return {
    month,
    from,
    toInclusive,
    elapsedDays,
    fullMonth: toExclusive <= today,
    occupancy: { pct: occupancyPct, occupiedNights, roomNights, activeRooms: activeRoomIds.size },
    roomRevenue: +roomRevenue.toFixed(2),
    totalCollections: +totalCollections.toFixed(2),
    refunds: +refunds.toFixed(2),
    operating: +operating.toFixed(2),
    operatingByCategory: [...opByCat.entries()]
      .map(([name, total]) => ({ name, total: +total.toFixed(2) }))
      .sort((a, b) => b.total - a.total),
    remuneration: +remuneration.toFixed(2),
    adjustment: +adjustment.toFixed(2),
    unknownKindTotal: +unknownKindTotal.toFixed(2),
    unknownKinds: [...unknownKinds],
    dues: {
      opening: openingDues,
      newBilled: +billedInMonth.toFixed(2),
      collected: +paidInMonth.toFixed(2),
      closing: closingDues,
    },
    touchesTestData: from < LAUNCH_DATE,
  };
}

export default async function MonthlyReportPage({ params }: PageProps) {
  const { month } = await params;
  if (!/^\d{4}-\d{2}$/.test(month)) notFound();
  const [, mm] = month.split("-").map(Number);
  if (mm < 1 || mm > 12) notFound();
  if (`${month}-01` > todayISO()) notFound();   // future months have no data

  const sc = await createSupabaseServerClient();
  const { data: { user } } = await sc.auth.getUser();
  if (!user) redirect("/login");
  const { data: profile } = await sc.from("profiles").select("role").eq("id", user.id).single();
  if (profile?.role !== "admin") redirect("/");

  const current = await computeMonth(sc, month);
  // Prior month for deltas — only when it has any activity at all.
  const prior = await computeMonth(sc, prevMonth(month));
  const hasPrior = prior.totalCollections > 0 || prior.operating > 0 || prior.occupancy.occupiedNights > 0;

  const report: MonthlyReportData = { current, prior: hasPrior ? prior : null };
  return <MonthlyReportClient report={report} />;
}

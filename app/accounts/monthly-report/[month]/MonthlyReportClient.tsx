"use client";

// app/accounts/monthly-report/[month]/MonthlyReportClient.tsx
//
// Printable Monthly Owner Report — presentation only; all data is computed
// server-side in page.tsx. Follows the Daily Cashbook Report's structural
// pattern exactly: <LetterHead/>, <PrintButtons/>, print:hidden action bar,
// standalone route excluded from the app shell, signature block.

import Link from "next/link";
import LetterHead from "@/components/invoice/LetterHead";
import PrintButtons from "@/components/invoice/PrintButtons";

function formatAmount(n: number): string {
  return new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}
function monthLabel(month: string): string {
  const d = new Date(`${month}-01T12:00:00`);
  return d.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
}
function dayLabel(iso: string): string {
  const d = new Date(`${iso}T12:00:00`);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

export interface MonthMetrics {
  month: string;
  from: string;
  toInclusive: string;
  elapsedDays: number;
  fullMonth: boolean;
  occupancy: { pct: number; occupiedNights: number; roomNights: number; activeRooms: number };
  roomRevenue: number;
  totalCollections: number;
  refunds: number;
  operating: number;
  operatingByCategory: { name: string; total: number }[];
  remuneration: number;
  adjustment: number;
  unknownKindTotal: number;
  unknownKinds: string[];
  dues: { opening: number; newBilled: number; collected: number; closing: number };
  touchesTestData: boolean;
}

export interface MonthlyReportData {
  current: MonthMetrics;
  prior: MonthMetrics | null;
}

/** Month-over-month delta, shown only when the prior value is meaningful. */
function Delta({ now, before, invert = false }: { now: number; before: number | undefined; invert?: boolean }) {
  if (before === undefined || before === 0) return null;
  const pct = ((now - before) / Math.abs(before)) * 100;
  const good = invert ? pct <= 0 : pct >= 0;
  return (
    <span className={`ml-2 text-[11px] font-semibold whitespace-nowrap ${good ? "text-emerald-700" : "text-rose-700"}`}>
      {pct >= 0 ? "▲" : "▼"} {Math.abs(pct).toFixed(1)}% MoM
    </span>
  );
}

export default function MonthlyReportClient({ report }: { report: MonthlyReportData }) {
  const m = report.current;
  const p = report.prior ?? undefined;
  const netOperating = +(m.totalCollections - m.refunds - m.operating).toFixed(2);

  return (
    <div className="min-h-screen bg-slate-50 print:bg-white">
      {/* ── Action bar (hidden on print) ───────────────────── */}
      <div className="max-w-4xl mx-auto px-4 sm:px-6 pt-6 pb-3 print:hidden">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Link href="/accounts/monthly-reports" className="text-[13px] text-slate-500 hover:text-slate-800 transition-colors">
            ← Back to Monthly Reports
          </Link>
          <PrintButtons targetId="monthly-report-printable" filename={`monthly-report-${m.month}`} />
        </div>
      </div>

      {/* ── Printable document ─────────────────────────────── */}
      <div
        id="monthly-report-printable"
        className="max-w-4xl mx-auto bg-white border border-slate-200 rounded-xl shadow-sm
                   px-4 sm:px-10 pt-8 pb-12 mb-10
                   print:max-w-none print:border-0 print:rounded-none print:shadow-none print:p-8 print:m-0"
      >
        <LetterHead />

        <div className="mt-6 mb-2 text-center">
          <h2 className="text-[18px] font-bold text-slate-900 tracking-wide uppercase">Monthly Owner Report</h2>
          <p className="text-[13.5px] font-semibold text-slate-700 mt-1">{monthLabel(m.month)}</p>
          {!m.fullMonth && (
            <p className="text-[12px] text-amber-700 font-semibold mt-1.5">
              MONTH IN PROGRESS — covers {dayLabel(m.from)} to {dayLabel(m.toInclusive)} ({m.elapsedDays} days). Figures will change until month end.
            </p>
          )}
        </div>

        {m.touchesTestData && (
          <p className="text-[11.5px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-center mb-4 max-w-xl mx-auto">
            This month includes dates before live operation began (30 July 2026) — figures include TEST DATA and should not be read as trading results.
          </p>
        )}
        {m.unknownKindTotal > 0 && (
          <p className="text-[11.5px] text-rose-800 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2 text-center mb-4 max-w-xl mx-auto">
            ৳{formatAmount(m.unknownKindTotal)} of expenses carry an unrecognised category kind ({m.unknownKinds.join(", ")}) and are in NO figure below — the expense-kind whitelist needs updating.
          </p>
        )}

        {/* ── Key figures ──────────────────────────────────── */}
        <div className="overflow-x-auto mb-8">
          <table className="w-full text-[12.5px] border-t border-b border-slate-300">
            <tbody>
              <tr className="border-b border-slate-100">
                <td className="py-2 pr-3 font-semibold text-slate-800">Occupancy</td>
                <td className="py-2 pl-3 text-right tabular-nums font-semibold">
                  {m.occupancy.pct.toFixed(1)}%
                  <Delta now={m.occupancy.pct} before={p?.occupancy.pct} />
                </td>
              </tr>
              <tr className="border-b border-slate-100">
                <td className="py-2 pr-3 text-slate-600 pl-4">
                  {m.occupancy.occupiedNights} occupied room-nights of {m.occupancy.roomNights} available
                  ({m.occupancy.activeRooms} active rooms × {m.elapsedDays} days; deactivated rooms excluded)
                </td>
                <td />
              </tr>
              <tr className="border-b border-slate-100">
                <td className="py-2 pr-3 font-semibold text-slate-800">Room revenue — payments received (cash basis)</td>
                <td className="py-2 pl-3 text-right tabular-nums font-semibold text-emerald-700">
                  ৳{formatAmount(m.roomRevenue)}
                  <Delta now={m.roomRevenue} before={p?.roomRevenue} />
                </td>
              </tr>
              <tr className="border-b border-slate-100">
                <td className="py-2 pr-3 font-semibold text-slate-800">Total collections — all payments received (cash basis)</td>
                <td className="py-2 pl-3 text-right tabular-nums font-semibold text-emerald-700">
                  ৳{formatAmount(m.totalCollections)}
                  <Delta now={m.totalCollections} before={p?.totalCollections} />
                </td>
              </tr>
              <tr className="border-b border-slate-100">
                <td className="py-2 pr-3 text-slate-600">Less: refunds paid out</td>
                <td className="py-2 pl-3 text-right tabular-nums text-rose-700">−৳{formatAmount(m.refunds)}</td>
              </tr>
              <tr className="border-b border-slate-100">
                <td className="py-2 pr-3 font-semibold text-slate-800">Operating expenses</td>
                <td className="py-2 pl-3 text-right tabular-nums font-semibold text-rose-700">
                  −৳{formatAmount(m.operating)}
                  <Delta now={m.operating} before={p?.operating} invert />
                </td>
              </tr>
              <tr className="border-b border-slate-200">
                <td className="py-2 pr-3 font-bold text-slate-900">Net from operations</td>
                <td className={`py-2 pl-3 text-right tabular-nums font-bold ${netOperating >= 0 ? "text-emerald-700" : "text-rose-700"}`}>
                  ৳{formatAmount(netOperating)}
                </td>
              </tr>
              <tr className="border-b border-slate-100">
                <td className="py-2 pr-3 text-amber-800">
                  Director remuneration
                  <span className="block text-[11px] text-slate-500">appropriation of profit — not an operating expense</span>
                </td>
                <td className="py-2 pl-3 text-right tabular-nums text-amber-800">
                  ৳{formatAmount(m.remuneration)}
                  <Delta now={m.remuneration} before={p?.remuneration} invert />
                </td>
              </tr>
              {m.adjustment > 0 && (
                <tr className="border-b border-slate-100">
                  <td className="py-2 pr-3 text-slate-500">
                    Adjustments / corrections
                    <span className="block text-[11px]">test-data write-offs — excluded from every figure above</span>
                  </td>
                  <td className="py-2 pl-3 text-right tabular-nums text-slate-500">৳{formatAmount(m.adjustment)}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* ── Operating expenses by category ───────────────── */}
        <div className="mb-8 break-inside-avoid">
          <h3 className="text-[13px] font-bold text-slate-800 uppercase tracking-wide mb-1.5">Operating expenses by category</h3>
          <table className="w-full text-[12px] border-t border-slate-300">
            <tbody>
              {m.operatingByCategory.length === 0 && (
                <tr><td className="py-2 text-slate-400 italic">No operating expenses this month.</td></tr>
              )}
              {m.operatingByCategory.map((c) => (
                <tr key={c.name} className="border-b border-slate-100">
                  <td className="py-1.5 pr-3 text-slate-800">{c.name}</td>
                  <td className="py-1.5 pl-3 text-right tabular-nums">৳{formatAmount(c.total)}</td>
                </tr>
              ))}
              <tr>
                <td className="py-2 pr-3 font-bold text-slate-900 border-t border-slate-300">Total operating</td>
                <td className="py-2 pl-3 text-right tabular-nums font-bold text-rose-700 border-t border-slate-300">৳{formatAmount(m.operating)}</td>
              </tr>
            </tbody>
          </table>
        </div>

        {/* ── Dues movement ────────────────────────────────── */}
        <div className="mb-3 break-inside-avoid">
          <h3 className="text-[13px] font-bold text-slate-800 uppercase tracking-wide mb-1.5">Dues movement</h3>
          <table className="w-full text-[12px] border-t border-slate-300">
            <tbody>
              <tr className="border-b border-slate-100">
                <td className="py-1.5 pr-3 text-slate-800">Opening dues (start of month)</td>
                <td className="py-1.5 pl-3 text-right tabular-nums">৳{formatAmount(m.dues.opening)}</td>
              </tr>
              <tr className="border-b border-slate-100">
                <td className="py-1.5 pr-3 text-slate-800">New billings (bookings created this month)</td>
                <td className="py-1.5 pl-3 text-right tabular-nums">+৳{formatAmount(m.dues.newBilled)}</td>
              </tr>
              <tr className="border-b border-slate-100">
                <td className="py-1.5 pr-3 text-slate-800">Collected from bookings this month</td>
                <td className="py-1.5 pl-3 text-right tabular-nums text-emerald-700">−৳{formatAmount(m.dues.collected)}</td>
              </tr>
              <tr>
                <td className="py-2 pr-3 font-bold text-slate-900 border-t border-slate-300">Closing dues</td>
                <td className="py-2 pl-3 text-right tabular-nums font-bold border-t border-slate-300">৳{formatAmount(m.dues.closing)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="text-[10.5px] text-slate-400 mb-10">
          Dues use each booking&apos;s CURRENT effective total (room total + extra charges − discounts), so
          write-offs and early-departure deductions apply retroactively to opening figures; cancelled
          bookings are excluded. This is a management view, not a point-in-time audit reconstruction.
          {report.prior === null && " Month-over-month deltas are omitted — no prior-month activity exists."}
        </p>

        {/* ── Signature block (same as the daily report) ───── */}
        <div className="grid grid-cols-1 sm:grid-cols-3 print:grid-cols-3 gap-10 pt-4 break-inside-avoid">
          {["Prepared by", "Checked by", "Approved by"].map((role) => (
            <div key={role} className="text-center">
              <div className="border-t border-slate-400 pt-2 mt-12">
                <p className="text-[12px] font-semibold text-slate-700">{role}</p>
                <p className="text-[11px] text-slate-400 mt-3">Date: ____________</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

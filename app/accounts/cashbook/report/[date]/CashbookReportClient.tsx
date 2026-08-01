"use client";

// app/accounts/cashbook/report/[date]/CashbookReportClient.tsx
//
// Printable Daily Cashbook Report — presentation only; all data is
// fetched and derived server-side in page.tsx. Reuses <LetterHead />
// and <PrintButtons /> and follows the voucher document's print CSS
// approach (print:hidden action bar, print:p-8 document, standalone
// route excluded from the app shell in AppShell.tsx).
//
// The stored day-close record covers CASH IN HAND ONLY — the page says
// so explicitly; a signed sheet must not imply a verification that
// does not exist. Open days are marked as provisional previews.

import Link         from "next/link";
import LetterHead   from "@/components/invoice/LetterHead";
import PrintButtons from "@/components/invoice/PrintButtons";

// ── Formatters (same conventions as the cashbook screen) ──────
function formatAmount(n: number): string {
  return new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}
function formatDateLong(iso: string): string {
  const d = new Date(iso + "T12:00:00");
  return d.toLocaleDateString("en-GB", { weekday: "long", day: "2-digit", month: "long", year: "numeric" });
}
function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
}

// ── Types (produced by page.tsx) ──────────────────────────────
export interface ReportAccountSection {
  accountId:  string;
  name:       string;
  isCash:     boolean;
  opening:    number;
  closing:    number;
  fromStored: boolean;   // true when opening/closing come from the day_closes record (cash, closed day)
  totalIn:    number;
  totalOut:   number;
  rows: Array<{
    id:      string;
    voucher: string;
    label:   string;
    note:    string;
    flow:    string;
    sign:    string;     // "+" | "−" relative to this account
    amount:  number;
  }>;
}

export interface ReportData {
  date:           string;
  isClosed:       boolean;
  closedByName:   string | null;
  closedAt:       string | null;
  sections:       ReportAccountSection[];
  grandIn:        number;
  grandOut:       number;
  grandTransfers: number;
  txnCount:       number;
}

export default function CashbookReportClient({ report }: { report: ReportData }) {
  return (
    <div className="min-h-screen bg-slate-50 print:bg-white">

      {/* ── Action bar (hidden on print) ───────────────────── */}
      <div className="max-w-4xl mx-auto px-4 sm:px-6 pt-6 pb-3 print:hidden">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Link href="/accounts/cashbook" className="text-[13px] text-slate-500 hover:text-slate-800 transition-colors">
            ← Back to Cashbook
          </Link>
          <PrintButtons targetId="cashbook-report-printable" filename={`cashbook-${report.date}`} />
        </div>
      </div>

      {/* ── Printable document ─────────────────────────────── */}
      <div
        id="cashbook-report-printable"
        className="max-w-4xl mx-auto bg-white border border-slate-200 rounded-xl shadow-sm
                   px-4 sm:px-10 pt-8 pb-12 mb-10
                   print:max-w-none print:border-0 print:rounded-none print:shadow-none print:p-8 print:m-0"
      >
        <LetterHead />

        {/* Title + status */}
        <div className="mt-6 mb-2 text-center">
          <h2 className="text-[18px] font-bold text-slate-900 tracking-wide uppercase">Daily Cashbook Report</h2>
          <p className="text-[13.5px] font-semibold text-slate-700 mt-1">{formatDateLong(report.date)}</p>
          {report.isClosed ? (
            <p className="text-[12px] text-emerald-700 font-semibold mt-1.5">
              DAY CLOSED
              {report.closedByName ? ` · Closed by ${report.closedByName}` : ""}
              {report.closedAt ? ` · ${formatTimestamp(report.closedAt)}` : ""}
            </p>
          ) : (
            <p className="text-[12px] text-amber-700 font-semibold mt-1.5">
              DAY STILL OPEN — PROVISIONAL / UNAUDITED PREVIEW. Figures may change until the day is closed.
            </p>
          )}
        </div>

        {/* Scope disclaimer — the signed record is cash-only */}
        <p className="text-[11px] text-slate-500 text-center mb-6 max-w-xl mx-auto">
          The stored day-close record verifies <span className="font-semibold">Cash in Hand only</span>.
          Bank, bKash and Nagad balances on this page are computed from the transaction ledger and
          carry no separate day-close verification.
        </p>

        {/* ── Per-account summary ──────────────────────────── */}
        <div className="overflow-x-auto mb-8">
          <table className="w-full text-[12.5px] border-t border-b border-slate-300">
            <thead>
              <tr className="text-[11px] uppercase tracking-wider text-slate-500 border-b border-slate-200">
                <th className="text-left  py-2 pr-3 font-semibold">Account</th>
                <th className="text-right py-2 px-3 font-semibold whitespace-nowrap">Opening</th>
                <th className="text-right py-2 px-3 font-semibold whitespace-nowrap">Total In</th>
                <th className="text-right py-2 px-3 font-semibold whitespace-nowrap">Total Out</th>
                <th className="text-right py-2 pl-3 font-semibold whitespace-nowrap">Closing</th>
              </tr>
            </thead>
            <tbody>
              {report.sections.map((s) => (
                <tr key={s.accountId} className="border-b border-slate-100">
                  <td className="py-2 pr-3 font-semibold text-slate-800 whitespace-nowrap">
                    {s.name}
                    {s.fromStored && <span className="text-[10px] font-normal text-emerald-700"> · from day-close record</span>}
                    {!s.fromStored && s.isCash && <span className="text-[10px] font-normal text-amber-700"> · computed (day open)</span>}
                  </td>
                  <td className="py-2 px-3 text-right tabular-nums whitespace-nowrap">{formatAmount(s.opening)}</td>
                  <td className="py-2 px-3 text-right tabular-nums whitespace-nowrap text-emerald-700">{formatAmount(s.totalIn)}</td>
                  <td className="py-2 px-3 text-right tabular-nums whitespace-nowrap text-rose-700">{formatAmount(s.totalOut)}</td>
                  <td className="py-2 pl-3 text-right tabular-nums whitespace-nowrap font-semibold">{formatAmount(s.closing)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* ── Transactions grouped by account ──────────────── */}
        {report.txnCount === 0 ? (
          <p className="text-[12.5px] text-slate-400 italic mb-8">No transactions recorded on this date.</p>
        ) : (
          report.sections.filter((s) => s.rows.length > 0).map((s) => (
            <div key={s.accountId} className="mb-7 break-inside-avoid">
              <h3 className="text-[13px] font-bold text-slate-800 uppercase tracking-wide mb-1.5">{s.name}</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-[12px] border-t border-slate-300">
                  <thead>
                    <tr className="text-[10.5px] uppercase tracking-wider text-slate-500 border-b border-slate-200">
                      <th className="text-left py-1.5 pr-3 font-semibold whitespace-nowrap">Voucher</th>
                      <th className="text-left py-1.5 px-3 font-semibold">Description</th>
                      <th className="text-left py-1.5 px-3 font-semibold">Note</th>
                      <th className="text-left py-1.5 px-3 font-semibold whitespace-nowrap">Flow</th>
                      <th className="text-right py-1.5 pl-3 font-semibold whitespace-nowrap">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.rows.map((r) => (
                      <tr key={`${s.accountId}-${r.id}`} className="border-b border-slate-100 align-top">
                        <td className="py-1.5 pr-3 font-mono text-[11px] text-slate-500 whitespace-nowrap">{r.voucher || "—"}</td>
                        <td className="py-1.5 px-3 text-slate-800">{r.label}</td>
                        <td className="py-1.5 px-3 text-slate-500">{r.note || ""}</td>
                        <td className="py-1.5 px-3 text-slate-500 whitespace-nowrap">{r.flow}</td>
                        <td className={`py-1.5 pl-3 text-right tabular-nums whitespace-nowrap ${r.sign === "+" ? "text-emerald-700" : "text-rose-700"}`}>
                          {r.sign}{formatAmount(r.amount)}
                        </td>
                      </tr>
                    ))}
                    <tr className="border-b border-slate-300">
                      <td colSpan={3} />
                      <td className="py-1.5 px-3 text-[11px] font-semibold text-slate-600 uppercase tracking-wide whitespace-nowrap">Account total</td>
                      <td className="py-1.5 pl-3 text-right tabular-nums whitespace-nowrap font-semibold">
                        <span className="text-emerald-700">+{formatAmount(s.totalIn)}</span>
                        {" / "}
                        <span className="text-rose-700">−{formatAmount(s.totalOut)}</span>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          ))
        )}

        {/* ── Grand total (unique transactions; transfers internal) ── */}
        <div className="border-t-2 border-slate-800 pt-3 mb-10">
          <div className="flex flex-wrap justify-end gap-x-8 gap-y-1 text-[12.5px]">
            <p className="text-slate-600">Total received: <span className="font-semibold text-emerald-700 tabular-nums whitespace-nowrap">৳{formatAmount(report.grandIn)}</span></p>
            <p className="text-slate-600">Total paid out: <span className="font-semibold text-rose-700 tabular-nums whitespace-nowrap">৳{formatAmount(report.grandOut)}</span></p>
            <p className="text-slate-600">Internal transfers: <span className="font-semibold text-slate-700 tabular-nums whitespace-nowrap">৳{formatAmount(report.grandTransfers)}</span></p>
            <p className="text-slate-800 font-semibold">Net: <span className={`tabular-nums whitespace-nowrap ${report.grandIn - report.grandOut >= 0 ? "text-emerald-700" : "text-rose-700"}`}>৳{formatAmount(report.grandIn - report.grandOut)}</span></p>
          </div>
          <p className="text-[10.5px] text-slate-400 text-right mt-1">
            Totals count each transaction once; transfers move money between accounts and are excluded from received/paid out.
          </p>
        </div>

        {/* ── Signature block ──────────────────────────────── */}
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

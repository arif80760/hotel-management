"use client";

// app/accounts/voucher/[id]/VoucherClient.tsx
//
// Payment voucher print document. Reuses <LetterHead /> and
// <PrintButtons /> for visual consistency with booking invoices.
//
// Architecture-doc §5.1 voucher contents:
//   - Voucher number (EV-YYYY-NNNN, also rendered as Bangla digits)
//   - Date
//   - Paid to / payee name (employee or vendor)
//   - Amount in figures
//   - Amount in words (English-Bangladeshi convention AND Bengali)
//   - Category / purpose
//   - Payment method (Cash in Hand)
//   - Hotel letterhead / branding (via <LetterHead />)
//   - "Prepared by" + signature lines
//
// Print styling: @media print hides navigation chrome and resizes the
// document for portrait letter/A4. Tailwind's print: variant gates this.

import Link                    from "next/link";
import LetterHead              from "@/components/invoice/LetterHead";
import PrintButtons            from "@/components/invoice/PrintButtons";
import { amountToEnglishLakh, amountToBengali, toBengaliDigits } from "@/lib/amountToWords";

// ── Formatters ────────────────────────────────────────────────

function formatAmount(n: number): string {
  return new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}

function formatDateLong(iso: string): string {
  // "30 May 2026"
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" });
}

// ── Types ─────────────────────────────────────────────────────

export interface VoucherData {
  id:             string;
  txnDate:        string;       // "YYYY-MM-DD"
  amount:         number;
  voucherNumber:  string;       // "EV-2026-0005"
  categoryName:   string | null;
  employeeName:   string | null; // set if payee is an employee
  payee:          string | null; // set if payee is free-text vendor
  note:           string | null;
  recordedByName: string | null; // resolved auth.users -> employees.full_name (best-effort)
}

interface VoucherClientProps {
  voucher: VoucherData;
}


export default function VoucherClient({ voucher }: VoucherClientProps) {
  const paidTo = voucher.employeeName ?? voucher.payee ?? "—";
  const paidToKind = voucher.employeeName ? "Staff Member" : "Vendor / Other";

  return (
    <div className="min-h-screen bg-slate-50 print:bg-white">
      {/* ── Action bar (hidden on print) ───────────────────── */}
      <div className="max-w-4xl mx-auto px-6 pt-6 pb-3 print:hidden">
        <div className="flex items-center justify-between">
          <Link href="/accounts/expense" className="text-[13px] text-slate-500 hover:text-slate-800 transition-colors">
            ← Back to Expenses
          </Link>
          <PrintButtons targetId="voucher-printable" filename={voucher.voucherNumber || "voucher"} />
        </div>
      </div>

      {/* ── Printable document ─────────────────────────────── */}
      <div
        id="voucher-printable"
        className="max-w-4xl mx-auto bg-white border border-slate-200 rounded-xl shadow-sm
                   px-10 pt-8 pb-12 mb-10
                   print:max-w-none print:border-0 print:rounded-none print:shadow-none print:p-8 print:m-0"
      >
        {/* Letterhead */}
        <LetterHead />

        {/* Title bar */}
        <div className="mt-6 mb-6 text-center">
          <h2 className="text-[18px] font-bold text-slate-900 tracking-wide uppercase">
            Payment Voucher
          </h2>
        </div>

        {/* Voucher metadata: number + date */}
        <div className="grid grid-cols-2 gap-6 mb-6 text-[13px]">
          <div className="space-y-1">
            <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">Voucher No.</p>
            <p className="font-mono font-semibold text-slate-900">{voucher.voucherNumber}</p>
            <p className="font-mono text-[11.5px] text-slate-500">{toBengaliDigits(voucher.voucherNumber)}</p>
          </div>
          <div className="space-y-1 text-right">
            <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">Date</p>
            <p className="font-semibold text-slate-900">{formatDateLong(voucher.txnDate)}</p>
          </div>
        </div>

        {/* Paid to */}
        <div className="border-t border-slate-200 pt-5 mb-5">
          <div className="grid grid-cols-3 gap-6 text-[13px]">
            <div className="col-span-2 space-y-1">
              <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">Paid To</p>
              <p className="text-[15px] font-semibold text-slate-900">{paidTo}</p>
              <p className="text-[11px] text-slate-500">{paidToKind}</p>
            </div>
            <div className="space-y-1 text-right">
              <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">Payment Method</p>
              <p className="text-slate-800">Cash in Hand</p>
            </div>
          </div>
        </div>

        {/* Amount */}
        <div className="border-t border-slate-200 pt-5 mb-5 space-y-3">
          <div className="flex items-end justify-between">
            <div className="space-y-1">
              <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">Amount</p>
              <p className="text-[26px] font-bold text-slate-900 leading-none">
                ৳ {formatAmount(voucher.amount)}
              </p>
            </div>
            <p className="text-[11.5px] text-slate-500">In figures</p>
          </div>

          <div className="pt-2 space-y-2 text-[12.5px]">
            <div>
              <span className="text-[10.5px] font-semibold text-slate-400 uppercase tracking-wider">In words (English)</span>
              <p className="text-slate-800 italic mt-0.5">{amountToEnglishLakh(voucher.amount)}</p>
            </div>
            <div>
              <span className="text-[10.5px] font-semibold text-slate-400 uppercase tracking-wider">কথায় (বাংলা)</span>
              <p className="text-slate-800 italic mt-0.5">{amountToBengali(voucher.amount)}</p>
            </div>
          </div>
        </div>

        {/* Category + Item description */}
        <div className="border-t border-slate-200 pt-5 mb-5 space-y-3">
          <div className="grid grid-cols-3 gap-6 text-[13px]">
            <div className="col-span-1 space-y-1">
              <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">Category</p>
              <p className="text-slate-800 font-medium">{voucher.categoryName ?? "—"}</p>
            </div>
            <div className="col-span-2 space-y-1">
              <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">Description / Purpose</p>
              <p className="text-slate-800">{voucher.note?.trim() || "—"}</p>
            </div>
          </div>
        </div>

        {/* Signature lines */}
        <div className="mt-12 grid grid-cols-2 gap-12 text-[12px]">
          <div className="space-y-7">
            <div>
              <div className="border-t border-slate-700 pt-2">
                <p className="text-slate-600">Prepared by</p>
                <p className="text-slate-400 text-[10.5px] mt-0.5">{voucher.recordedByName ?? ""}</p>
              </div>
            </div>
          </div>
          <div className="space-y-7">
            <div>
              <div className="border-t border-slate-700 pt-2">
                <p className="text-slate-600 text-right">Received by</p>
                <p className="text-slate-400 text-[10.5px] mt-0.5 text-right">{paidTo}</p>
              </div>
            </div>
          </div>
        </div>

        {/* Print-only footer note */}
        <div className="hidden print:block mt-10 text-center text-[10px] text-slate-400">
          {voucher.voucherNumber} · Generated by Hotel Albatross Admin
        </div>

      </div>

      {/* ── Page-level print styles ───────────────────────────
          Tailwind print: utilities handle most cases inline. This
          block adds page-margin trimming and removes the page
          background when printing. Using a plain <style> tag with
          dangerouslySetInnerHTML to bypass JSX whitespace handling
          inside the CSS — styled-jsx isn't bundled in this project.
          ────────────────────────────────────────────────────── */}
      <style
        dangerouslySetInnerHTML={{
          __html: `
            @media print {
              @page { size: A4 portrait; margin: 12mm; }
              html, body { background: white !important; }
            }
          `,
        }}
      />
    </div>
  );
}

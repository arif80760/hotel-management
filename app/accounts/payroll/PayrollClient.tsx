"use client";

// app/accounts/payroll/PayrollClient.tsx
// Payroll subsection — placeholder until real feature ships.
//
// Per docs/architecture/accounts.md, this section will handle:
//   - Staff salary disbursement (linked to employees + their salary records)
//   - Monthly payroll cycle (run, review, disburse)
//   - Per-employee payment history

export default function PayrollClient() {
  return (
    <div className="p-8 space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-slate-800">Payroll</h1>
      </div>

      <div className="rounded-xl border border-dashed border-slate-200 bg-white px-6 py-12 flex flex-col items-center justify-center text-center">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="w-8 h-8 text-slate-300 mb-3">
          <circle cx="9" cy="8" r="3" />
          <path d="M3 21v-1a5 5 0 015-5h2a5 5 0 015 5v1" />
          <circle cx="17" cy="9" r="2.5" />
          <path d="M15 21v-0.5a4.5 4.5 0 014.5-4.5h0a4.5 4.5 0 014.5 4.5V21" transform="translate(-3 0)" />
        </svg>
        <p className="text-[14px] font-semibold text-slate-600 mb-1">Payroll Management</p>
        <p className="text-[12.5px] text-slate-400 max-w-md">
          Staff salary disbursement and monthly payroll cycles. Coming in a future build —
          this section is reserved.
        </p>
      </div>
    </div>
  );
}

"use client";

// app/accounts/expense/ExpenseClient.tsx
// Expense subsection — placeholder until real feature ships.
//
// Per docs/architecture/accounts.md, this section will handle:
//   - Expense voucher entry with sequential voucher numbers
//   - Expense categories
//   - Receipt image uploads (requires Supabase Pro upgrade)
//   - Cash-only spend enforcement (Cash in Hand is the only spendable bucket)

export default function ExpenseClient() {
  return (
    <div className="p-8 space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-slate-800">Expense</h1>
      </div>

      <div className="rounded-xl border border-dashed border-slate-200 bg-white px-6 py-12 flex flex-col items-center justify-center text-center">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="w-8 h-8 text-slate-300 mb-3">
          <rect x="3" y="6" width="18" height="14" rx="2" />
          <path d="M3 10h18" />
          <path d="M7 14h4" />
          <path d="M7 17h7" />
        </svg>
        <p className="text-[14px] font-semibold text-slate-600 mb-1">Expense Management</p>
        <p className="text-[12.5px] text-slate-400 max-w-md">
          Voucher entry, categorisation, and receipt uploads. Coming in a future build —
          this section is reserved.
        </p>
      </div>
    </div>
  );
}

"use client";

// app/accounts/revenue-management/RevenueManagementClient.tsx
// Revenue Management subsection — placeholder until real feature ships.
//
// Per docs/architecture/accounts.md, this section will handle:
//   - Revenue reporting and analysis
//   - Period summaries (daily / monthly / quarterly)
//   - Breakdown by source (room nights, extras, ancillary)

export default function RevenueManagementClient() {
  return (
    <div className="p-8 space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-slate-800">Revenue Management</h1>
      </div>

      <div className="rounded-xl border border-dashed border-slate-200 bg-white px-6 py-12 flex flex-col items-center justify-center text-center">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="w-8 h-8 text-slate-300 mb-3">
          <path d="M3 17l6-6 4 4 8-8" />
          <path d="M14 7h7v7" />
        </svg>
        <p className="text-[14px] font-semibold text-slate-600 mb-1">Revenue Management</p>
        <p className="text-[12.5px] text-slate-400 max-w-md">
          Revenue reporting, period summaries, and source breakdowns. Coming in a future build —
          this section is reserved.
        </p>
      </div>
    </div>
  );
}

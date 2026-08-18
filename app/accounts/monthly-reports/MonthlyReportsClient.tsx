"use client";

// app/accounts/monthly-reports/MonthlyReportsClient.tsx
//
// Monthly Reports picker — lists every month from live-operation start
// (July 2026, the launch month) to the current month, newest first, each
// linking to the printable /accounts/monthly-report/[month] document.
// Pure navigation; the report page computes everything itself.

import Link from "next/link";

// Same plain-local date convention as the other Accounts pages
// (per-feature helper duplication is this codebase's convention).
function currentMonthISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

const FIRST_MONTH = "2026-07";   // launch month (live operation began 30 Jul 2026)
const LAUNCH_NOTE_MONTH = "2026-07";

function monthList(): string[] {
  const months: string[] = [];
  let [y, m] = FIRST_MONTH.split("-").map(Number);
  const current = currentMonthISO();
  for (;;) {
    const iso = `${y}-${String(m).padStart(2, "0")}`;
    if (iso > current) break;
    months.push(iso);
    m += 1; if (m > 12) { m = 1; y += 1; }
  }
  return months.reverse();   // newest first
}

function monthLabel(month: string): string {
  return new Date(`${month}-01T12:00:00`).toLocaleDateString("en-GB", { month: "long", year: "numeric" });
}

export default function MonthlyReportsClient() {
  const months = monthList();
  const current = currentMonthISO();

  return (
    <div className="max-w-2xl mx-auto">
      <div className="mb-5">
        <h1 className="text-lg font-bold text-slate-800">Monthly Reports</h1>
        <p className="text-[12.5px] text-slate-500">
          Printable owner summary per month — occupancy, collections, expenses by kind, dues movement,
          with month-over-month comparison.
        </p>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl divide-y divide-slate-100">
        {months.map((month) => (
          <Link
            key={month}
            href={`/accounts/monthly-report/${month}`}
            className="flex items-center justify-between px-4 py-3.5 min-h-[44px] hover:bg-slate-50 transition-colors"
          >
            <span className="text-[13.5px] font-medium text-slate-800">
              {monthLabel(month)}
              {month === current && (
                <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 ring-1 ring-amber-200 text-[10.5px] font-semibold uppercase tracking-wider">In progress</span>
              )}
              {month === LAUNCH_NOTE_MONTH && (
                <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 text-[10.5px] font-semibold uppercase tracking-wider">Includes test data</span>
              )}
            </span>
            <span className="text-[12px] text-slate-400">View / print →</span>
          </Link>
        ))}
      </div>
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import { listLoans, type LoanWithStatus } from "@/services/loansService";

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}
function taka(n: number): string { return `৳${n.toLocaleString()}`; }

export default function LoansClient() {
  const [loans, setLoans]     = useState<LoanWithStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try { const d = await listLoans(); if (!cancelled) setLoans(d); }
      catch (err) { if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load loans."); }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, []);

  const totalOutstanding = loans.reduce((s, l) => s + l.outstanding, 0);

  return (
    <div className="max-w-5xl mx-auto px-6 py-8 space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <h1 className="text-[20px] font-semibold text-slate-800">Loans</h1>
          {totalOutstanding > 0 && (
            <span className="inline-block px-2.5 py-1 rounded-full bg-amber-50 border border-amber-200 text-amber-700 text-[12px] font-semibold">{taka(totalOutstanding)} outstanding</span>
          )}
        </div>
        <span className="text-[12px] text-slate-400">Record loans from the Cashbook</span>
      </div>

      {error && <div className="bg-rose-50 border border-rose-200 rounded-lg px-3 py-2 text-[12.5px] text-rose-700">{error}</div>}

      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        {loading ? (
          <div className="px-5 py-10 text-[13px] text-slate-500 text-center">Loading…</div>
        ) : loans.length === 0 ? (
          <div className="px-5 py-10 text-[13px] text-slate-500 text-center">No loans recorded yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-left text-[11px] font-semibold uppercase tracking-wider text-slate-400 border-b border-slate-100">
                  <th className="px-5 py-2.5">Lender</th>
                  <th className="px-5 py-2.5 text-right">Principal</th>
                  <th className="px-5 py-2.5">Received</th>
                  <th className="px-5 py-2.5">Due</th>
                  <th className="px-5 py-2.5 text-right">Repaid</th>
                  <th className="px-5 py-2.5 text-right">Outstanding</th>
                  <th className="px-5 py-2.5">Status</th>
                </tr>
              </thead>
              <tbody>
                {loans.map((l) => (
                  <tr key={l.id} className="border-b border-slate-50 last:border-0">
                    <td className="px-5 py-3 font-medium text-slate-800">{l.lenderName}{l.note && <span className="block text-[11.5px] font-normal text-slate-400">{l.note}</span>}</td>
                    <td className="px-5 py-3 text-right text-slate-700 whitespace-nowrap">{taka(l.principal)}</td>
                    <td className="px-5 py-3 text-slate-600 whitespace-nowrap">{fmtDate(l.receivedDate)}</td>
                    <td className="px-5 py-3 text-slate-600 whitespace-nowrap">{fmtDate(l.dueDate)}</td>
                    <td className="px-5 py-3 text-right text-slate-600 whitespace-nowrap">{taka(l.repaid)}</td>
                    <td className={`px-5 py-3 text-right font-semibold whitespace-nowrap ${l.outstanding > 0 ? "text-amber-700" : "text-slate-400"}`}>{taka(l.outstanding)}</td>
                    <td className="px-5 py-3"><span className={`inline-block px-2 py-0.5 rounded-full border text-[11px] font-semibold ${l.status === "repaid" ? "bg-emerald-50 border-emerald-200 text-emerald-700" : "bg-amber-50 border-amber-200 text-amber-700"}`}>{l.status === "repaid" ? "Repaid" : "Outstanding"}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

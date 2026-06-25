"use client";

import { useEffect, useState, useCallback, useMemo, Fragment } from "react";
import {
  listLoans,
  getLoanRepayments,
  type LoanWithStatus,
  type LoanRepayment,
} from "@/services/loansService";
import { useReferenceData } from "@/contexts/ReferenceDataContext";

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}
function taka(n: number): string { return `৳${n.toLocaleString()}`; }

export default function LoansClient() {
  const [loans, setLoans]     = useState<LoanWithStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

  // account id -> display name (Cash / Bank / bKash / Nagad) — from session cache
  const { accountDefs } = useReferenceData();
  const accountNames = useMemo(() => {
    const map: Record<string, string> = {};
    for (const a of accountDefs) map[a.id] = a.name;
    return map;
  }, [accountDefs]);

  // repayment-history drill-down
  const [expandedId, setExpandedId]           = useState<string | null>(null);
  const [repaymentsByLoan, setRepaymentsByLoan] = useState<Record<string, LoanRepayment[]>>({});
  const [loadingLoanId, setLoadingLoanId]     = useState<string | null>(null);
  const [historyError, setHistoryError]       = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const loanData = await listLoans();
        if (cancelled) return;
        setLoans(loanData);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load loans.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const totalOutstanding = loans.reduce((s, l) => s + l.outstanding, 0);

  const toggleExpand = useCallback(async (loanId: string) => {
    if (expandedId === loanId) { setExpandedId(null); return; }
    setExpandedId(loanId);
    if (!repaymentsByLoan[loanId]) {
      setLoadingLoanId(loanId);
      try {
        const reps = await getLoanRepayments(loanId);
        setRepaymentsByLoan((prev) => ({ ...prev, [loanId]: reps }));
        setHistoryError((prev) => { const n = { ...prev }; delete n[loanId]; return n; });
      } catch (err) {
        setHistoryError((prev) => ({
          ...prev,
          [loanId]: err instanceof Error ? err.message : "Failed to load repayments.",
        }));
      } finally {
        setLoadingLoanId(null);
      }
    }
  }, [expandedId, repaymentsByLoan]);

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
                  <th className="px-3 py-2.5 w-8"></th>
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
                {loans.map((l) => {
                  const isOpen = expandedId === l.id;
                  const reps   = repaymentsByLoan[l.id];
                  const isLoadingReps = loadingLoanId === l.id;
                  const histErr = historyError[l.id];
                  return (
                    <Fragment key={l.id}>
                      <tr
                        onClick={() => toggleExpand(l.id)}
                        className={`border-b border-slate-50 last:border-0 cursor-pointer transition-colors ${isOpen ? "bg-slate-50" : "hover:bg-slate-50/60"}`}
                      >
                        <td className="px-3 py-3 text-slate-400">
                          <svg
                            viewBox="0 0 20 20" fill="currentColor"
                            className={`w-4 h-4 transition-transform ${isOpen ? "rotate-90" : ""}`}
                            aria-hidden="true"
                          >
                            <path fillRule="evenodd" d="M7.21 14.77a.75.75 0 0 1 .02-1.06L11.168 10 7.23 6.29a.75.75 0 1 1 1.04-1.08l4.5 4.25a.75.75 0 0 1 0 1.08l-4.5 4.25a.75.75 0 0 1-1.06-.02Z" clipRule="evenodd" />
          </svg>
                        </td>
                        <td className="px-5 py-3 font-medium text-slate-800">{l.lenderName}{l.note && <span className="block text-[11.5px] font-normal text-slate-400">{l.note}</span>}</td>
                        <td className="px-5 py-3 text-right text-slate-700 whitespace-nowrap">{taka(l.principal)}</td>
                        <td className="px-5 py-3 text-slate-600 whitespace-nowrap">{fmtDate(l.receivedDate)}</td>
                        <td className="px-5 py-3 text-slate-600 whitespace-nowrap">{fmtDate(l.dueDate)}</td>
                        <td className="px-5 py-3 text-right text-slate-600 whitespace-nowrap">{taka(l.repaid)}</td>
                        <td className={`px-5 py-3 text-right font-semibold whitespace-nowrap ${l.outstanding > 0 ? "text-amber-700" : "text-slate-400"}`}>{taka(l.outstanding)}</td>
                        <td className="px-5 py-3"><span className={`inline-block px-2 py-0.5 rounded-full border text-[11px] font-semibold ${l.status === "repaid" ? "bg-emerald-50 border-emerald-200 text-emerald-700" : "bg-amber-50 border-amber-200 text-amber-700"}`}>{l.status === "repaid" ? "Repaid" : "Outstanding"}</span></td>
                      </tr>

                      {isOpen && (
                        <tr className="bg-slate-50/60">
                          <td colSpan={8} className="px-5 pb-4 pt-1">
                            {isLoadingReps ? (
                              <div className="py-4 text-[12.5px] text-slate-500">Loading repayments…</div>
                            ) : histErr ? (
                              <div className="py-3 text-[12.5px] text-rose-700">{histErr}</div>
                            ) : !reps || reps.length === 0 ? (
                              <div className="py-4 text-[12.5px] text-slate-500">No repayments recorded against this loan yet.</div>
                            ) : (
                              <RepaymentTimeline loan={l} repayments={reps} accountNames={accountNames} />
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function RepaymentTimeline({
  loan, repayments, accountNames,
}: {
  loan: LoanWithStatus;
  repayments: LoanRepayment[];
  accountNames: Record<string, string>;
}) {
  // getLoanRepayments returns newest-first; show oldest-first so the running
  // balance reads naturally from principal down to outstanding.
  const ordered = [...repayments].reverse();
  let running = loan.principal;
  const rows = ordered.map((r) => {
    running = Math.max(0, running - r.amount);
    return { r, balanceAfter: running };
  });

  return (
    <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
      <div className="px-4 py-2 text-[11.5px] text-slate-500 bg-slate-50 border-b border-slate-100">
        Principal {taka(loan.principal)} · {repayments.length} repayment{repayments.length === 1 ? "" : "s"} · {taka(loan.outstanding)} outstanding
      </div>
      <table className="w-full text-[12.5px]">
        <thead>
          <tr className="text-left text-[10.5px] font-semibold uppercase tracking-wider text-slate-400 border-b border-slate-100">
            <th className="px-4 py-2">Date</th>
            <th className="px-4 py-2">Paid from</th>
            <th className="px-4 py-2 text-right">Amount</th>
            <th className="px-4 py-2 text-right">Balance after</th>
            <th className="px-4 py-2">Note</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ r, balanceAfter }) => (
            <tr key={r.id} className="border-b border-slate-50 last:border-0">
              <td className="px-4 py-2 text-slate-600 whitespace-nowrap">{fmtDate(r.txnDate)}</td>
              <td className="px-4 py-2 text-slate-600 whitespace-nowrap">{accountNames[r.fromAccountId] ?? "—"}</td>
              <td className="px-4 py-2 text-right text-rose-600 whitespace-nowrap">−{taka(r.amount)}</td>
              <td className="px-4 py-2 text-right text-slate-700 font-medium whitespace-nowrap">{taka(balanceAfter)}</td>
              <td className="px-4 py-2 text-slate-500">{r.note ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import {
  listLoans, createLoan, recordLoanRepayment,
  type LoanWithStatus,
} from "@/services/loansService";
import { ACCOUNT_IDS } from "@/services/accountsService";

function todayISO(): string { return new Date().toISOString().slice(0, 10); }
function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}
function taka(n: number): string { return `৳${n.toLocaleString()}`; }
const inputCls = (err: boolean) =>
  `w-full rounded-lg border px-3 py-2 text-[13px] text-slate-800 focus:outline-none focus:ring-2 ${
    err ? "border-rose-300 focus:ring-rose-200" : "border-slate-300 focus:ring-indigo-200"}`;

export default function LoansClient() {
  const [loans, setLoans]     = useState<LoanWithStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const [loanModalOpen, setLoanModalOpen] = useState(false);
  const [lenderName, setLenderName] = useState("");
  const [principal, setPrincipal]   = useState("");
  const [receivedDate, setReceivedDate] = useState<string>(todayISO());
  const [dueDate, setDueDate]       = useState("");
  const [loanNote, setLoanNote]     = useState("");
  const [creatingLoan, setCreatingLoan] = useState(false);
  const [loanError, setLoanError]   = useState<string | null>(null);
  const [loanFieldErrors, setLoanFieldErrors] = useState<{ lender?: string; principal?: string; date?: string }>({});

  const [repayModalOpen, setRepayModalOpen] = useState(false);
  const [repayLoan, setRepayLoan]   = useState<LoanWithStatus | null>(null);
  const [repayAmount, setRepayAmount] = useState("");
  const [repayDate, setRepayDate]   = useState<string>(todayISO());
  const [repayNote, setRepayNote]   = useState("");
  const [savingRepay, setSavingRepay] = useState(false);
  const [repayError, setRepayError] = useState<string | null>(null);
  const [repayFieldErrors, setRepayFieldErrors] = useState<{ amount?: string; date?: string }>({});

  async function reload() {
    try { setLoans(await listLoans()); }
    catch (err) { setError(err instanceof Error ? err.message : "Failed to load loans."); }
  }
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

  function openLoanModal() {
    setLoanModalOpen(true);
    setLenderName(""); setPrincipal(""); setReceivedDate(todayISO()); setDueDate(""); setLoanNote("");
    setLoanError(null); setLoanFieldErrors({});
  }
  function closeLoanModal() { if (creatingLoan) return; setLoanModalOpen(false); }
  async function handleCreateLoan() {
    const fe: { lender?: string; principal?: string; date?: string } = {};
    if (!lenderName.trim()) fe.lender = "Lender is required.";
    const p = parseFloat(principal);
    if (!principal.trim() || isNaN(p) || p <= 0) fe.principal = "Principal must be > 0.";
    if (!receivedDate) fe.date = "Received date is required.";
    if (Object.keys(fe).length) { setLoanFieldErrors(fe); return; }
    setLoanFieldErrors({}); setLoanError(null); setCreatingLoan(true);
    try {
      await createLoan({ lenderName: lenderName.trim(), principal: p, receivedDate, dueDate: dueDate || undefined, note: loanNote.trim() || undefined, toAccountId: ACCOUNT_IDS.cash });
      setSuccessMsg("Loan recorded."); setLoanModalOpen(false); await reload();
    } catch (err) { setLoanError(err instanceof Error ? err.message : "Failed to record loan."); }
    finally { setCreatingLoan(false); }
  }

  function openRepayModal(loan: LoanWithStatus) {
    setRepayLoan(loan); setRepayModalOpen(true);
    setRepayAmount(""); setRepayDate(todayISO()); setRepayNote("");
    setRepayError(null); setRepayFieldErrors({});
  }
  function closeRepayModal() { if (savingRepay) return; setRepayModalOpen(false); setRepayLoan(null); }
  async function handleRepay() {
    if (!repayLoan) return;
    const fe: { amount?: string; date?: string } = {};
    const a = parseFloat(repayAmount);
    if (!repayAmount.trim() || isNaN(a) || a <= 0) fe.amount = "Amount must be > 0.";
    if (!repayDate) fe.date = "Date is required.";
    if (Object.keys(fe).length) { setRepayFieldErrors(fe); return; }
    setRepayFieldErrors({}); setRepayError(null); setSavingRepay(true);
    try {
      await recordLoanRepayment({ loanId: repayLoan.id, amount: a, txnDate: repayDate, note: repayNote.trim() || undefined, fromAccountId: ACCOUNT_IDS.cash });
      setSuccessMsg("Repayment recorded."); setRepayModalOpen(false); setRepayLoan(null); await reload();
    } catch (err) { setRepayError(err instanceof Error ? err.message : "Failed to record repayment."); }
    finally { setSavingRepay(false); }
  }

  return (
    <div className="max-w-5xl mx-auto px-6 py-8 space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <h1 className="text-[20px] font-semibold text-slate-800">Loans</h1>
          {totalOutstanding > 0 && (
            <span className="inline-block px-2.5 py-1 rounded-full bg-amber-50 border border-amber-200 text-amber-700 text-[12px] font-semibold">{taka(totalOutstanding)} outstanding</span>
          )}
        </div>
        <button type="button" onClick={openLoanModal} className="px-4 py-2 rounded-lg bg-indigo-700 text-white text-[13px] font-semibold hover:bg-indigo-800 transition-colors">+ Record Loan</button>
      </div>

      {successMsg && <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 text-[12.5px] text-emerald-700">{successMsg}</div>}
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
                  <th className="px-5 py-2.5"></th>
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
                    <td className="px-5 py-3 text-right">{l.status === "outstanding" && (<button type="button" onClick={() => openRepayModal(l)} className="px-3 py-1.5 rounded-lg bg-white border border-indigo-200 text-indigo-700 text-[12px] font-semibold hover:bg-indigo-50 transition-colors">Repay</button>)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {loanModalOpen && (
        <div className="fixed inset-0 bg-slate-900/40 flex items-center justify-center z-50 p-6" onClick={closeLoanModal}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
              <h2 className="text-[15px] font-semibold text-slate-800">Record Loan</h2>
              <button type="button" onClick={closeLoanModal} disabled={creatingLoan} className="text-slate-400 hover:text-slate-700 disabled:opacity-40" aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-5 h-5"><path d="M18 6L6 18M6 6l12 12" /></svg></button>
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
              <div className="space-y-1">
                <label className="block text-[12px] font-semibold text-slate-500 uppercase tracking-wider">Lender</label>
                <input type="text" value={lenderName} onChange={(e) => setLenderName(e.target.value)} placeholder="Who is the loan from?" disabled={creatingLoan} className={inputCls(!!loanFieldErrors.lender)} />
                {loanFieldErrors.lender && <p className="text-[11.5px] text-rose-600">{loanFieldErrors.lender}</p>}
              </div>
              <div className="space-y-1">
                <label className="block text-[12px] font-semibold text-slate-500 uppercase tracking-wider">Principal (৳)</label>
                <input type="number" inputMode="decimal" step="0.01" min="0.01" value={principal} onChange={(e) => setPrincipal(e.target.value)} placeholder="0" disabled={creatingLoan} className={inputCls(!!loanFieldErrors.principal)} />
                {loanFieldErrors.principal && <p className="text-[11.5px] text-rose-600">{loanFieldErrors.principal}</p>}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="block text-[12px] font-semibold text-slate-500 uppercase tracking-wider">Received date</label>
                  <input type="date" value={receivedDate} max={todayISO()} onChange={(e) => setReceivedDate(e.target.value)} disabled={creatingLoan} className={inputCls(!!loanFieldErrors.date)} />
                  {loanFieldErrors.date && <p className="text-[11.5px] text-rose-600">{loanFieldErrors.date}</p>}
                </div>
                <div className="space-y-1">
                  <label className="block text-[12px] font-semibold text-slate-500 uppercase tracking-wider">Due date (optional)</label>
                  <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} disabled={creatingLoan} className={inputCls(false)} />
                </div>
              </div>
              <div className="space-y-1">
                <label className="block text-[12px] font-semibold text-slate-500 uppercase tracking-wider">Note (optional)</label>
                <input type="text" value={loanNote} onChange={(e) => setLoanNote(e.target.value)} placeholder="e.g. For lift-motor repair" disabled={creatingLoan} className={inputCls(false)} />
              </div>
              <p className="text-[11.5px] text-slate-400">Added to Cash in Hand as a loan-received entry; not counted as revenue.</p>
              {loanError && <div className="bg-rose-50 border border-rose-200 rounded-lg px-3 py-2 text-[12px] text-rose-700">{loanError}</div>}
            </div>
            <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-slate-200">
              <button type="button" onClick={closeLoanModal} disabled={creatingLoan} className="px-4 py-2 rounded-lg text-slate-600 hover:bg-slate-100 text-[13px] font-semibold disabled:opacity-40">Cancel</button>
              <button type="button" onClick={handleCreateLoan} disabled={creatingLoan} className="px-4 py-2 rounded-lg bg-indigo-700 text-white text-[13px] font-semibold hover:bg-indigo-800 disabled:opacity-40">{creatingLoan ? "Saving…" : "Record Loan"}</button>
            </div>
          </div>
        </div>
      )}

      {repayModalOpen && repayLoan && (
        <div className="fixed inset-0 bg-slate-900/40 flex items-center justify-center z-50 p-6" onClick={closeRepayModal}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
              <h2 className="text-[15px] font-semibold text-slate-800">Repay Loan</h2>
              <button type="button" onClick={closeRepayModal} disabled={savingRepay} className="text-slate-400 hover:text-slate-700 disabled:opacity-40" aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-5 h-5"><path d="M18 6L6 18M6 6l12 12" /></svg></button>
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
              <div className="rounded-lg bg-slate-50 border border-slate-200 px-3 py-2.5 text-[12.5px] text-slate-600"><span className="font-semibold text-slate-800">{repayLoan.lenderName}</span> · principal {taka(repayLoan.principal)} · outstanding <span className="font-semibold text-amber-700">{taka(repayLoan.outstanding)}</span></div>
              <div className="space-y-1">
                <label className="block text-[12px] font-semibold text-slate-500 uppercase tracking-wider">Repayment amount (৳)</label>
                <input type="number" inputMode="decimal" step="0.01" min="0.01" value={repayAmount} onChange={(e) => setRepayAmount(e.target.value)} placeholder="0" disabled={savingRepay} className={inputCls(!!repayFieldErrors.amount)} />
                {repayFieldErrors.amount && <p className="text-[11.5px] text-rose-600">{repayFieldErrors.amount}</p>}
                {repayAmount && parseFloat(repayAmount) > repayLoan.outstanding && (<p className="text-[11.5px] text-amber-700">More than the {taka(repayLoan.outstanding)} outstanding — this will overpay the loan.</p>)}
              </div>
              <div className="space-y-1">
                <label className="block text-[12px] font-semibold text-slate-500 uppercase tracking-wider">Date</label>
                <input type="date" value={repayDate} max={todayISO()} onChange={(e) => setRepayDate(e.target.value)} disabled={savingRepay} className={inputCls(!!repayFieldErrors.date)} />
                {repayFieldErrors.date && <p className="text-[11.5px] text-rose-600">{repayFieldErrors.date}</p>}
              </div>
              <div className="space-y-1">
                <label className="block text-[12px] font-semibold text-slate-500 uppercase tracking-wider">Note (optional)</label>
                <input type="text" value={repayNote} onChange={(e) => setRepayNote(e.target.value)} placeholder="e.g. Second installment" disabled={savingRepay} className={inputCls(false)} />
              </div>
              <p className="text-[11.5px] text-slate-400">Deducted from Cash in Hand as a loan-repayment entry; not counted as an expense.</p>
              {repayError && <div className="bg-rose-50 border border-rose-200 rounded-lg px-3 py-2 text-[12px] text-rose-700">{repayError}</div>}
            </div>
            <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-slate-200">
              <button type="button" onClick={closeRepayModal} disabled={savingRepay} className="px-4 py-2 rounded-lg text-slate-600 hover:bg-slate-100 text-[13px] font-semibold disabled:opacity-40">Cancel</button>
              <button type="button" onClick={handleRepay} disabled={savingRepay} className="px-4 py-2 rounded-lg bg-indigo-700 text-white text-[13px] font-semibold hover:bg-indigo-800 disabled:opacity-40">{savingRepay ? "Saving…" : "Record Repayment"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

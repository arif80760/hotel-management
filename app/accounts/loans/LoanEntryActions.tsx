"use client";

import { useEffect, useState } from "react";
import {
  listLoans, createLoan, recordLoanRepayment,
  type LoanWithStatus,
} from "@/services/loansService";
import { ACCOUNT_IDS } from "@/services/accountsService";

function todayISO(): string { return new Date().toISOString().slice(0, 10); }
function taka(n: number): string { return `৳${n.toLocaleString()}`; }
const inputCls = (err: boolean) =>
  `w-full rounded-lg border px-3 py-2 text-[13px] text-slate-800 focus:outline-none focus:ring-2 ${
    err ? "border-rose-300 focus:ring-rose-200" : "border-slate-300 focus:ring-indigo-200"}`;

export default function LoanEntryActions({ onRecorded }: { onRecorded?: () => void }) {
  const [outstanding, setOutstanding] = useState<LoanWithStatus[]>([]);
  async function loadOutstanding() {
    try { const all = await listLoans(); setOutstanding(all.filter((l) => l.status === "outstanding")); }
    catch { /* non-blocking */ }
  }
  useEffect(() => { loadOutstanding(); }, []);

  // ── Record loan ──
  const [loanOpen, setLoanOpen] = useState(false);
  const [lenderName, setLenderName] = useState("");
  const [principal, setPrincipal] = useState("");
  const [receivedDate, setReceivedDate] = useState(todayISO());
  const [dueDate, setDueDate] = useState("");
  const [loanNote, setLoanNote] = useState("");
  const [creatingLoan, setCreatingLoan] = useState(false);
  const [loanErr, setLoanErr] = useState<string | null>(null);
  const [loanFE, setLoanFE] = useState<{ lender?: string; principal?: string; date?: string }>({});

  function openLoan() {
    setLoanOpen(true);
    setLenderName(""); setPrincipal(""); setReceivedDate(todayISO()); setDueDate(""); setLoanNote("");
    setLoanErr(null); setLoanFE({});
  }
  function closeLoan() { if (creatingLoan) return; setLoanOpen(false); }
  async function submitLoan() {
    const fe: { lender?: string; principal?: string; date?: string } = {};
    if (!lenderName.trim()) fe.lender = "Lender is required.";
    const p = parseFloat(principal);
    if (!principal.trim() || isNaN(p) || p <= 0) fe.principal = "Principal must be > 0.";
    if (!receivedDate) fe.date = "Received date is required.";
    if (Object.keys(fe).length) { setLoanFE(fe); return; }
    setLoanFE({}); setLoanErr(null); setCreatingLoan(true);
    try {
      await createLoan({ lenderName: lenderName.trim(), principal: p, receivedDate, dueDate: dueDate || undefined, note: loanNote.trim() || undefined, toAccountId: ACCOUNT_IDS.cash });
      setLoanOpen(false); await loadOutstanding(); onRecorded?.();
    } catch (err) { setLoanErr(err instanceof Error ? err.message : "Failed to record loan."); }
    finally { setCreatingLoan(false); }
  }

  // ── Repay ──
  const [repayOpen, setRepayOpen] = useState(false);
  const [repayLoanId, setRepayLoanId] = useState("");
  const [repayAmount, setRepayAmount] = useState("");
  const [repayDate, setRepayDate] = useState(todayISO());
  const [repayNote, setRepayNote] = useState("");
  const [savingRepay, setSavingRepay] = useState(false);
  const [repayErr, setRepayErr] = useState<string | null>(null);
  const [repayFE, setRepayFE] = useState<{ loan?: string; amount?: string; date?: string }>({});

  const selectedLoan = outstanding.find((l) => l.id === repayLoanId) ?? null;

  function openRepay() {
    setRepayOpen(true);
    setRepayLoanId(""); setRepayAmount(""); setRepayDate(todayISO()); setRepayNote("");
    setRepayErr(null); setRepayFE({});
  }
  function closeRepay() { if (savingRepay) return; setRepayOpen(false); }
  async function submitRepay() {
    const fe: { loan?: string; amount?: string; date?: string } = {};
    if (!repayLoanId) fe.loan = "Select a loan.";
    const a = parseFloat(repayAmount);
    if (!repayAmount.trim() || isNaN(a) || a <= 0) fe.amount = "Amount must be > 0.";
    if (!repayDate) fe.date = "Date is required.";
    if (Object.keys(fe).length) { setRepayFE(fe); return; }
    setRepayFE({}); setRepayErr(null); setSavingRepay(true);
    try {
      await recordLoanRepayment({ loanId: repayLoanId, amount: a, txnDate: repayDate, note: repayNote.trim() || undefined, fromAccountId: ACCOUNT_IDS.cash });
      setRepayOpen(false); await loadOutstanding(); onRecorded?.();
    } catch (err) { setRepayErr(err instanceof Error ? err.message : "Failed to record repayment."); }
    finally { setSavingRepay(false); }
  }

  return (
    <>
      <div className="flex items-center gap-2">
        <button type="button" onClick={openLoan} className="px-3 py-2 rounded-lg bg-white border border-indigo-200 text-indigo-700 text-[13px] font-semibold hover:bg-indigo-50 transition-colors">+ Loan received</button>
        <button type="button" onClick={openRepay} disabled={outstanding.length === 0} title={outstanding.length === 0 ? "No outstanding loans" : undefined} className="px-3 py-2 rounded-lg bg-white border border-indigo-200 text-indigo-700 text-[13px] font-semibold hover:bg-indigo-50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">Loan repayment</button>
      </div>

      {loanOpen && (
        <div className="fixed inset-0 bg-slate-900/40 flex items-center justify-center z-50 p-6" onClick={closeLoan}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
              <h2 className="text-[15px] font-semibold text-slate-800">Loan Received</h2>
              <button type="button" onClick={closeLoan} disabled={creatingLoan} className="text-slate-400 hover:text-slate-700 disabled:opacity-40" aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-5 h-5"><path d="M18 6L6 18M6 6l12 12" /></svg></button>
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
              <div className="space-y-1">
                <label className="block text-[12px] font-semibold text-slate-500 uppercase tracking-wider">Lender</label>
                <input type="text" value={lenderName} onChange={(e) => setLenderName(e.target.value)} placeholder="Who is the loan from?" disabled={creatingLoan} className={inputCls(!!loanFE.lender)} />
                {loanFE.lender && <p className="text-[11.5px] text-rose-600">{loanFE.lender}</p>}
              </div>
              <div className="space-y-1">
                <label className="block text-[12px] font-semibold text-slate-500 uppercase tracking-wider">Principal (৳)</label>
                <input type="number" inputMode="decimal" step="0.01" min="0.01" value={principal} onChange={(e) => setPrincipal(e.target.value)} placeholder="0" disabled={creatingLoan} className={inputCls(!!loanFE.principal)} />
                {loanFE.principal && <p className="text-[11.5px] text-rose-600">{loanFE.principal}</p>}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="block text-[12px] font-semibold text-slate-500 uppercase tracking-wider">Received date</label>
                  <input type="date" value={receivedDate} max={todayISO()} onChange={(e) => setReceivedDate(e.target.value)} disabled={creatingLoan} className={inputCls(!!loanFE.date)} />
                  {loanFE.date && <p className="text-[11.5px] text-rose-600">{loanFE.date}</p>}
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
              <p className="text-[11.5px] text-slate-400">Adds to Cash in Hand as a loan-received entry; not counted as revenue.</p>
              {loanErr && <div className="bg-rose-50 border border-rose-200 rounded-lg px-3 py-2 text-[12px] text-rose-700">{loanErr}</div>}
            </div>
            <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-slate-200">
              <button type="button" onClick={closeLoan} disabled={creatingLoan} className="px-4 py-2 rounded-lg text-slate-600 hover:bg-slate-100 text-[13px] font-semibold disabled:opacity-40">Cancel</button>
              <button type="button" onClick={submitLoan} disabled={creatingLoan} className="px-4 py-2 rounded-lg bg-indigo-700 text-white text-[13px] font-semibold hover:bg-indigo-800 disabled:opacity-40">{creatingLoan ? "Saving…" : "Record"}</button>
            </div>
          </div>
        </div>
      )}

      {repayOpen && (
        <div className="fixed inset-0 bg-slate-900/40 flex items-center justify-center z-50 p-6" onClick={closeRepay}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
              <h2 className="text-[15px] font-semibold text-slate-800">Loan Repayment</h2>
              <button type="button" onClick={closeRepay} disabled={savingRepay} className="text-slate-400 hover:text-slate-700 disabled:opacity-40" aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-5 h-5"><path d="M18 6L6 18M6 6l12 12" /></svg></button>
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
              <div className="space-y-1">
                <label className="block text-[12px] font-semibold text-slate-500 uppercase tracking-wider">Which loan</label>
                <select value={repayLoanId} onChange={(e) => setRepayLoanId(e.target.value)} disabled={savingRepay} className={inputCls(!!repayFE.loan)}>
                  <option value="">Select an outstanding loan…</option>
                  {outstanding.map((l) => <option key={l.id} value={l.id}>{l.lenderName} — {taka(l.outstanding)} outstanding</option>)}
                </select>
                {repayFE.loan && <p className="text-[11.5px] text-rose-600">{repayFE.loan}</p>}
              </div>
              <div className="space-y-1">
                <label className="block text-[12px] font-semibold text-slate-500 uppercase tracking-wider">Repayment amount (৳)</label>
                <input type="number" inputMode="decimal" step="0.01" min="0.01" value={repayAmount} onChange={(e) => setRepayAmount(e.target.value)} placeholder="0" disabled={savingRepay} className={inputCls(!!repayFE.amount)} />
                {repayFE.amount && <p className="text-[11.5px] text-rose-600">{repayFE.amount}</p>}
                {selectedLoan && repayAmount && parseFloat(repayAmount) > selectedLoan.outstanding && (<p className="text-[11.5px] text-amber-700">More than the {taka(selectedLoan.outstanding)} outstanding — this will overpay the loan.</p>)}
              </div>
              <div className="space-y-1">
                <label className="block text-[12px] font-semibold text-slate-500 uppercase tracking-wider">Date</label>
                <input type="date" value={repayDate} max={todayISO()} onChange={(e) => setRepayDate(e.target.value)} disabled={savingRepay} className={inputCls(!!repayFE.date)} />
                {repayFE.date && <p className="text-[11.5px] text-rose-600">{repayFE.date}</p>}
              </div>
              <div className="space-y-1">
                <label className="block text-[12px] font-semibold text-slate-500 uppercase tracking-wider">Note (optional)</label>
                <input type="text" value={repayNote} onChange={(e) => setRepayNote(e.target.value)} placeholder="e.g. Second installment" disabled={savingRepay} className={inputCls(false)} />
              </div>
              <p className="text-[11.5px] text-slate-400">Deducts from Cash in Hand as a loan-repayment entry; not counted as an expense.</p>
              {repayErr && <div className="bg-rose-50 border border-rose-200 rounded-lg px-3 py-2 text-[12px] text-rose-700">{repayErr}</div>}
            </div>
            <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-slate-200">
              <button type="button" onClick={closeRepay} disabled={savingRepay} className="px-4 py-2 rounded-lg text-slate-600 hover:bg-slate-100 text-[13px] font-semibold disabled:opacity-40">Cancel</button>
              <button type="button" onClick={submitRepay} disabled={savingRepay} className="px-4 py-2 rounded-lg bg-indigo-700 text-white text-[13px] font-semibold hover:bg-indigo-800 disabled:opacity-40">{savingRepay ? "Saving…" : "Record"}</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

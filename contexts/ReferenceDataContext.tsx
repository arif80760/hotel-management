"use client";

// contexts/ReferenceDataContext.tsx
//
// Session-level cache for STATIC reference data that does not change during a
// normal session: account definitions, expense categories, revenue categories.
// Loaded ONCE when the authenticated shell mounts and shared across every page,
// so navigating between account pages no longer refetches this data on each
// mount.
//
// WHAT THIS CACHES (definitions / reference lists only — all read-only):
//   • accountDefs       — accounts (id, name, is_spendable) via getAccounts()
//   • expenseCategories — getExpenseCategories() result (full rows)
//   • revenueCategories — getRevenueCategories() result (full rows)
//
// WHAT THIS DELIBERATELY DOES NOT CACHE (must stay live, fetched per page):
//   • account_balances / getBalances()  — live money
//   • account_transactions              — live ledger
//   • day_closes                        — live day-close state
//   • bookings                          — owned by HotelContext
//
// Pages that MUTATE categories (create/edit/toggle) call the matching refresh()
// after their write so the cache (and every page reading from it) stays current.
// refresh() is a read-after-write re-fetch — it performs no writes itself.

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useMemo,
  type ReactNode,
} from "react";
import { getAccounts,           type Account }         from "@/services/accountsService";
import { getExpenseCategories,  type ExpenseCategory } from "@/services/expenseCategoriesService";
import { getRevenueCategories,  type RevenueCategory } from "@/services/revenueCategoriesService";

type ReferenceDataContextType = {
  accountDefs:       Account[];           // definitions only (id, name, isSpendable) — NO balances
  expenseCategories: ExpenseCategory[];
  revenueCategories: RevenueCategory[];
  loading:           boolean;             // true until the initial load completes
  refreshAccounts:          () => Promise<void>;
  refreshExpenseCategories: () => Promise<void>;
  refreshRevenueCategories: () => Promise<void>;
};

const ReferenceDataContext = createContext<ReferenceDataContextType | null>(null);

export function ReferenceDataProvider({ children }: { children: ReactNode }) {
  const [accountDefs,       setAccountDefs]       = useState<Account[]>([]);
  const [expenseCategories, setExpenseCategories] = useState<ExpenseCategory[]>([]);
  const [revenueCategories, setRevenueCategories] = useState<RevenueCategory[]>([]);
  const [loading,           setLoading]           = useState(true);

  const refreshAccounts = useCallback(async () => {
    try { setAccountDefs(await getAccounts()); }
    catch (err) { console.error("[ReferenceData] refreshAccounts failed:", err); }
  }, []);

  const refreshExpenseCategories = useCallback(async () => {
    try { setExpenseCategories(await getExpenseCategories()); }
    catch (err) { console.error("[ReferenceData] refreshExpenseCategories failed:", err); }
  }, []);

  const refreshRevenueCategories = useCallback(async () => {
    try { setRevenueCategories(await getRevenueCategories()); }
    catch (err) { console.error("[ReferenceData] refreshRevenueCategories failed:", err); }
  }, []);

  // ── Initial load — once per session ───────────────────────────
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [accts, expCats, revCats] = await Promise.all([
          getAccounts(),
          getExpenseCategories(),
          getRevenueCategories(),
        ]);
        if (cancelled) return;
        setAccountDefs(accts);
        setExpenseCategories(expCats);
        setRevenueCategories(revCats);
      } catch (err) {
        console.error("[ReferenceData] initial load failed:", err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  const value = useMemo<ReferenceDataContextType>(() => ({
    accountDefs,
    expenseCategories,
    revenueCategories,
    loading,
    refreshAccounts,
    refreshExpenseCategories,
    refreshRevenueCategories,
  }), [accountDefs, expenseCategories, revenueCategories, loading,
       refreshAccounts, refreshExpenseCategories, refreshRevenueCategories]);

  return (
    <ReferenceDataContext.Provider value={value}>
      {children}
    </ReferenceDataContext.Provider>
  );
}

export function useReferenceData(): ReferenceDataContextType {
  const ctx = useContext(ReferenceDataContext);
  if (!ctx) throw new Error("useReferenceData() must be called inside <ReferenceDataProvider>");
  return ctx;
}

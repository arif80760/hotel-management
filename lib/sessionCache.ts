// lib/sessionCache.ts
//
// ─── SESSION-SCOPED CONTENT CACHE (client-safe) ─────────────────────────────
//
// Content-first loading pattern (2026-08-25 loading-state redesign; reference
// implementations: MDFundClient / CashbookReportsClient): page-local fetchers
// keep their last successful result in this module-level store, seed their
// state from it on the NEXT mount, render immediately, and refresh in the
// background — so repeat visits never blank the screen behind a spinner.
// Cold start (no cache) keeps the page's loader and arms the slow-connection
// watch. Lives for the browser session only; never persisted; background
// refresh overwrites staleness within the first round-trip.

const store = new Map<string, unknown>();

export function readSessionCache<T>(key: string): T | null {
  return (store.get(key) as T | undefined) ?? null;
}

export function writeSessionCache<T>(key: string, value: T): void {
  store.set(key, value);
}

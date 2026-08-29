// lib/slowConnection.ts
//
// ─── GLOBAL SLOW-CONNECTION WATCHER (client-safe) ───────────────────────────
//
// Born from the 2026-08-24 Supabase incident: users stared at bare spinners
// for minutes with no explanation. Any loading path can ARM a watch under a
// key; if it stays armed past THRESHOLD_MS the app-wide notice appears
// (components/SlowConnectionNotice). DISARM on settle — resolve or reject —
// clears it. Multiple keys can be slow at once; the notice shows while ANY
// key is slow.
//
// Usage (React): call useSlowWatch(key, active) — arms while `active` is
// true, disarms on false/unmount. Non-React code paths can call
// armSlowWatch/disarmSlowWatch directly (always disarm in `finally`).

const THRESHOLD_MS = 8_000;

const timers   = new Map<string, ReturnType<typeof setTimeout>>();
const slowKeys = new Set<string>();
const listeners = new Set<() => void>();

function emit() { listeners.forEach((l) => l()); }

export function armSlowWatch(key: string): void {
  if (typeof window === "undefined") return;   // SSR no-op
  if (timers.has(key) || slowKeys.has(key)) return;
  timers.set(key, setTimeout(() => {
    timers.delete(key);
    slowKeys.add(key);
    emit();
  }, THRESHOLD_MS));
}

export function disarmSlowWatch(key: string): void {
  if (typeof window === "undefined") return;
  const t = timers.get(key);
  if (t) { clearTimeout(t); timers.delete(key); }
  if (slowKeys.delete(key)) emit();
}

/** For useSyncExternalStore. */
export function subscribeSlow(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function getSlowSnapshot(): boolean { return slowKeys.size > 0; }
export function getServerSlowSnapshot(): boolean { return false; }

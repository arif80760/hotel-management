"use client";

// components/SlowConnectionNotice.tsx
//
// App-wide "connection is slow" toast — shows while ANY armed slow-watch
// (lib/slowConnection) has exceeded the 8s threshold, disappears the moment
// the last one settles. Mounted by AppShell in both its loading branch and
// the full shell, so it covers the auth gate, the admin gate, the initial
// data load, and the assistant's waiting-for-reply state alike.

import { useEffect, useState, useSyncExternalStore } from "react";
import { subscribeSlow, getSlowSnapshot, getServerSlowSnapshot, armSlowWatch, disarmSlowWatch } from "@/lib/slowConnection";

export default function SlowConnectionNotice() {
  const slow = useSyncExternalStore(subscribeSlow, getSlowSnapshot, getServerSlowSnapshot);
  // Keep the toast up briefly after recovery so it never strobes.
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (slow) { setVisible(true); return; }
    const t = setTimeout(() => setVisible(false), 1_500);
    return () => clearTimeout(t);
  }, [slow]);

  if (!visible) return null;
  return (
    <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-[100] flex items-center gap-2.5 bg-amber-50 border border-amber-300 rounded-xl shadow-lg px-4 py-2.5 max-w-[92vw]">
      <span className="relative flex h-2.5 w-2.5 flex-shrink-0">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-60" />
        <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-amber-500" />
      </span>
      <p className="text-[12.5px] font-medium text-amber-900">
        Connection is slow — still trying. Your data is safe; nothing has been lost. If this keeps up, let management know.
      </p>
    </div>
  );
}

/** Arms a slow-watch while `active` is true; disarms on false/unmount. */
export function useSlowWatch(key: string, active: boolean): void {
  useEffect(() => {
    if (!active) return;
    armSlowWatch(key);
    return () => disarmSlowWatch(key);
  }, [key, active]);
}

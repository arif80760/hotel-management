"use client";

// components/NumberInputGuard.tsx
//
// Behavioural half of the app-wide spinner removal (2026-08-26; CSS half in
// globals.css). Hiding the spin buttons does NOT disable scroll-wheel or
// arrow-key increment — a wheel scroll over a focused amount field would
// still silently change money values, now with no visual cue. Two delegated
// document-level listeners neutralise both for EVERY current and future
// input[type=number], with zero per-field wiring:
//
//   • wheel  → blur the focused number input (the browser only applies wheel
//     stepping to a focused control; blurring cancels it without needing a
//     non-passive preventDefault). Page scrolling is untouched.
//   • keydown (capture) → suppress ArrowUp/ArrowDown value stepping.
//
// Mounted once by AppShell. No validation, parsing, or formatting touched.

import { useEffect } from "react";

export default function NumberInputGuard() {
  useEffect(() => {
    const isNumberInput = (t: EventTarget | null): t is HTMLInputElement =>
      t instanceof HTMLInputElement && t.type === "number";

    const onWheel = (e: WheelEvent) => {
      if (isNumberInput(e.target) && document.activeElement === e.target) {
        e.target.blur();
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.key === "ArrowUp" || e.key === "ArrowDown") && isNumberInput(e.target)) {
        e.preventDefault();
      }
    };

    document.addEventListener("wheel", onWheel, { passive: true, capture: true });
    document.addEventListener("keydown", onKeyDown, { capture: true });
    return () => {
      document.removeEventListener("wheel", onWheel, { capture: true });
      document.removeEventListener("keydown", onKeyDown, { capture: true });
    };
  }, []);

  return null;
}

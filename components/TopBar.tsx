"use client";

// components/TopBar.tsx
// The white horizontal bar at the top of every page.
// Shows the current date on the left and a notification
// placeholder on the right. "use client" is required because
// we read today's date in the browser (new Date()).

import { useEffect, useState } from "react";

export default function TopBar() {
  // We build the date string on the client so it stays accurate
  const [dateStr, setDateStr] = useState("");

  useEffect(() => {
    const d = new Date();
    setDateStr(
      d.toLocaleDateString("en-US", {
        weekday: "long",
        year:    "numeric",
        month:   "long",
        day:     "numeric",
      })
    );
  }, []);

  return (
    <header className="h-14 bg-white border-b border-slate-200 flex items-center justify-between px-7 flex-shrink-0">

      {/* Left — today's date */}
      <p className="text-[13px] text-slate-400 font-medium">{dateStr}</p>

      {/* Right — notification bell + divider + property badge */}
      <div className="flex items-center gap-4">

        {/* Notification bell (placeholder — no logic yet) */}
        <button className="relative p-1.5 text-slate-400 hover:text-slate-600 transition-colors rounded-lg hover:bg-slate-100">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="w-[18px] h-[18px]">
            <path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
            <path d="M13.73 21a2 2 0 01-3.46 0" />
          </svg>
          {/* Red dot — unread indicator */}
          <span className="absolute top-1 right-1 w-1.5 h-1.5 bg-red-500 rounded-full" />
        </button>

        <div className="h-5 w-px bg-slate-200" />

        {/* Property name pill */}
        <div className="flex items-center gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-1.5">
          <div className="w-1.5 h-1.5 bg-amber-500 rounded-full" />
          <span className="text-[12px] font-semibold text-amber-700 whitespace-nowrap">
            Hotel Albatross Resort
          </span>
        </div>
      </div>
    </header>
  );
}

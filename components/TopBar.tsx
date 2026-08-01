"use client";

// components/TopBar.tsx
// The white horizontal bar at the top of every page.
// Shows the current date on the left and a notification
// placeholder on the right. "use client" is required because
// we read today's date in the browser (new Date()).
//
// Below md it also hosts the hamburger that opens the mobile
// nav drawer (state lives in AppShell); the long date shortens
// and the property pill hides so the row fits a phone width.

import { useEffect, useState } from "react";
import NotificationBell from "@/components/NotificationBell";

export default function TopBar({ onMenuClick }: { onMenuClick?: () => void }) {
  // We build the date string on the client so it stays accurate
  const [dateStr, setDateStr] = useState("");
  const [shortDateStr, setShortDateStr] = useState("");

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
    setShortDateStr(
      d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })
    );
  }, []);

  return (
    <header className="h-14 bg-white border-b border-slate-200 flex items-center justify-between px-4 md:px-7 flex-shrink-0">

      {/* Left — hamburger (mobile) + logo + today's date */}
      <div className="flex items-center gap-2 md:gap-3 min-w-0">
        {/* Hamburger — opens the nav drawer, below md only */}
        <button
          type="button"
          onClick={onMenuClick}
          aria-label="Open menu"
          className="md:hidden -ml-1 w-11 h-11 flex items-center justify-center rounded-lg text-slate-500 hover:text-slate-700 hover:bg-slate-100 transition-colors flex-shrink-0"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-5 h-5">
            <path d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>

        {/* Logo */}
        <img
          src="/logo.png"
          alt="Hotel Albatross"
          className="h-8 w-auto object-contain flex-shrink-0"
        />
        {/* Date — full on md+, compact below */}
        <p className="hidden md:block text-[13px] text-slate-400 font-medium">{dateStr}</p>
        <p className="md:hidden text-[13px] text-slate-400 font-medium truncate">{shortDateStr}</p>
      </div>

      {/* Right — notification bell + divider + property badge */}
      <div className="flex items-center gap-2 md:gap-4 flex-shrink-0">

        {/* Notification bell — live, derived from bookings/inventory/day-close */}
        <NotificationBell />

        <div className="hidden md:block h-5 w-px bg-slate-200" />

        {/* Property name pill — hidden on phones, the drawer header carries the brand */}
        <div className="hidden md:flex items-center gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-1.5">
          <div className="w-1.5 h-1.5 bg-amber-500 rounded-full" />
          <span className="text-[12px] font-semibold text-amber-700 whitespace-nowrap">
            Hotel Albatross Resort
          </span>
        </div>
      </div>
    </header>
  );
}

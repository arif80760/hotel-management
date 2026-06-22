"use client";

// components/TopBar.tsx
// The white horizontal bar at the top of every page.
// Shows the current date on the left and a notification
// placeholder on the right. "use client" is required because
// we read today's date in the browser (new Date()).

import { useEffect, useState } from "react";
import NotificationBell from "@/components/NotificationBell";

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

      {/* Left — logo + today's date */}
      <div className="flex items-center gap-3">
        {/* Logo */}
        <img 
          src="/logo.png" 
          alt="Hotel Albatross" 
          className="h-8 w-auto object-contain"
        />
        {/* Date */}
        <p className="text-[13px] text-slate-400 font-medium">{dateStr}</p>
      </div>

      {/* Right — notification bell + divider + property badge */}
      <div className="flex items-center gap-4">

        {/* Notification bell — live, derived from bookings/inventory/day-close */}
        <NotificationBell />

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

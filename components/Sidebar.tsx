"use client";

// components/Sidebar.tsx
// Left navigation panel — visible on every page.
// SVG icons keep it sharp at any screen size (no emoji).
// The active link is highlighted with an amber/gold accent
// to give the app a premium resort feel.

import Link from "next/link";
import { usePathname } from "next/navigation";

// ── SVG icon set ─────────────────────────────────────────────
// Each icon is a tiny inline SVG. strokeWidth="1.75" keeps
// them feeling light and modern, not heavy.
const Icons = {
  dashboard: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="w-[18px] h-[18px]">
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  ),
  rooms: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="w-[18px] h-[18px]">
      <path d="M2 20V9a2 2 0 012-2h16a2 2 0 012 2v11" />
      <path d="M2 20h20" />
      <path d="M12 7V4" />
      <path d="M9 20v-5h6v5" />
      <path d="M6 13h2" />
      <path d="M16 13h2" />
    </svg>
  ),
  guests: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="w-[18px] h-[18px]">
      <circle cx="8" cy="7" r="3.5" />
      <path d="M2 21v-1.5A4.5 4.5 0 016.5 15h3A4.5 4.5 0 0114 19.5V21" />
      <path d="M15 3.5a3.5 3.5 0 010 7" />
      <path d="M17.5 15h1A4.5 4.5 0 0123 19.5V21" />
    </svg>
  ),
  bookings: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="w-[18px] h-[18px]">
      <rect x="3" y="4" width="18" height="17" rx="2" />
      <path d="M3 10h18" />
      <path d="M8 2v4" />
      <path d="M16 2v4" />
      <path d="M8 14h.01" />
      <path d="M12 14h.01" />
      <path d="M16 14h.01" />
      <path d="M8 18h.01" />
      <path d="M12 18h.01" />
    </svg>
  ),
};

// ── Nav items ─────────────────────────────────────────────────
const navItems = [
  { label: "Dashboard", href: "/",         icon: Icons.dashboard },
  { label: "Rooms",     href: "/rooms",    icon: Icons.rooms     },
  { label: "Guests",    href: "/guests",   icon: Icons.guests    },
  { label: "Bookings",  href: "/bookings", icon: Icons.bookings  },
];

export default function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="w-60 min-h-screen bg-slate-900 text-white flex flex-col flex-shrink-0">

      {/* ── Brand header ─────────────────────────────────────── */}
      <div className="px-5 pt-6 pb-5 border-b border-slate-700/60">
        {/* Logo mark — initials in an amber square */}
        <div className="flex items-center gap-3 mb-0.5">
          <div className="w-8 h-8 rounded-lg bg-amber-500 flex items-center justify-center flex-shrink-0">
            <span className="text-slate-900 font-bold text-xs tracking-tight">HA</span>
          </div>
          <div>
            {/* Hotel name — split across two lines for a premium look */}
            <p className="text-[13px] font-semibold leading-tight text-white">
              Hotel Albatross
            </p>
            <p className="text-[11px] text-amber-400/90 font-medium tracking-widest uppercase leading-tight">
              Resort
            </p>
          </div>
        </div>
      </div>

      {/* ── Section label ────────────────────────────────────── */}
      <div className="px-5 pt-5 pb-2">
        <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-widest">
          Main Menu
        </p>
      </div>

      {/* ── Navigation links ─────────────────────────────────── */}
      <nav className="flex-1 px-3 space-y-0.5">
        {navItems.map((item) => {
          // Exact match for home "/", prefix match for other routes
          const isActive =
            item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);

          return (
            <Link
              key={item.href}
              href={item.href}
              className={`
                group flex items-center gap-3 px-3 py-2.5 rounded-lg text-[13.5px] font-medium
                transition-all duration-150 relative
                ${isActive
                  ? "bg-slate-800 text-amber-400"
                  : "text-slate-400 hover:bg-slate-800/70 hover:text-slate-100"
                }
              `}
            >
              {/* Active indicator bar on the left edge */}
              {isActive && (
                <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 bg-amber-400 rounded-full" />
              )}
              {/* Icon */}
              <span className={isActive ? "text-amber-400" : "text-slate-500 group-hover:text-slate-300"}>
                {item.icon}
              </span>
              {item.label}
            </Link>
          );
        })}
      </nav>

      {/* ── Bottom footer ────────────────────────────────────── */}
      <div className="px-5 py-5 border-t border-slate-700/60">
        {/* Staff avatar placeholder */}
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-slate-700 flex items-center justify-center flex-shrink-0">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" className="w-4 h-4 text-slate-400">
              <circle cx="12" cy="8" r="4" />
              <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" />
            </svg>
          </div>
          <div className="min-w-0">
            <p className="text-[12px] font-medium text-slate-300 truncate">Front Desk Staff</p>
            <p className="text-[11px] text-slate-500">Admin</p>
          </div>
        </div>
      </div>
    </aside>
  );
}

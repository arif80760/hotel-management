"use client";

// components/Sidebar.tsx
// Left navigation panel — visible on every page.
// SVG icons keep it sharp at any screen size (no emoji).
// The active link is highlighted with an amber/gold accent
// to give the app a premium resort feel.

import { useState, useEffect, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";

// ── SVG icon set ─────────────────────────────────────────────
// Each icon is a tiny inline SVG. strokeWidth="1.75" keeps
// them feeling light and modern, not heavy.
const Icons = {
  activity: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="w-[18px] h-[18px]">
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /><path d="M12 7v5l3 2" />
    </svg>
  ),
  dashboard: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="w-[18px] h-[18px]">
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  ),
  frontdesk: (
    /* Clipboard with checkmark — daily operations / front desk */
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="w-[18px] h-[18px]">
      <rect x="8" y="2" width="8" height="4" rx="1" />
      <path d="M8 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V4a2 2 0 00-2-2h-2" />
      <path d="M9 12l2 2 4-4" />
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
  employees: (
    /* ID card icon — person avatar on left, text lines on right */
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="w-[18px] h-[18px]">
      <rect x="2" y="5" width="20" height="14" rx="2" />
      <circle cx="8" cy="12" r="2.5" />
      <path d="M13 10h5" />
      <path d="M13 14h3" />
    </svg>
  ),
  profile: (
    /* Circle user silhouette — personal profile */
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="w-[18px] h-[18px]">
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="9"  r="3"  />
      <path d="M6.168 18.849A4 4 0 0110 16h4a4 4 0 013.834 2.855" />
    </svg>
  ),
  accounts: (
    /* Banknote — money / accounts daybook */
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="w-[18px] h-[18px]">
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <circle cx="12" cy="12" r="2.5" />
      <path d="M6 9v.01" />
      <path d="M18 15v.01" />
    </svg>
  ),
  inventory: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="w-[18px] h-[18px]">
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
      <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
      <line x1="12" y1="22.08" x2="12" y2="12" />
    </svg>
  ),
  analytics: (
    /* Bar chart — three vertical bars of increasing height */
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="w-[18px] h-[18px]">
      <path d="M18 20V10"/>
      <path d="M12 20V4"/>
      <path d="M6 20v-6"/>
    </svg>
  ),
};

// ── Nav items ─────────────────────────────────────────────────
// Two shapes:
//   NavLeaf  — single link, the historical shape used by every entry.
//   NavGroup — expandable parent with children, used by Accounts so its
//              subsections (Cashbook, Expense, Payroll, Revenue Management)
//              all sit inside the sidebar under one collapsible header.
//
// Discriminated union: a leaf has `href`, a group has `children`. The
// renderer below branches on which shape is present.

type NavLeaf = {
  label:      string;
  href:       string;
  icon:       ReactNode;
  adminOnly?: boolean;
  activityLog?: boolean;
};

type NavChild = {
  label: string;
  href:  string;
};

type NavGroup = {
  label:      string;
  icon:       ReactNode;
  adminOnly?: boolean;
  children:   NavChild[];
};

type NavItem = NavLeaf | NavGroup;

function isGroup(item: NavItem): item is NavGroup {
  return "children" in item;
}

const navItems: NavItem[] = [
  { label: "Dashboard",  href: "/",            icon: Icons.dashboard  },
  { label: "Front Desk", href: "/front-desk",  icon: Icons.frontdesk  },
  { label: "Rooms",          href: "/rooms",            icon: Icons.rooms                        },
  { label: "Room Analytics", href: "/rooms/analytics", icon: Icons.analytics, adminOnly: true },
  { label: "Guests",         href: "/guests",          icon: Icons.guests                     },
  { label: "Bookings",   href: "/bookings",    icon: Icons.bookings   },
  { label: "Employees",  href: "/employees",   icon: Icons.employees, adminOnly: true },
  { label: "Inventory",  href: "/inventory",   icon: Icons.inventory, adminOnly: true },
  {
    label: "Accounts",
    icon:  Icons.accounts,
    adminOnly: true,
    children: [
      { label: "Cashbook",           href: "/accounts/cashbook" },
      { label: "Expense",            href: "/accounts/expense" },
      { label: "Payroll",            href: "/accounts/payroll" },
      { label: "Revenue Management", href: "/accounts/revenue-management" },
      { label: "Revenue Report",     href: "/accounts/revenue-report" },
      { label: "Loans",              href: "/accounts/loans" },
    ],
  },
  { label: "Activity Log", href: "/activity", icon: Icons.activity, activityLog: true },
  { label: "My Profile", href: "/profile",     icon: Icons.profile    },
];

export default function Sidebar() {
  const pathname = usePathname();
  const { profile, role, signOut, canViewActivityLog } = useAuth();
  const [accountsExpanded, setAccountsExpanded] = useState(false);
  const isAccountsRoute = pathname.startsWith("/accounts");
  const showAccountsChildren = accountsExpanded || isAccountsRoute;

  // ── Collapsible sidebar state ────────────────────────────────
  // Toggled by an explicit button (no hover surprises). The choice is
  // remembered across full page reloads via localStorage.
  const [isCollapsed, setIsCollapsed] = useState(false);

  // Restore the saved preference after mount — done in an effect (not the
  // initial state) so the server and first client render agree (no hydration
  // mismatch). Falls back to expanded if nothing is stored.
  useEffect(() => {
    const saved = localStorage.getItem("sidebar-collapsed");
    if (saved === "true") setIsCollapsed(true);
  }, []);

  function toggleCollapsed() {
    setIsCollapsed(prev => {
      const next = !prev;
      try { localStorage.setItem("sidebar-collapsed", String(next)); } catch { /* ignore */ }
      return next;
    });
  }

  return (
    <aside 
      className={`
        h-screen overflow-hidden bg-slate-900 text-white flex flex-col flex-shrink-0
        transition-all duration-300 ease-in-out
        ${isCollapsed ? "w-16" : "w-60"}
      `}
    >

      {/* ── Brand header ─────────────────────────────────────── */}
      <div className="px-5 pt-6 pb-5 border-b border-slate-700/60">
        {/* Logo + name (left) and collapse button (right, when expanded) */}
        <div className={`flex items-center gap-3 ${isCollapsed ? "justify-center" : "justify-between"}`}>
          <div className="flex items-center gap-3 min-w-0">
            <img 
              src="/logo.png" 
              alt="Hotel Albatross" 
              className="w-8 h-8 object-contain flex-shrink-0"
            />
            {/* Hotel name — hidden when collapsed */}
            {!isCollapsed && (
              <div className="min-w-0">
                <p className="text-[13px] font-semibold leading-tight text-white truncate">
                  Hotel Albatross
                </p>
                <p className="text-[11px] text-amber-400/90 font-medium tracking-widest uppercase leading-tight">
                  Resort
                </p>
              </div>
            )}
          </div>

          {/* Collapse button — inline on the right when expanded */}
          {!isCollapsed && (
            <button
              type="button"
              onClick={toggleCollapsed}
              aria-label="Collapse sidebar"
              title="Collapse sidebar"
              className="flex-shrink-0 p-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800/70 transition-colors"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <path d="M9 3v18" />
              </svg>
            </button>
          )}
        </div>

        {/* Expand button — centered under the logo when collapsed */}
        {isCollapsed && (
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-label="Expand sidebar"
            title="Expand sidebar"
            className="mt-3 mx-auto flex p-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800/70 transition-colors"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <path d="M9 3v18" />
            </svg>
          </button>
        )}
      </div>

      {/* ── Section label ────────────────────────────────────── */}
      {!isCollapsed && (
        <div className="px-5 pt-5 pb-2">
          <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-widest">
            Main Menu
          </p>
        </div>
      )}

      {/* ── Navigation links ─────────────────────────────────── */}
      <nav className="flex-1 overflow-y-auto px-3 space-y-0.5">
        {navItems
          // adminOnly items are hidden while role is null (profile loading)
          // — same behaviour as staff. No flash: null → hidden, 'admin' → visible.
          .filter(item => {
            if (item.adminOnly) return role === "admin";
            if ("activityLog" in item && item.activityLog) return canViewActivityLog;
            return true;
          })
          .map((item) => {

            // ─── Group (Accounts) ─────────────────────────────
            if (isGroup(item)) {
              // The parent gets a soft "you're inside" highlight when on
              // any of its children's routes. It does NOT get the full
              // active treatment — that's reserved for the specific child.
              const parentSoftActive = isAccountsRoute;

              return (
                <div key={item.label}>
                  {/* Parent row — whole-row toggle button */}
                  <button
                    type="button"
                    onClick={() => setAccountsExpanded(v => !v)}
                    aria-expanded={showAccountsChildren}
                    className={`
                      w-full group flex items-center gap-3 px-3 py-2.5 rounded-lg text-[13.5px] font-medium
                      transition-all duration-150
                      ${isCollapsed ? "justify-center" : ""}
                      ${parentSoftActive
                        ? "text-amber-400 hover:bg-slate-800/70"
                        : "text-slate-400 hover:bg-slate-800/70 hover:text-slate-100"
                      }
                    `}
                    title={isCollapsed ? item.label : undefined}
                  >
                    {/* Icon */}
                    <span className={parentSoftActive ? "text-amber-400" : "text-slate-500 group-hover:text-slate-300"}>
                      {item.icon}
                    </span>
                    {/* Label — hidden when collapsed */}
                    {!isCollapsed && (
                      <>
                        <span className="flex-1 text-left">{item.label}</span>
                        {/* Chevron — hidden when collapsed */}
                        <svg
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          className={`w-3.5 h-3.5 transition-transform duration-200 ${
                            showAccountsChildren ? "rotate-180" : ""
                          } ${parentSoftActive ? "text-amber-400/70" : "text-slate-500 group-hover:text-slate-300"}`}
                        >
                          <path d="M6 9l6 6 6-6" />
                        </svg>
                      </>
                    )}
                  </button>

                  {/* Children — indented, no icons; hidden while collapsed */}
                  {!isCollapsed && showAccountsChildren && (
                    <div className="mt-0.5 space-y-0.5">
                      {item.children.map((child) => {
                        const childActive = pathname === child.href || pathname.startsWith(child.href + "/");
                        return (
                          <Link
                            key={child.href}
                            href={child.href}
                            prefetch={false}
                            className={`
                              flex items-center pl-12 pr-3 py-2 rounded-lg text-[13px] font-medium
                              transition-all duration-150 relative
                              ${childActive
                                ? "bg-slate-800 text-amber-400"
                                : "text-slate-400 hover:bg-slate-800/70 hover:text-slate-100"
                              }
                            `}
                          >
                            {childActive && (
                              <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 bg-amber-400 rounded-full" />
                            )}
                            {child.label}
                          </Link>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            }

            // ─── Leaf (everything else) ───────────────────────
            // For /rooms specifically, only mark active on the exact path or
            // immediate sub-paths that are NOT the analytics sub-route (which
            // has its own sidebar entry).
            const isActive = item.href === "/"
              ? pathname === "/"
              : item.href === "/rooms"
                ? pathname === "/rooms" || (pathname.startsWith("/rooms/") && !pathname.startsWith("/rooms/analytics"))
                : pathname.startsWith(item.href);

            return (
              <Link
                key={item.href}
                href={item.href}
                prefetch={false}
                className={`
                  group flex items-center gap-3 px-3 py-2.5 rounded-lg text-[13.5px] font-medium
                  transition-all duration-150 relative
                  ${isCollapsed ? "justify-center" : ""}
                  ${isActive
                    ? "bg-slate-800 text-amber-400"
                    : "text-slate-400 hover:bg-slate-800/70 hover:text-slate-100"
                  }
                `}
                title={isCollapsed ? item.label : undefined}
              >
                {/* Active indicator bar on the left edge */}
                {isActive && (
                  <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 bg-amber-400 rounded-full" />
                )}
                {/* Icon */}
                <span className={isActive ? "text-amber-400" : "text-slate-500 group-hover:text-slate-300"}>
                  {item.icon}
                </span>
                {/* Label — hidden when collapsed */}
                {!isCollapsed && item.label}
              </Link>
            );
          })}
      </nav>

      {/* ── Bottom footer — real user info + sign out ────────── */}
      <div className="px-4 py-4 border-t border-slate-700/60 space-y-3">

        {/* User identity — hidden when collapsed */}
        {!isCollapsed && (
          <div className="flex items-center gap-3">
            {/* Avatar — initials derived from full_name */}
            <div className="w-8 h-8 rounded-full bg-slate-700 flex items-center justify-center flex-shrink-0">
              {profile ? (
                <span className="text-[11px] font-bold text-slate-300 uppercase leading-none">
                  {profile.full_name
                    .split(" ")
                    .slice(0, 2)
                    .map(n => n[0])
                    .join("")}
                </span>
              ) : (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" className="w-4 h-4 text-slate-400">
                  <circle cx="12" cy="8" r="4" />
                  <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" />
                </svg>
              )}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[12px] font-medium text-slate-300 truncate leading-tight">
                {profile?.full_name ?? "Loading…"}
              </p>
              <p className={`text-[11px] font-medium capitalize leading-tight mt-0.5 ${
                role === "admin" ? "text-amber-400" : "text-slate-500"
              }`}>
                {role ?? "—"}
              </p>
            </div>
          </div>
        )}

        {/* Collapsed state: just avatar */}
        {isCollapsed && (
          <div className="flex justify-center">
            <div className="w-8 h-8 rounded-full bg-slate-700 flex items-center justify-center flex-shrink-0" title={profile?.full_name ?? "User"}>
              {profile ? (
                <span className="text-[11px] font-bold text-slate-300 uppercase leading-none">
                  {profile.full_name
                    .split(" ")
                    .slice(0, 2)
                    .map(n => n[0])
                    .join("")}
                </span>
              ) : (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" className="w-4 h-4 text-slate-400">
                  <circle cx="12" cy="8" r="4" />
                  <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" />
                </svg>
              )}
            </div>
          </div>
        )}

        {/* Sign out button */}
        <button
          onClick={signOut}
          className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-[12.5px] font-medium
            text-slate-400 hover:text-slate-100 hover:bg-slate-800/70 transition-colors
            ${isCollapsed ? "justify-center" : ""}`}
          title={isCollapsed ? "Sign out" : undefined}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4 flex-shrink-0">
            <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" />
            <polyline points="16 17 21 12 16 7" />
            <line x1="21" y1="12" x2="9" y2="12" />
          </svg>
          {!isCollapsed && "Sign out"}
        </button>

      </div>
    </aside>
  );
}

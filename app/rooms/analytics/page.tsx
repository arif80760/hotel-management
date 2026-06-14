"use client";

// app/rooms/analytics/page.tsx
//
// Admin-only Room Analytics route.
//
// BEFORE: a force-dynamic SERVER component that ran getUser() + a profiles role
//   query on every request — two sequential Supabase round trips from the Vercel
//   function (Virginia) to the database (Tokyo), ~350ms of TTFB before any HTML
//   shipped, and uncacheable.
//
// AFTER: a thin CLIENT component. AppShell already enforces sign-in; AdminGate
//   enforces the admin role using the role already loaded in AuthContext (no
//   network round trip). RLS on the underlying tables / RPCs remains the real
//   security boundary. Result: this page loads like the dashboard — the shell
//   paints immediately, and RoomAnalyticsClient's two RPCs fetch client-side in
//   parallel.
//
// (The `export const dynamic = "force-dynamic"` line is intentionally gone —
//  this route no longer runs on the server.)

import AdminGate from "@/components/AdminGate";
import RoomAnalyticsClient from "./RoomAnalyticsClient";

export default function RoomAnalyticsPage() {
  return (
    <AdminGate>
      <RoomAnalyticsClient />
    </AdminGate>
  );
}

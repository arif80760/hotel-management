"use client";

// app/rooms/rate-calendar/page.tsx
// Admin-only Rate Calendar route — same thin client-gate pattern as
// /rooms/analytics (AdminGate; RLS on rate_periods is the real boundary:
// writes are admin-only via is_admin()).

import AdminGate from "@/components/AdminGate";
import RateCalendarClient from "./RateCalendarClient";

export default function RateCalendarPage() {
  return (
    <AdminGate>
      <RateCalendarClient />
    </AdminGate>
  );
}

// app/admin/settings/page.tsx
// Thin server wrapper — all state and UI live in AdminSettingsClient.

import AdminSettingsClient from "./AdminSettingsClient";

export default function AdminSettingsPage() {
  return <AdminSettingsClient />;
}

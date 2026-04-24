// app/profile/page.tsx
// Thin server wrapper — all state and UI live in ProfileClient.

import ProfileClient from "./ProfileClient";

export default function ProfilePage() {
  return <ProfileClient />;
}

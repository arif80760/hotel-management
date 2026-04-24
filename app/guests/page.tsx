// app/guests/page.tsx
// Thin server wrapper — all state and UI live in GuestsClient.
// TODO: When Supabase is connected, fetch initial guest list here
//       and pass it as a prop to GuestsClient.

import GuestsClient from "./GuestsClient";

export default function GuestsPage() {
  return <GuestsClient />;
}

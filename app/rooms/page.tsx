// app/rooms/page.tsx
// Thin server wrapper — all state and UI live in RoomsClient.
// TODO: When Supabase is connected, fetch initial room list here
//       and pass it as a prop to RoomsClient.

import RoomsClient from "./RoomsClient";

export default function RoomsPage() {
  return <RoomsClient />;
}

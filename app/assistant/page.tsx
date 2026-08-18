// app/assistant/page.tsx
// Thin server wrapper — all state and UI live in AssistantClient.
// Available to any signed-in user; the /api/assistant route enforces auth
// server-side (Bearer token → profiles row) and will offer financial tools
// to admins only when they exist.

import AssistantClient from "./AssistantClient";

export default function AssistantPage() {
  return <AssistantClient />;
}

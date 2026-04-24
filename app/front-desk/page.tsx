// app/front-desk/page.tsx
// Thin server wrapper — all state lives in FrontDeskClient.
import FrontDeskClient from "./FrontDeskClient";

export default function FrontDeskPage() {
  return <FrontDeskClient />;
}

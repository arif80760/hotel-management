// app/bookings/page.tsx — thin server wrapper
// Reads the optional ?room= query param and passes it to the
// interactive client component that manages all booking state.

import BookingsClient from "./BookingsClient";

export default async function BookingsPage(props: {
  searchParams: Promise<{ room?: string }>;
}) {
  const searchParams = await props.searchParams;
  return <BookingsClient initialRoom={searchParams?.room ?? null} />;
}

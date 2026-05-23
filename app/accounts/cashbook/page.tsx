// app/accounts/cashbook/page.tsx
//
// Server component with admin guard. Mirrors the auth guard pattern
// from app/employees/page.tsx — non-admin users are redirected to "/"
// before CashbookClient renders.
//
// The Cashbook is the daybook view: balance cards + transaction list,
// with manual entry (transfers / cash injections) and CSV export.
// Auto-generated rows from booking payments appear here read-only.

import { redirect } from "next/navigation";
import { cookies }  from "next/headers";
import { createServerClient } from "@supabase/ssr";

import CashbookClient from "./CashbookClient";

export default async function CashbookPage() {
  const cookieStore = await cookies();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return cookieStore.getAll(); },
        setAll() { /* no-op for server components */ },
      },
    },
  );

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("user_profiles")
    .select("role")
    .eq("user_id", user.id)
    .single();

  if (!profile || profile.role !== "admin") redirect("/");

  return <CashbookClient />;
}

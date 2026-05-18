// app/employees/page.tsx
// Server wrapper with role guard — admin only.
//
// Staff who navigate to /employees (via link or direct URL) are
// redirected to "/" before EmployeesClient renders.
// Uses the same createSupabaseServerClient() pattern as the invoice
// and reservation document pages. No flash, no loading-state handling
// needed — the redirect is resolved server-side before any HTML is sent.

import { redirect }                   from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabaseServer";
import EmployeesClient                from "./EmployeesClient";

export const dynamic = "force-dynamic";

export default async function EmployeesPage() {
  const serverClient = await createSupabaseServerClient();
  const { data: { user } } = await serverClient.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await serverClient
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();

  if (profile?.role !== "admin") redirect("/");

  return <EmployeesClient />;
}

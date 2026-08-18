// app/accounts/monthly-reports/page.tsx
// Server wrapper with role guard — admin only (same gate as every Accounts
// page; cloned from md-fund/page.tsx).
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabaseServer";
import MonthlyReportsClient from "./MonthlyReportsClient";

export const dynamic = "force-dynamic";

export default async function MonthlyReportsPage() {
  const serverClient = await createSupabaseServerClient();
  const { data: { user } } = await serverClient.auth.getUser();
  if (!user) redirect("/login");
  const { data: profile } = await serverClient
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (profile?.role !== "admin") redirect("/");
  return <MonthlyReportsClient />;
}

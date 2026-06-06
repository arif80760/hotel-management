// app/accounts/revenue-report/page.tsx
// Server wrapper with role guard — admin only.
// Cloned from app/accounts/revenue-management/page.tsx.
import { redirect }                   from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabaseServer";
import RevenueReportClient            from "./RevenueReportClient";

export const dynamic = "force-dynamic";

export default async function RevenueReportPage() {
  const serverClient = await createSupabaseServerClient();
  const { data: { user } } = await serverClient.auth.getUser();
  if (!user) redirect("/login");
  const { data: profile } = await serverClient
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (profile?.role !== "admin") redirect("/");
  return <RevenueReportClient />;
}

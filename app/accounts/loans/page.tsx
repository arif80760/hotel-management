// app/accounts/loans/page.tsx — server wrapper, admin guard (mirrors other accounts pages).
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabaseServer";
import LoansClient from "./LoansClient";

export const dynamic = "force-dynamic";

export default async function LoansPage() {
  const serverClient = await createSupabaseServerClient();
  const { data: { user } } = await serverClient.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await serverClient
    .from("profiles").select("role").eq("id", user.id).single();
  if (profile?.role !== "admin") redirect("/");

  return <LoansClient />;
}

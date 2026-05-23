// app/accounts/expense/page.tsx
// Server wrapper with role guard — admin only.
// Mirrors the auth guard pattern from app/accounts/cashbook/page.tsx.

import { redirect }                   from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabaseServer";
import ExpenseClient                  from "./ExpenseClient";

export const dynamic = "force-dynamic";

export default async function ExpensePage() {
  const serverClient = await createSupabaseServerClient();
  const { data: { user } } = await serverClient.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await serverClient
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();

  if (profile?.role !== "admin") redirect("/");

  return <ExpenseClient />;
}

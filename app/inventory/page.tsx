// app/inventory/page.tsx
// Server wrapper with role guard — admin only.
// Mirrors the auth guard pattern from app/accounts/expense/page.tsx.

import { redirect }                   from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabaseServer";
import InventoryClient                from "./InventoryClient";

export const dynamic = "force-dynamic";

export default async function InventoryPage() {
  const serverClient = await createSupabaseServerClient();
  const { data: { user } } = await serverClient.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await serverClient
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();

  if (profile?.role !== "admin") redirect("/");

  return <InventoryClient />;
}

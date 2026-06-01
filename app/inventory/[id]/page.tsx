// app/inventory/[id]/page.tsx
// Server wrapper — admin guard, mirrors app/inventory/page.tsx.

import { redirect }                   from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabaseServer";
import InventoryItemClient            from "./InventoryItemClient";

export const dynamic = "force-dynamic";

export default async function InventoryItemPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const serverClient = await createSupabaseServerClient();
  const { data: { user } } = await serverClient.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await serverClient
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();

  if (profile?.role !== "admin") redirect("/");

  return <InventoryItemClient itemId={id} />;
}

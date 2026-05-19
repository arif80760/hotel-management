// app/accounts/page.tsx
// Server wrapper with role guard — admin only.
//
// Staff who navigate to /accounts (via link or direct URL) are
// redirected to "/" before AccountsClient renders.
// Mirrors the /employees page guard exactly — same
// createSupabaseServerClient() pattern. No flash, no loading-state
// handling — the redirect is resolved server-side before any HTML
// is sent. The Accounts feature is admin-only (Phase E).

import { redirect }                   from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabaseServer";
import AccountsClient                 from "./AccountsClient";

export const dynamic = "force-dynamic";

export default async function AccountsPage() {
  const serverClient = await createSupabaseServerClient();
  const { data: { user } } = await serverClient.auth.getUser();

  if (!user) redirect("/login");

  const { data: profile } = await serverClient
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();

  if (profile?.role !== "admin") redirect("/");

  return <AccountsClient />;
}

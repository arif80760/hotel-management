// app/rooms/analytics/page.tsx
// Server wrapper with role guard — admin only.
// Cloned from app/accounts/revenue-report/page.tsx.
import { redirect }                   from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabaseServer";
import RoomAnalyticsClient            from "./RoomAnalyticsClient";

export const dynamic = "force-dynamic";

export default async function RoomAnalyticsPage() {
  const serverClient = await createSupabaseServerClient();
  const { data: { user } } = await serverClient.auth.getUser();
  if (!user) redirect("/login");
  const { data: profile } = await serverClient
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (profile?.role !== "admin") redirect("/");
  return <RoomAnalyticsClient />;
}

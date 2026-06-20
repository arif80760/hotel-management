// app/activity/page.tsx
// Server wrapper — admins + managers only (gates on can_view_activity_log()).
import { redirect }                   from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabaseServer";
import ActivityLogClient             from "./ActivityLogClient";

export const dynamic = "force-dynamic";

export default async function ActivityLogPage() {
  const serverClient = await createSupabaseServerClient();
  const { data: { user } } = await serverClient.auth.getUser();
  if (!user) redirect("/login");
  const { data: canView } = await serverClient.rpc("can_view_activity_log");
  if (canView !== true) redirect("/");
  return <ActivityLogClient />;
}

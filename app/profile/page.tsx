import { redirect }                   from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabaseServer";
import ProfileClient                  from "./ProfileClient";

export const dynamic = "force-dynamic";

export default async function ProfilePage() {
  const serverClient = await createSupabaseServerClient();
  const { data: { user } } = await serverClient.auth.getUser();
  if (!user) redirect("/login");
  return <ProfileClient />;
}

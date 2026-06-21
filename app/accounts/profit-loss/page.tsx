import { redirect }                   from "next/navigation";
import { Space_Grotesk, Plus_Jakarta_Sans } from "next/font/google";
import { createSupabaseServerClient } from "@/lib/supabaseServer";
import ProfitLossClient               from "./ProfitLossClient";

const spaceGrotesk = Space_Grotesk({ subsets: ["latin"], variable: "--font-space-grotesk", display: "swap" });
const jakarta = Plus_Jakarta_Sans({ subsets: ["latin"], variable: "--font-jakarta", display: "swap" });

export const dynamic = "force-dynamic";

export default async function ProfitLossPage() {
  const serverClient = await createSupabaseServerClient();
  const { data: { user } } = await serverClient.auth.getUser();
  if (!user) redirect("/login");
  const { data: profile } = await serverClient.from("profiles").select("role").eq("id", user.id).single();
  if (profile?.role !== "admin") redirect("/");
  return (
    <div className={`${spaceGrotesk.variable} ${jakarta.variable}`}>
      <ProfitLossClient />
    </div>
  );
}

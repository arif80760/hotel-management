import { redirect }                   from "next/navigation";
import { Oswald, Archivo }            from "next/font/google";
import { createSupabaseServerClient } from "@/lib/supabaseServer";
import ProfitLossClient               from "./ProfitLossClient";

const oswald  = Oswald({ subsets: ["latin"], weight: ["400","500","600","700"], display: "swap" });
const archivo = Archivo({ subsets: ["latin"], weight: ["400","500","600","700"], display: "swap" });

export const dynamic = "force-dynamic";

export default async function ProfitLossPage() {
  const serverClient = await createSupabaseServerClient();
  const { data: { user } } = await serverClient.auth.getUser();
  if (!user) redirect("/login");
  const { data: profile } = await serverClient.from("profiles").select("role").eq("id", user.id).single();
  if (profile?.role !== "admin") redirect("/");
  return <ProfitLossClient oswaldFamily={oswald.style.fontFamily} archivoFamily={archivo.style.fontFamily} />;
}

// app/accounts/cashbook/page.tsx
// Server wrapper with role guard — admin only.
//
// Staff who navigate to /accounts/cashbook (via link or direct URL)
// are redirected to "/" before CashbookClient renders. Mirrors the
// auth guard pattern from app/employees/page.tsx exactly.
//
// The Cashbook is the daybook view: balance cards + transaction list,
// with manual entry (transfers / cash injections) and CSV export.
// Auto-generated rows from booking payments appear here read-only.

import { redirect }                   from "next/navigation";
import { Oswald, Archivo }            from "next/font/google";
import { createSupabaseServerClient } from "@/lib/supabaseServer";
import CashbookClient                 from "./CashbookClient";

const oswald = Oswald({ subsets: ["latin"], weight: ["400", "500", "600", "700"] });
const archivo = Archivo({ subsets: ["latin"], weight: ["400", "500", "600"] });

export const dynamic = "force-dynamic";

export default async function CashbookPage() {
  const serverClient = await createSupabaseServerClient();
  const { data: { user } } = await serverClient.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await serverClient
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();

  if (profile?.role !== "admin") redirect("/");

  return (
    <CashbookClient
      oswaldFamily={oswald.style.fontFamily}
      archivoFamily={archivo.style.fontFamily}
    />
  );
}

// lib/supabaseServer.ts
//
// Cookie-based Supabase client for Next.js App Router Server Components.
// Uses @supabase/ssr to read the session JWT from the request cookie store,
// so queries run as the authenticated user (not the anon role).
//
// Usage:
//   const serverClient = await createSupabaseServerClient();
//   const { data: { user } } = await serverClient.auth.getUser();
//   if (!user) redirect("/login");
//   const data = await someServiceFn(id, serverClient);

import { createServerClient } from "@supabase/ssr";
import { cookies }            from "next/headers";

export async function createSupabaseServerClient() {
  const cookieStore = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return cookieStore.getAll(); },
        setAll() {
          // Server Components are read-only — no-op here.
          // Auth token refresh is handled by middleware if added later.
        },
      },
    },
  );
}

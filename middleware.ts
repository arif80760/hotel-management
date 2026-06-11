// ─────────────────────────────────────────────────────────────
// MIDDLEWARE
// Runs before every page load. Refreshes the Supabase session
// (writing updated auth cookies back to BOTH the request and the
// response) and redirects unauthenticated users to /login.
//
// IMPORTANT — single auth library:
//   This uses @supabase/ssr — the SAME library as lib/supabase.ts
//   (browser) and lib/supabaseServer.ts (server components).
//   The previous version used the deprecated
//   @supabase/auth-helpers-nextjs, which managed cookies with its
//   own logic. Running two different refresh mechanisms against
//   one session caused refresh-token reuse, which Supabase's
//   token-rotation protection treats as a compromised session —
//   signing the user out mid-use (~5 min after login).
//
//   Rule going forward: ALL Supabase clients in this project come
//   from @supabase/ssr. Never reintroduce auth-helpers.
// ─────────────────────────────────────────────────────────────
import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export async function middleware(request: NextRequest) {
  // Start with a pass-through response tied to this request.
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          // Write refreshed tokens onto the request (for any server
          // code later in this same render) AND onto the response
          // (so the browser receives the updated cookies).
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // IMPORTANT: do not run other code between createServerClient and
  // auth.getUser() — getUser() both validates the session and, if the
  // access token has expired, refreshes it (triggering setAll above).
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const isAuthPage      = request.nextUrl.pathname.startsWith("/login");
  const isProtectedPage = !isAuthPage && request.nextUrl.pathname !== "/";

  // Not logged in + protected page → go to login
  if (!user && isProtectedPage) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  // Logged in + login page → go to dashboard
  if (user && isAuthPage) {
    const url = request.nextUrl.clone();
    url.pathname = "/dashboard";
    return NextResponse.redirect(url);
  }

  // MUST return supabaseResponse (not a fresh NextResponse) so the
  // refreshed auth cookies actually reach the browser.
  return supabaseResponse;
}

// Routes this middleware applies to (static assets excluded)
export const config = {
  matcher: [
    "/((?!api|_next/static|_next/image|favicon.ico|logo.png).*)",
  ],
};

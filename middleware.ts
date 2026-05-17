// middleware.ts
//
// ─── SERVER-SIDE ROUTE PROTECTION ────────────────────────────────────────────
//
// Runs on every request matched by config.matcher (see below — static assets
// and /api/ routes are excluded).
//
// Responsibilities:
//   1. Read the @supabase/ssr cookie session.
//   2. Refresh the session token if expired, writing updated cookies back to
//      the browser via Set-Cookie response headers.
//   3. Redirect unauthenticated requests to /login before the page renders.
//
// ── CRITICAL INVARIANT — always return `supabaseResponse` ─────────────────
//   setAll() writes refreshed session cookies onto the `supabaseResponse`
//   object. If any code path returns a DIFFERENT response object (e.g. a
//   freshly constructed NextResponse.next()), those Set-Cookie headers are
//   silently dropped — the browser never receives the new tokens, and staff
//   will be logged out the next time their session token expires.
//   Every return path in this function MUST return `supabaseResponse`,
//   with the sole exception of the explicit redirect to /login.
//
// ── /login behaviour ──────────────────────────────────────────────────────
//   Logged-out user visits /login  → middleware passes through (no redirect
//                                    loop — /login is excluded from condition).
//   Logged-in user visits /login   → middleware passes through; the client-side
//                                    guard in components/AppShell.tsx detects
//                                    user && isLoginPage and calls
//                                    router.replace("/"). This split is
//                                    intentional: middleware owns the
//                                    logged-out case, AppShell owns the
//                                    logged-in-visits-login case.
//
// ─────────────────────────────────────────────────────────────────────────────

import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export async function middleware(request: NextRequest) {
  // Start with a plain pass-through response. If setAll() fires during token
  // refresh it will reassign this variable with a new response that carries
  // the updated cookies. Every return path below must return THIS variable.
  let supabaseResponse = NextResponse.next({ request });

  // Middleware-specific createServerClient.
  // This is intentionally NOT the same setup as lib/supabaseServer.ts:
  //   getAll — reads from the incoming NextRequest cookie jar.
  //   setAll — FULL implementation that writes refreshed tokens back to the
  //            browser via Set-Cookie. lib/supabaseServer.ts has a deliberate
  //            no-op setAll (Server Components cannot write response headers).
  //            Middleware CAN write response headers — this is the designated
  //            place for session token refresh in the App Router.
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          // Step 1: apply to the request so subsequent code in this middleware
          //         run sees the refreshed values immediately.
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          // Step 2: recreate supabaseResponse so it reflects the mutated request.
          supabaseResponse = NextResponse.next({ request });
          // Step 3: write to the outgoing response so the browser receives the
          //         updated Set-Cookie headers.
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // Use getUser() — NOT getSession().
  // getSession() reads from cookies without contacting the Auth server; a
  // malicious client could craft a cookie with a spoofed user ID. getUser()
  // contacts the Supabase Auth server on every call and returns a verified
  // record. The network cost is the correct trade-off for an auth guard.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Redirect unauthenticated requests to /login.
  // /login is explicitly excluded to prevent an infinite redirect loop.
  if (!user && !request.nextUrl.pathname.startsWith("/login")) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    return NextResponse.redirect(loginUrl);
  }

  // INVARIANT: return supabaseResponse — not a fresh NextResponse.next().
  // This object carries any Set-Cookie headers written by setAll() above.
  // Returning a different response object here silently drops those headers.
  return supabaseResponse;
}

export const config = {
  matcher: [
    /*
     * Match every path EXCEPT:
     *   _next/static  — Next.js static build output
     *   _next/image   — Next.js image optimisation endpoint
     *   favicon.ico   — browser favicon requests
     *   api/          — /api/employees/provision uses Authorization: Bearer
     *                   header auth (service-role key), not cookie sessions.
     *                   Running cookie middleware on it is harmless but
     *                   unnecessary. Excluded for clarity.
     *   *.svg *.png *.jpg *.jpeg *.gif *.webp
     *                 — static image files served from public/:
     *                   file.svg, globe.svg, hotel-albatross-logo.png,
     *                   next.svg, vercel.svg, window.svg
     */
    "/((?!_next/static|_next/image|favicon\\.ico|api/|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};

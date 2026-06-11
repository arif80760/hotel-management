// app/layout.tsx
//
// Root layout — wraps every page in the app.
//
// STRUCTURE (after auth was added):
//   AuthProvider        — provides session, user, profile, role, signIn, signOut
//     AppShell          — routing guard + conditional Sidebar/TopBar/HotelProvider
//       {children}      — the actual page content
//
// WHY AuthProvider is here (server component boundary):
//   layout.tsx is a Server Component. AuthProvider is a Client Component
//   but can be imported here — Next.js handles the boundary automatically.
//   AppShell must be a Client Component too (uses useAuth + useRouter).
//
// WHY Sidebar / TopBar / HotelProvider moved to AppShell:
//   The login page must render WITHOUT the sidebar and top bar.
//   AppShell checks the pathname and auth state, then conditionally
//   renders the full shell (Sidebar + TopBar + HotelProvider) only when
//   the user is authenticated and not on /login.

import type { Metadata } from "next";
import { Geist, Noto_Sans_Bengali } from "next/font/google";
import "./globals.css";
import { AuthProvider } from "@/contexts/AuthContext";
import AppShell from "@/components/AppShell";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const notoSansBengali = Noto_Sans_Bengali({
  variable: "--font-noto-bengali",
  subsets: ["bengali"],
  weight: ["400", "600"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Hotel Albatross Resort — Admin",
  description: "Internal hotel management system",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${notoSansBengali.variable} h-full w-full`}>
      <body className="h-full w-full flex antialiased">

        {/* AuthProvider — session + profile available to every component */}
        <AuthProvider>
          {/*
            AppShell handles:
              1. Loading spinner while session is being read
              2. Redirect to /login if not authenticated
              3. Redirect to / if on /login but already authenticated
              4. Full Sidebar + TopBar + HotelProvider when authenticated
              5. Bare children-only render on the /login page
          */}
          <AppShell>
            {children}
          </AppShell>
        </AuthProvider>

      </body>
    </html>
  );
}

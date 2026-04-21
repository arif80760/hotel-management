// layout.tsx
// This is the ROOT layout — it wraps every single page in the app.
// We added the Sidebar here so it appears on all pages automatically.

// app/layout.tsx
// Root layout — wraps every page.
// Structure: Sidebar (left) | column of TopBar + page content (right)

import type { Metadata } from "next";
import { Geist } from "next/font/google";
import "./globals.css";
import Sidebar from "@/components/Sidebar";
import TopBar from "@/components/TopBar";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
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
    <html lang="en" className={`${geistSans.variable} h-full`}>
      <body className="h-full flex antialiased">

        {/* Dark sidebar — fixed width, full height */}
        <Sidebar />

        {/* Right side: stacked top bar + scrollable page content */}
        <div className="flex-1 flex flex-col min-h-screen overflow-hidden">
          <TopBar />
          <main className="flex-1 overflow-y-auto bg-slate-50">
            {children}
          </main>
        </div>

      </body>
    </html>
  );
}

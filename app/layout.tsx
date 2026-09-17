import type { Metadata } from "next";
import Link from "next/link";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";
import { SiteHeader } from "@/components/SiteHeader";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Same runtime-configurable read as components/AdsenseAutoAds.tsx and
// app/ads.txt/route.ts -- module scope, not NEXT_PUBLIC_, so it comes from
// this deployment's .env rather than getting baked into the shared Docker
// image at CI build time.
const adsenseClientId = process.env.ADSENSE_CLIENT_ID;

export const metadata: Metadata = {
  title: "Release Watcher",
  description: "A calendar of upcoming TCG product releases.",
  // Lets Google associate this site with the AdSense account without
  // waiting on ads.txt propagation, and is Google's own recommended defense
  // against a third party claiming this site's inventory for their account.
  other: adsenseClientId ? { "google-adsense-account": adsenseClientId } : undefined,
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  // AdSense Auto Ads is no longer loaded here -- see components/AdsenseAutoAds.tsx
  // for why (Google rejected the site over ads firing on content-free
  // screens). Each content-bearing page renders that component itself.
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex h-dvh flex-col overflow-hidden">
        <Providers>
          <SiteHeader />
          <main className="min-h-0 flex-1 overflow-y-auto">
            {children}
            <footer className="flex flex-wrap items-center justify-center gap-4 border-t border-gray-200 px-4 py-6 text-xs text-gray-500 dark:border-gray-800 dark:text-gray-500">
              <Link href="/about" className="hover:underline">
                About
              </Link>
              <Link href="/privacy" className="hover:underline">
                Privacy Policy
              </Link>
              <Link href="/terms" className="hover:underline">
                Terms of Service
              </Link>
            </footer>
          </main>
        </Providers>
      </body>
    </html>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";
import { SiteHeader } from "@/components/SiteHeader";
import { SITE_URL } from "@/lib/siteUrl";
import { serializeJsonLd } from "@/lib/jsonLd";

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

const SITE_DESCRIPTION =
  "Track upcoming Magic: The Gathering, Pokémon, One Piece, Disney Lorcana, Gundam, Riftbound, Union Arena, Flesh and Blood, Digimon, and Yu-Gi-Oh release dates, cross-checked against official sources, retailers, and community trackers.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "Release Watcher - TCG Release Date Calendar",
    template: "%s - Release Watcher",
  },
  description: SITE_DESCRIPTION,
  openGraph: {
    title: "Release Watcher - TCG Release Date Calendar",
    description: SITE_DESCRIPTION,
    url: "/",
    siteName: "Release Watcher",
    type: "website",
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: "Release Watcher - TCG Release Date Calendar",
    description: SITE_DESCRIPTION,
  },
  // Lets Google associate this site with the AdSense account without
  // waiting on ads.txt propagation, and is Google's own recommended defense
  // against a third party claiming this site's inventory for their account.
  other: adsenseClientId ? { "google-adsense-account": adsenseClientId } : undefined,
};

// WebSite + SearchAction JSON-LD: tells Google /calendar?search={term} is a
// real, working search entry point for this site (parseCalendarSearchParams
// reads that exact param server-side), which is what Sitelinks Search Box
// eligibility is keyed on. Site-wide here rather than home-page-only purely
// for simplicity -- repeating the same small script on every page is
// harmless, and there's no per-route reason to vary it.
const WEBSITE_JSON_LD = {
  "@context": "https://schema.org",
  "@type": "WebSite",
  name: "Release Watcher",
  url: SITE_URL,
  potentialAction: {
    "@type": "SearchAction",
    target: `${SITE_URL}/calendar?search={search_term_string}`,
    "query-input": "required name=search_term_string",
  },
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
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: serializeJsonLd(WEBSITE_JSON_LD) }}
        />
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

import type { Metadata } from "next";
import Link from "next/link";
import Script from "next/script";
import { getServerSession } from "next-auth";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { authOptions } from "./auth";
import { Providers } from "./providers";
import { AuthButton } from "@/components/AuthButton";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Release Watcher",
  description: "A calendar of upcoming TCG product releases.",
};

// Server-read (not NEXT_PUBLIC_) so it's configurable per-deployment at
// runtime via .env, same as GOOGLE_CLIENT_ID/ADMIN_EMAILS -- this app ships
// one prebuilt Docker image (see docker-compose.registry.yml), and a
// NEXT_PUBLIC_ var would get baked into that shared image at CI build time
// instead. Unset = no ads at all, same no-op-until-configured pattern as
// SMTP_HOST for email alerts.
const adsenseClientId = process.env.ADSENSE_CLIENT_ID;

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // Premium is ad-free (see /premium) -- checked here, not just hidden with
  // CSS, so the ad script genuinely never loads/fires for a premium user.
  const session = await getServerSession(authOptions);
  const showAds = Boolean(adsenseClientId) && !session?.user?.isPremium;

  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex h-dvh flex-col overflow-hidden">
        {showAds && (
          // Google AdSense Auto Ads: one loader script, no per-page ad-unit
          // markup needed -- Google places ads algorithmically once the
          // account is approved. See .env.example for setup.
          <Script
            async
            src={`https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${adsenseClientId}`}
            crossOrigin="anonymous"
            strategy="afterInteractive"
          />
        )}
        <Providers>
          <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-gray-200 px-4 py-3 dark:border-gray-800">
            <div className="flex flex-wrap items-center gap-4">
              <span className="font-semibold">Release Watcher</span>
              <nav className="flex items-center gap-3">
                <Link href="/calendar" className="text-sm text-gray-700 hover:underline">
                  Calendar
                </Link>
                <Link href="/premium" className="text-sm text-gray-700 hover:underline">
                  Upgrade
                </Link>
              </nav>
            </div>
            <AuthButton />
          </header>
          <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
        </Providers>
      </body>
    </html>
  );
}

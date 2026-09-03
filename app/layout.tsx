import type { Metadata } from "next";
import Link from "next/link";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
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

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex h-dvh flex-col overflow-hidden">
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

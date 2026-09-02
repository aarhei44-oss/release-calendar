import type { Metadata } from "next";
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
      <body className="min-h-full flex flex-col">
        <Providers>
          <header className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-200 px-4 py-3">
            <span className="font-semibold">Release Watcher</span>
            <AuthButton />
          </header>
          {children}
        </Providers>
      </body>
    </html>
  );
}

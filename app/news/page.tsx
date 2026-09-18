import type { Metadata } from "next";
import Link from "next/link";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/auth";
import { SignInPrompt } from "@/components/SignInPrompt";
import { listEnabledInstallsForFilters } from "@/data/calendar/calendarRepo";
import { listNewsItems } from "@/data/news/newsRepo";
import { NewsShell } from "./NewsShell";

export const metadata: Metadata = {
  title: "News - Release Watcher",
  description: "Full multi-source TCG news feed, filterable by game.",
};

type Props = {
  searchParams: Promise<{ installIds?: string }>;
};

function parseInstallIds(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(",").filter(Boolean);
}

export default async function NewsPage({ searchParams }: Props) {
  const [session, { installIds: rawInstallIds }] = await Promise.all([
    getServerSession(authOptions),
    searchParams,
  ]);

  if (!session?.user) {
    return <SignInPrompt message="Sign in to read the full multi-source TCG news feed." />;
  }

  if (!session.user.isPremium) {
    return (
      <div className="flex flex-col items-center gap-3 p-12 text-center">
        <span className="rounded-full bg-purple-100 px-2.5 py-1 text-xs font-medium text-purple-800 dark:bg-purple-900/40 dark:text-purple-300">
          Premium
        </span>
        <p className="max-w-md text-gray-600 dark:text-gray-400">
          The full news feed -- every source, filterable by game -- is a Premium feature. The landing page still
          carries a free 3-headline teaser.
        </p>
        <Link
          href="/premium"
          className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 dark:bg-gray-100 dark:text-gray-900"
        >
          Upgrade to Premium
        </Link>
      </div>
    );
  }

  const installIds = parseInstallIds(rawInstallIds);

  const [installs, items] = await Promise.all([
    listEnabledInstallsForFilters(),
    listNewsItems({ installIds }),
  ]);

  return (
    <NewsShell
      installOptions={installs.map((install) => ({ id: install.id, name: install.package.name }))}
      installIds={installIds}
      items={items}
    />
  );
}

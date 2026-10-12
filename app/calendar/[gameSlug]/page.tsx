import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getEnabledInstallByGameSlug } from "@/data/calendar/calendarRepo";
import { getFilteredEvents } from "../actions";
import { DEFAULT_RELEASE_EVENT_TYPES } from "../searchParams";
import { eventTitle } from "../mapEvents";
import { formatEventDate, statusBadgeClass } from "../eventDisplay";

type Props = {
  params: Promise<{ gameSlug: string }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { gameSlug } = await params;
  const install = await getEnabledInstallByGameSlug(gameSlug);
  if (!install) return {};

  const title = `${install.package.name} TCG Release Dates`;
  const description = `Upcoming ${install.package.name} release dates -- shelf dates, prereleases, and more, cross-checked against official sources.`;
  const canonical = `/calendar/${gameSlug}`;

  return {
    title,
    description,
    alternates: { canonical },
    openGraph: { title, description, url: canonical, siteName: "Release Watcher", type: "website" },
  };
}

export default async function GameIndexPage({ params }: Props) {
  const { gameSlug } = await params;
  const install = await getEnabledInstallByGameSlug(gameSlug);
  if (!install) notFound();

  // A roughly "current" window rather than every event ever tracked for
  // this install (a bare getFilteredEvents call with no from/to returns
  // literally everything, including years-old discontinued products) --
  // generous on both ends since this page's job is "what's going on with
  // this game right now", not a precise calendar view.
  const from = new Date();
  from.setDate(from.getDate() - 30);
  const to = new Date();
  to.setDate(to.getDate() + 365);

  const events = await getFilteredEvents({
    installIds: [install.id],
    types: DEFAULT_RELEASE_EVENT_TYPES,
    from,
    to,
  });

  // One row per product, not per event -- a set with both a prerelease and
  // a shelf-date row would otherwise show up twice. events is already
  // date-ordered (see calendarRepo's getFilteredEvents), so the first
  // occurrence of a productSetId is its soonest event.
  const seen = new Set<string>();
  const rows = events.filter((event) => {
    if (seen.has(event.productSetId)) return false;
    seen.add(event.productSetId);
    return true;
  });

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-16">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-bold">{install.package.name} Release Dates</h1>
        <p className="text-sm text-gray-500 dark:text-gray-500">
          Cross-checked {install.package.name} release dates, updated daily.{" "}
          <Link href="/calendar" className="underline">
            View the full calendar
          </Link>
          .
        </p>
      </header>

      {rows.length === 0 ? (
        <p className="py-8 text-center text-sm text-gray-500 dark:text-gray-400">
          No upcoming {install.package.name} releases right now.
        </p>
      ) : (
        <ul className="divide-y divide-gray-200 dark:divide-gray-800">
          {rows.map((event) => {
            const href = event.productSet.slug
              ? `/calendar/${gameSlug}/${event.productSet.slug}`
              : `/calendar?eventId=${event.id}`;
            return (
              <li key={event.productSetId}>
                <Link
                  href={href}
                  className="flex w-full flex-wrap items-center justify-between gap-2 py-3 text-left transition-colors hover:bg-gray-50 dark:hover:bg-gray-900"
                >
                  <p className="font-medium text-gray-900 dark:text-gray-100">{eventTitle(event)}</p>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="text-sm text-gray-500 dark:text-gray-400">{formatEventDate(event)}</span>
                    <span className={`shrink-0 rounded px-2 py-0.5 text-xs font-medium ${statusBadgeClass(event.status)}`}>
                      {event.status}
                    </span>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

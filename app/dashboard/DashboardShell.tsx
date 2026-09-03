"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { CalendarEvent } from "@/data/calendar/calendarRepo";
import { EventsList } from "@/app/calendar/EventsList";

type SubscribedGame = { id: string; name: string };

type Props = {
  subscribedGames: SubscribedGame[];
  upcoming: CalendarEvent[];
  recentActivity: CalendarEvent[];
};

export function DashboardShell({ subscribedGames, upcoming, recentActivity }: Props) {
  const router = useRouter();
  const newlyConfirmed = recentActivity.filter((e) => e.status === "CONFIRMED");
  // getFilteredEvents (shared with /calendar and /subscriptions) deliberately
  // includes TBD events in any date-range query, since a TBD event has no
  // date to exclude it by -- that's the right call for a general calendar
  // view, but "Next 7 days" specifically promises near-term dates, so it
  // would be misleading to list undated events here (real example: decades
  // of TBD MTG reprints flooding a "next 7 days" list).
  const upcomingWithDates = upcoming.filter((e) => e.dateType !== "TBD");

  function openEvent(eventId: string) {
    router.push(`/calendar?tab=upcoming&eventId=${eventId}`);
  }

  if (subscribedGames.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 p-12 text-center">
        <p className="text-gray-600 dark:text-gray-400">
          You&rsquo;re not subscribed to any games yet, so there&rsquo;s nothing to show here.
        </p>
        <Link
          href="/subscriptions"
          className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700"
        >
          Choose your games
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8 p-4">
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Your games</h2>
          <Link href="/subscriptions" className="text-sm text-gray-500 hover:underline dark:text-gray-400">
            Manage
          </Link>
        </div>
        <ul className="flex flex-wrap gap-2">
          {subscribedGames.map((game) => {
            const count = upcomingWithDates.filter((e) => e.productSet.install.package.name === game.name).length;
            return (
              <li
                key={game.id}
                className="rounded-full border border-gray-300 px-3 py-1 text-sm text-gray-700 dark:border-gray-700 dark:text-gray-300"
              >
                {game.name}
                {count > 0 && <span className="ml-1.5 text-gray-400">· {count}</span>}
              </li>
            );
          })}
        </ul>
      </section>

      <section>
        <h2 className="mb-2 text-lg font-semibold">Next 7 days</h2>
        <EventsList
          events={upcomingWithDates}
          onSelectEvent={openEvent}
          emptyMessage="Nothing with a set date in your subscriptions over the next 7 days."
        />
      </section>

      {newlyConfirmed.length > 0 && (
        <section>
          <h2 className="mb-2 text-lg font-semibold">Newly confirmed</h2>
          <EventsList events={newlyConfirmed} onSelectEvent={openEvent} sortBy="recentlyUpdated" />
        </section>
      )}

      <section>
        <h2 className="mb-2 text-lg font-semibold">What&rsquo;s new</h2>
        <p className="mb-2 text-sm text-gray-500 dark:text-gray-400">
          Events touched by a scan in the last 7 days -- a new discovery and a status change both show up here.
        </p>
        <EventsList
          events={recentActivity}
          onSelectEvent={openEvent}
          sortBy="recentlyUpdated"
          emptyMessage="No activity on your subscriptions in the last 7 days."
        />
      </section>
    </div>
  );
}

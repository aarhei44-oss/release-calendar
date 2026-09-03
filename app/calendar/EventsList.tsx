"use client";

import type { CalendarEvent } from "@/data/calendar/calendarRepo";
import { useUserTimeZone } from "@/lib/useUserTimeZone";
import { eventTitle } from "./mapEvents";
import { formatEventDate, formatRelativeTime, sortKeyFor, statusBadgeClass } from "./eventDisplay";

type Props = {
  events: CalendarEvent[];
  onSelectEvent: (eventId: string) => void;
  emptyMessage?: string;
  /** "date" (default) sorts/shows by release date, for a calendar-style list. "recentlyUpdated" sorts by updatedAt desc and shows "updated X ago" instead -- for a "what's new" feed where recency of the change matters more than the release date itself. */
  sortBy?: "date" | "recentlyUpdated";
};

export function EventsList({
  events,
  onSelectEvent,
  emptyMessage = "No releases match the current filters.",
  sortBy = "date",
}: Props) {
  const timeZone = useUserTimeZone();
  const sorted =
    sortBy === "recentlyUpdated"
      ? [...events].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      : [...events].sort((a, b) => sortKeyFor(a) - sortKeyFor(b));

  if (sorted.length === 0) {
    return <p className="py-8 text-center text-sm text-gray-500 dark:text-gray-400">{emptyMessage}</p>;
  }

  return (
    <ul className="divide-y divide-gray-200 dark:divide-gray-800">
      {sorted.map((event) => (
        <li key={event.id}>
          <button
            type="button"
            data-testid="event-row"
            onClick={() => onSelectEvent(event.id)}
            className="flex w-full flex-wrap items-center justify-between gap-2 py-3 text-left transition-colors hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gray-900 dark:hover:bg-gray-900 dark:focus-visible:ring-gray-100"
          >
            <div>
              <p className="font-medium text-gray-900 dark:text-gray-100">{eventTitle(event)}</p>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {event.productSet.install.package.name} ·{" "}
                {sortBy === "recentlyUpdated" ? `updated ${formatRelativeTime(event.updatedAt)}` : formatEventDate(event, timeZone)}
              </p>
            </div>
            <span
              className={`shrink-0 rounded px-2 py-0.5 text-xs font-medium ${statusBadgeClass(event.status)}`}
            >
              {event.status}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

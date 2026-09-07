"use client";

import { useMemo, useState, useSyncExternalStore } from "react";
import {
  endOfMonth,
  startOfWeek,
  endOfWeek,
  eachDayOfInterval,
  isSameMonth,
  isToday,
  format,
} from "date-fns";
import type { CalendarEvent } from "@/data/calendar/calendarRepo";
import type { MappedCalendarEvent } from "./mapEvents";
import { EventsList } from "./EventsList";
import { RangeWindowSection } from "./RangeWindowSection";
import { statusDotClass, type ReactionCounts } from "./eventDisplay";

type Props = {
  events: MappedCalendarEvent[];
  /** RANGE/WINDOW events for the month in view, absent from `events` -- see mapEventsForGrid. */
  flexibleEvents: CalendarEvent[];
  month: string; // YYYY-MM
  onSelectEvent: (eventId: string) => void;
  /** Keyed by event id; events with no reactions are simply absent. */
  reactionSummaries?: Record<string, ReactionCounts>;
};

const WEEKDAY_LABELS = ["S", "M", "T", "W", "T", "F", "S"];

function dayKey(date: Date): string {
  return format(date, "yyyy-MM-dd");
}

function eventCoversDay(day: Date, event: MappedCalendarEvent): boolean {
  const key = dayKey(day);
  return dayKey(event.start) <= key && key <= dayKey(event.end);
}

/** The day selected before anyone taps: today, when the month in view contains it. */
function defaultSelection(monthStart: Date): string | null {
  const today = new Date();
  return isSameMonth(today, monthStart) ? dayKey(today) : null;
}

const subscribeToNothing = () => () => {};

/**
 * False on the server and through the first client render, true afterwards.
 * `useSyncExternalStore` is how React wants a client-only value read during
 * render; a `useState` + `useEffect` pair would say the same thing by way of
 * a banned setState-in-effect.
 */
function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribeToNothing,
    () => true,
    () => false,
  );
}

/**
 * A tappable day-number grid for narrow screens, in place of react-big-
 * calendar's month view -- that one lays out full event pills across a
 * fixed-width 7-column grid, which is why the calendar tab needed
 * horizontal scrolling on mobile. This trades inline event pills for a
 * status dot per day; tapping a day lists its releases below instead.
 */
export function MobileMonthCalendar({ events, flexibleEvents, month, onSelectEvent, reactionSummaries }: Props) {
  const [year, mon] = month.split("-").map(Number);
  const monthStart = useMemo(() => new Date(year, mon - 1, 1), [year, mon]);

  const days = useMemo(() => {
    const start = startOfWeek(monthStart);
    const end = endOfWeek(endOfMonth(monthStart));
    return eachDayOfInterval({ start, end });
  }, [monthStart]);

  const eventsByDay = useMemo(() => {
    const map = new Map<string, MappedCalendarEvent[]>();
    for (const day of days) {
      const matches = events.filter((event) => eventCoversDay(day, event));
      if (matches.length > 0) map.set(dayKey(day), matches);
    }
    return map;
  }, [days, events]);

  // A tap only speaks for the month it happened in, so moving to another month
  // falls back to that month's default selection with no state to reset.
  const [tapped, setTapped] = useState<{ month: string; day: string | null } | null>(null);

  // Only the browser can be trusted to know what "today" is -- the server may
  // sit in another timezone -- so the server and the hydrating render select
  // nothing, and the default appears once hydration is done.
  const hydrated = useHydrated();
  const selectedDay =
    tapped?.month === month ? tapped.day : hydrated ? defaultSelection(monthStart) : null;

  const selectedEvents = selectedDay ? (eventsByDay.get(selectedDay) ?? []) : [];

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div
        role="grid"
        aria-label="Month"
        className="grid shrink-0 grid-cols-7 gap-px overflow-hidden rounded-md border border-gray-200 bg-gray-200 text-center dark:border-gray-800 dark:bg-gray-800"
      >
        {WEEKDAY_LABELS.map((label, i) => (
          <div
            key={i}
            className="bg-white py-1.5 text-xs font-medium text-gray-500 dark:bg-gray-900 dark:text-gray-400"
          >
            {label}
          </div>
        ))}
        {days.map((day) => {
          const key = dayKey(day);
          const dayEvents = eventsByDay.get(key) ?? [];
          const inMonth = isSameMonth(day, monthStart);
          const selected = key === selectedDay;
          const statuses = [...new Set(dayEvents.map((event) => event.resource.status))].slice(0, 3);

          return (
            <button
              key={key}
              type="button"
              role="gridcell"
              aria-selected={selected}
              onClick={() => setTapped({ month, day: selected ? null : key })}
              className={`flex min-h-14 flex-col items-center gap-1 bg-white py-1.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gray-900 dark:bg-gray-900 dark:focus-visible:ring-gray-100 ${
                selected ? "ring-2 ring-inset ring-gray-900 dark:ring-gray-100" : ""
              }`}
            >
              <span
                className={`text-sm ${inMonth ? "text-gray-900 dark:text-gray-100" : "text-gray-300 dark:text-gray-700"} ${
                  isToday(day)
                    ? "flex h-5 w-5 items-center justify-center rounded-full bg-gray-900 font-semibold text-white dark:bg-gray-100 dark:text-gray-900"
                    : ""
                }`}
              >
                {day.getDate()}
              </span>
              {statuses.length > 0 && (
                <span className="flex items-center gap-0.5">
                  {statuses.map((status) => (
                    <span key={status} className={`h-1.5 w-1.5 rounded-full ${statusDotClass(status)}`} />
                  ))}
                  {dayEvents.length > statuses.length && (
                    <span className="text-[9px] leading-none text-gray-400 dark:text-gray-500">+</span>
                  )}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
        {selectedDay ? (
          <EventsList
            events={selectedEvents.map((event) => event.resource)}
            onSelectEvent={onSelectEvent}
            emptyMessage="Nothing scheduled this day."
            reactionSummaries={reactionSummaries}
          />
        ) : (
          <p className="py-8 text-center text-sm text-gray-500 dark:text-gray-400">
            Tap a day to see its releases.
          </p>
        )}
        <RangeWindowSection events={flexibleEvents} onSelectEvent={onSelectEvent} reactionSummaries={reactionSummaries} />
      </div>
    </div>
  );
}

import type { CalendarEvent } from "@/data/calendar/calendarRepo";

const DATE_FORMATTER = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
const MONTH_FORMATTER = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" });

export function formatEventDate(event: CalendarEvent): string {
  switch (event.dateType) {
    case "EXACT":
      return event.dateExact ? DATE_FORMATTER.format(event.dateExact) : "Date unconfirmed";
    case "RANGE":
      return event.dateStart && event.dateEnd
        ? `${DATE_FORMATTER.format(event.dateStart)} – ${DATE_FORMATTER.format(event.dateEnd)}`
        : "Date unconfirmed";
    case "WINDOW":
      return event.windowStart ? MONTH_FORMATTER.format(event.windowStart) : "Date unconfirmed";
    case "TBD":
      return "Date unconfirmed";
  }
}

export function sortKeyFor(event: CalendarEvent): number {
  const date = event.dateExact ?? event.dateStart ?? event.windowStart;
  return date ? date.getTime() : Number.POSITIVE_INFINITY;
}

const RELATIVE_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["day", 24 * 60 * 60 * 1000],
  ["hour", 60 * 60 * 1000],
  ["minute", 60 * 1000],
];
const RELATIVE_FORMATTER = new Intl.RelativeTimeFormat("en-US", { numeric: "auto" });

/** "3 days ago", "2 hours ago", etc. -- for a "what's new" feed sorted by updatedAt, where the exact date is secondary to how recently it changed. */
export function formatRelativeTime(date: Date): string {
  const diffMs = date.getTime() - Date.now();
  for (const [unit, unitMs] of RELATIVE_UNITS) {
    if (Math.abs(diffMs) >= unitMs) {
      return RELATIVE_FORMATTER.format(Math.round(diffMs / unitMs), unit);
    }
  }
  return RELATIVE_FORMATTER.format(0, "minute");
}

const STATUS_STYLES: Record<CalendarEvent["status"], string> = {
  RUMORED: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
  ANNOUNCED: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  CONFIRMED: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
  RELEASED: "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300",
  CANCELLED: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
};

export function statusBadgeClass(status: CalendarEvent["status"]): string {
  return STATUS_STYLES[status];
}

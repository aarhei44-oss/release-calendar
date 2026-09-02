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

const STATUS_STYLES: Record<CalendarEvent["status"], string> = {
  RUMORED: "bg-gray-100 text-gray-700",
  ANNOUNCED: "bg-blue-100 text-blue-700",
  CONFIRMED: "bg-green-100 text-green-700",
  RELEASED: "bg-purple-100 text-purple-700",
  CANCELLED: "bg-red-100 text-red-700",
};

export function statusBadgeClass(status: CalendarEvent["status"]): string {
  return STATUS_STYLES[status];
}

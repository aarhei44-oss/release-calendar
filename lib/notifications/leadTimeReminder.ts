import type { CalendarEvent } from "@/data/calendar/calendarRepo";
import { eventTitle } from "@/app/calendar/mapEvents";
import { formatEventDate } from "@/app/calendar/eventDisplay";

export function leadTimeReminderSubject(days: number, eventCount: number): string {
  return `${eventCount} release${eventCount === 1 ? "" : "s"} in ${days} day${days === 1 ? "" : "s"}`;
}

export function leadTimeReminderBody(events: CalendarEvent[]): string {
  return events
    .map((event) => `${event.productSet.install.package.name} - ${eventTitle(event)}: ${formatEventDate(event)}`)
    .join("\n");
}

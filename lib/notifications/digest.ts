import type { CalendarEvent } from "@/data/calendar/calendarRepo";
import type { DigestFrequency } from "@/app/generated/prisma/client";
import { eventTitle } from "@/app/calendar/mapEvents";
import { formatEventDate } from "@/app/calendar/eventDisplay";

export function digestSubject(frequency: DigestFrequency, eventCount: number): string {
  const cadence = frequency === "WEEKLY" ? "Weekly" : "Daily";
  if (eventCount === 0) return `${cadence} digest: nothing new upcoming`;
  return `${cadence} digest: ${eventCount} upcoming release${eventCount === 1 ? "" : "s"}`;
}

/**
 * Sent even when `events` is empty -- unlike the immediate alert email
 * (only sent when there's an actual change), a digest runs on a fixed
 * cadence the user opted into, so a quiet "nothing new" confirms the
 * feature is working rather than the recipient wondering if it's silently
 * broken.
 */
export function digestBody(events: CalendarEvent[], timeZone?: string): string {
  if (events.length === 0) {
    return "Nothing new upcoming for your subscriptions right now.";
  }
  return events
    .map((event) => `${event.productSet.install.package.name} - ${eventTitle(event)}: ${formatEventDate(event, timeZone)}`)
    .join("\n");
}

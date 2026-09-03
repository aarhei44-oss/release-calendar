import type { CalendarEvent } from "@/data/calendar/calendarRepo";
import { eventTitle } from "@/app/calendar/mapEvents";

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function formatIcsDate(date: Date): string {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

function formatIcsTimestamp(date: Date): string {
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function escapeIcsText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

// DTEND is exclusive for an all-day VEVENT (RFC 5545 §3.6.1), so a
// single-day EXACT event spans [date, date+1) and a multi-day RANGE/WINDOW
// spans [start, end+1).
export function eventSpan(event: CalendarEvent): { start: Date; end: Date } | null {
  switch (event.dateType) {
    case "EXACT":
      return event.dateExact ? { start: event.dateExact, end: addDays(event.dateExact, 1) } : null;
    case "RANGE":
      return event.dateStart && event.dateEnd ? { start: event.dateStart, end: addDays(event.dateEnd, 1) } : null;
    case "WINDOW":
      return event.windowStart && event.windowEnd ? { start: event.windowStart, end: addDays(event.windowEnd, 1) } : null;
    case "TBD":
      return null;
  }
}

/**
 * Minimal hand-rolled iCalendar (RFC 5545) serializer -- no external
 * dependency, since every event here needs the same shape: one all-day
 * VEVENT. Doesn't implement line folding for lines over 75 octets, a known
 * simplification most calendar clients tolerate fine given how short a
 * "game - set name" SUMMARY line stays in practice.
 */
export function buildIcsFeed(events: CalendarEvent[]): string {
  const dtstamp = formatIcsTimestamp(new Date());
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Release Watcher//Personal Calendar Feed//EN",
    "CALSCALE:GREGORIAN",
  ];

  for (const event of events) {
    const span = eventSpan(event);
    if (!span) continue;

    const summary = `${event.productSet.install.package.name} - ${eventTitle(event)}`;

    lines.push(
      "BEGIN:VEVENT",
      `UID:${event.id}@releasewatcher.com`,
      `DTSTAMP:${dtstamp}`,
      `DTSTART;VALUE=DATE:${formatIcsDate(span.start)}`,
      `DTEND;VALUE=DATE:${formatIcsDate(span.end)}`,
      `SUMMARY:${escapeIcsText(summary)}`,
      `STATUS:${event.status === "CANCELLED" ? "CANCELLED" : "CONFIRMED"}`,
      "END:VEVENT",
    );
  }

  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}

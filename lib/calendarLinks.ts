import type { CalendarEvent } from "@/data/calendar/calendarRepo";
import { eventSpan, formatIcsDate } from "@/lib/ical";
import { eventTitle } from "@/app/calendar/mapEvents";

function summaryFor(event: CalendarEvent): string {
  return `${event.productSet.install.package.name} - ${eventTitle(event)}`;
}

// formatIcsDate reads local Y/M/D components (not UTC), so this stays
// correct for viewers east of UTC where Date#toISOString would roll an
// all-day date back to the previous day.
function isoDateOnly(date: Date): string {
  const ymd = formatIcsDate(date);
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
}

/**
 * Google Calendar's "create event" template link. `dates` end is exclusive,
 * same convention as this event's ICS DTEND (see eventSpan). Null for a TBD
 * event with no date to place.
 */
export function googleCalendarEventUrl(event: CalendarEvent): string | null {
  const span = eventSpan(event);
  if (!span) return null;
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: summaryFor(event),
    dates: `${formatIcsDate(span.start)}/${formatIcsDate(span.end)}`,
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

function outlookEventUrl(host: string, event: CalendarEvent): string | null {
  const span = eventSpan(event);
  if (!span) return null;
  const params = new URLSearchParams({
    path: "/calendar/action/compose",
    rru: "addevent",
    startdt: isoDateOnly(span.start),
    // Outlook's compose deep link end date is inclusive for all-day events
    // (unlike Google's), so back off the exclusive span end by one day.
    enddt: isoDateOnly(new Date(span.end.getFullYear(), span.end.getMonth(), span.end.getDate() - 1)),
    subject: summaryFor(event),
    allday: "true",
  });
  return `https://${host}/calendar/0/deeplink/compose?${params.toString()}`;
}

/** Personal Microsoft accounts (outlook.com / hotmail.com / live.com). */
export function outlookComEventUrl(event: CalendarEvent): string | null {
  return outlookEventUrl("outlook.live.com", event);
}

/** Work/school Microsoft 365 accounts. */
export function office365EventUrl(event: CalendarEvent): string | null {
  return outlookEventUrl("outlook.office.com", event);
}

/**
 * One-click "subscribe to this feed URL" deep links, for the whole personal
 * iCal feed (see app/api/ical/[token]/feed.ics) rather than a single event.
 */
export function googleCalendarSubscribeUrl(feedUrl: string): string {
  const webcalUrl = feedUrl.replace(/^https?:\/\//, "webcal://");
  return `https://calendar.google.com/calendar/render?cid=${encodeURIComponent(webcalUrl)}`;
}

function outlookSubscribeUrl(host: string, feedUrl: string, name: string): string {
  const params = new URLSearchParams({ url: feedUrl, name });
  return `https://${host}/calendar/0/addcalendar?${params.toString()}`;
}

export function outlookComSubscribeUrl(feedUrl: string, name: string): string {
  return outlookSubscribeUrl("outlook.live.com", feedUrl, name);
}

export function office365SubscribeUrl(feedUrl: string, name: string): string {
  return outlookSubscribeUrl("outlook.office.com", feedUrl, name);
}

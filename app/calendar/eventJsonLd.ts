import type { CalendarEvent } from "@/data/calendar/calendarRepo";
import { eventSpan } from "@/lib/ical";
import { eventTitle } from "./mapEvents";
import { SITE_URL } from "@/lib/siteUrl";

// eventSpan's dates are UTC midnight (see eventDisplay.ts's DATE_FORMATTER
// comment for why) -- UTC getters read back the calendar day they were
// built from; local getters would roll it back a day for any viewer/server
// behind UTC.
function isoDate(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

/**
 * schema.org Event entries for whatever's currently in view on /calendar.
 *
 * Release Watcher tracks shelf/prerelease dates, not attendable events --
 * there's no venue, and eventAttendanceMode/location aren't a natural fit.
 * VirtualLocation pointed at this event's own calendar deep link is the
 * closest honest mapping schema.org offers (it's the sanctioned shape for
 * an online-only "event"), used here for semantic/entity value rather than
 * any expectation of Google's Event rich-result carousel, which is scoped
 * to real-world attendable events and wouldn't apply to a release date
 * either way.
 *
 * TBD events are skipped -- Event requires a startDate, and "Date
 * unconfirmed" has none to give it.
 */
export function buildEventJsonLd(events: CalendarEvent[]): object | null {
  const items = events
    .map((event) => {
      const span = eventSpan(event);
      if (!span) return null;
      return {
        "@type": "Event" as const,
        name: `${event.productSet.install.package.name} - ${eventTitle(event)}`,
        startDate: isoDate(span.start),
        // span.end is exclusive (see eventSpan's comment); Event's endDate isn't.
        endDate: isoDate(new Date(span.end.getTime() - 1)),
        eventStatus:
          event.status === "CANCELLED" ? "https://schema.org/EventCancelled" : "https://schema.org/EventScheduled",
        eventAttendanceMode: "https://schema.org/OnlineEventAttendanceMode",
        location: {
          "@type": "VirtualLocation" as const,
          url: `${SITE_URL}/calendar?eventId=${event.id}`,
        },
        ...(event.productSet.imageUrl ? { image: [event.productSet.imageUrl] } : {}),
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);

  if (items.length === 0) return null;

  return {
    "@context": "https://schema.org",
    "@type": "ItemList",
    itemListElement: items.map((item, i) => ({ "@type": "ListItem", position: i + 1, item })),
  };
}

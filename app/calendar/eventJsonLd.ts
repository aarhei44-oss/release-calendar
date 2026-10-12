import type { CalendarEvent } from "@/data/calendar/calendarRepo";
import { eventTitle } from "./mapEvents";
import { SITE_URL } from "@/lib/siteUrl";

// eventSpan's dates are UTC midnight (see eventDisplay.ts's DATE_FORMATTER
// comment for why) -- UTC getters read back the calendar day they were
// built from; local getters would roll it back a day for any viewer/server
// behind UTC.
function isoDate(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

// Structural, not lib/ical.ts's CalendarEvent-typed eventSpan: this file
// needs to map two different shapes to JSON-LD (a ReleaseEvent that already
// carries its own productSet, from /calendar's list; and one reached via
// its parent ProductSet's `releaseEvents`, from the new detail page, which
// has no nested productSet back-reference). Both have every base
// ReleaseEvent scalar field, which is all a date span needs.
type DatedEvent = {
  dateType: "EXACT" | "RANGE" | "WINDOW" | "TBD";
  dateExact: Date | null;
  dateStart: Date | null;
  dateEnd: Date | null;
  windowStart: Date | null;
  windowEnd: Date | null;
};

// DTEND-exclusive, same convention as lib/ical.ts's eventSpan (kept in sync
// with it deliberately -- see that file's comment for the RFC 5545 citation).
function spanFor(event: DatedEvent): { start: Date; end: Date } | null {
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

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

type EventStatusLike = "RUMORED" | "ANNOUNCED" | "CONFIRMED" | "RELEASED" | "CANCELLED";

/**
 * One schema.org Event object, or null for a TBD event (Event requires a
 * startDate, and "Date unconfirmed" has none to give it).
 *
 * Release Watcher tracks shelf/prerelease dates, not attendable events --
 * there's no venue, and eventAttendanceMode/location aren't a natural fit.
 * VirtualLocation pointed at a page about this event is the closest honest
 * mapping schema.org offers (the sanctioned shape for an online-only
 * "event"), used here for semantic/entity value rather than any
 * expectation of Google's Event rich-result carousel, which is scoped to
 * real-world attendable events and wouldn't apply to a release date either
 * way.
 */
function eventToSchemaEvent(params: {
  name: string;
  event: DatedEvent & { id: string; status: EventStatusLike };
  url: string;
  imageUrl: string | null;
}): object | null {
  const span = spanFor(params.event);
  if (!span) return null;
  return {
    "@type": "Event" as const,
    name: params.name,
    startDate: isoDate(span.start),
    // span.end is exclusive (see spanFor's comment); Event's endDate isn't.
    endDate: isoDate(new Date(span.end.getTime() - 1)),
    eventStatus:
      params.event.status === "CANCELLED" ? "https://schema.org/EventCancelled" : "https://schema.org/EventScheduled",
    eventAttendanceMode: "https://schema.org/OnlineEventAttendanceMode",
    location: {
      "@type": "VirtualLocation" as const,
      url: params.url,
    },
    ...(params.imageUrl ? { image: [params.imageUrl] } : {}),
  };
}

/** schema.org Event entries for whatever's currently in view on /calendar. Each one's location points at this event's own detail page when its ProductSet has a slug, falling back to the drawer deep link otherwise (most pre-slug/placeholder sets, today). */
export function buildEventJsonLd(events: CalendarEvent[]): object | null {
  const items = events
    .map((event) =>
      eventToSchemaEvent({
        name: `${event.productSet.install.package.name} - ${eventTitle(event)}`,
        event,
        url: event.productSet.slug
          ? `${SITE_URL}/calendar/${event.productSet.install.package.slug}/${event.productSet.slug}`
          : `${SITE_URL}/calendar?eventId=${event.id}`,
        imageUrl: event.productSet.imageUrl,
      }),
    )
    .filter((item): item is NonNullable<typeof item> => item !== null);

  if (items.length === 0) return null;

  return {
    "@context": "https://schema.org",
    "@type": "ItemList",
    itemListElement: items.map((item, i) => ({ "@type": "ListItem", position: i + 1, item })),
  };
}

type ProductSetEventLike = DatedEvent & { id: string; status: EventStatusLike; type: string };

/**
 * schema.org Event entries for a single ProductSet's own detail page --
 * one per release-event row (shelf, prerelease, regional variant, ...),
 * all pointed at the same detailUrl (this page). `imageUrl` must already
 * be viewer-gated (app/calendar/eventDisplay.ts's gateProductSetForViewer)
 * before it reaches here -- this function doesn't gate anything itself.
 */
export function buildProductSetJsonLd(params: {
  setName: string;
  gameName: string;
  events: ProductSetEventLike[];
  detailUrl: string;
  imageUrl: string | null;
}): object | null {
  const items = params.events
    .map((event) =>
      eventToSchemaEvent({
        name: `${params.gameName} - ${params.setName}${event.type !== "SHELF" ? ` (${event.type.toLowerCase()})` : ""}`,
        event,
        url: params.detailUrl,
        imageUrl: params.imageUrl,
      }),
    )
    .filter((item): item is NonNullable<typeof item> => item !== null);

  if (items.length === 0) return null;
  if (items.length === 1) return { "@context": "https://schema.org", ...items[0] };

  return {
    "@context": "https://schema.org",
    "@type": "ItemList",
    itemListElement: items.map((item, i) => ({ "@type": "ListItem", position: i + 1, item })),
  };
}

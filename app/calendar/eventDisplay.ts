import type { CalendarEvent } from "@/data/calendar/calendarRepo";

/**
 * ProductSet.imageUrl is premium-only (see EventDrawer). Any CalendarEvent[]
 * a server component is about to hand to a client component -- or a server
 * action is about to return -- must go through this first: even when
 * nothing in a list view renders the image, it would otherwise still reach
 * a non-premium browser as part of that component's serialized props/wire
 * payload, one Network-tab inspection away from anyone. See
 * app/calendar/actions.ts's getEventDetail for the single-event version of
 * this same gate (that one also needs a `hasMarketingImage` flag so the
 * detail view can still show a locked/upsell state; list views never
 * render an image at all, so a plain null-out is enough here).
 */
export function stripPremiumImageUrls(events: CalendarEvent[], isPremium: boolean): CalendarEvent[] {
  if (isPremium) return events;
  return events.map((event) =>
    event.productSet.imageUrl === null ? event : { ...event, productSet: { ...event.productSet, imageUrl: null } },
  );
}

/**
 * ProductSet.description is free once signed in, but still not for anonymous
 * visitors -- same wire-payload reasoning as stripPremiumImageUrls above:
 * list views don't render it today, but leaving it in the serialized props
 * would make it one Network-tab inspection away regardless.
 */
export function stripDescriptionForAnonymous(events: CalendarEvent[], isLoggedIn: boolean): CalendarEvent[] {
  if (isLoggedIn) return events;
  return events.map((event) =>
    event.productSet.description === null
      ? event
      : { ...event, productSet: { ...event.productSet, description: null } },
  );
}

// Cached per timeZone (including the "browser/server default" case, keyed
// under undefined) since Intl.DateTimeFormat construction isn't free and
// these render inside list/grid loops.
const dateFormatters = new Map<string | undefined, Intl.DateTimeFormat>();
const monthFormatters = new Map<string | undefined, Intl.DateTimeFormat>();

function dateFormatterFor(timeZone: string | undefined): Intl.DateTimeFormat {
  let formatter = dateFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone });
    dateFormatters.set(timeZone, formatter);
  }
  return formatter;
}

function monthFormatterFor(timeZone: string | undefined): Intl.DateTimeFormat {
  let formatter = monthFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone });
    monthFormatters.set(timeZone, formatter);
  }
  return formatter;
}

/**
 * `timeZone` is the user's profile override (an IANA zone name); omit it to
 * fall back to the runtime's own local zone, same as before this was
 * configurable.
 */
export function formatEventDate(event: CalendarEvent, timeZone?: string): string {
  const dateFormatter = dateFormatterFor(timeZone);
  const monthFormatter = monthFormatterFor(timeZone);
  switch (event.dateType) {
    case "EXACT":
      return event.dateExact ? dateFormatter.format(event.dateExact) : "Date unconfirmed";
    case "RANGE":
      return event.dateStart && event.dateEnd
        ? `${dateFormatter.format(event.dateStart)} – ${dateFormatter.format(event.dateEnd)}`
        : "Date unconfirmed";
    case "WINDOW":
      return event.windowStart ? monthFormatter.format(event.windowStart) : "Date unconfirmed";
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

/**
 * Fixed emoji reaction set for the free-tier "hype" feature (item 32) --
 * deliberately a closed list (not free-text emoji) so counts stay
 * meaningful and there's nothing for the server action's zod schema to
 * sanitize beyond membership. Shared between the client component and
 * app/calendar/actions.ts's validation so both sides can't drift.
 */
export const REACTION_EMOJIS = [
  { emoji: "\u{1F525}", label: "Hype" },
  { emoji: "\u{1F60D}", label: "Want it" },
  { emoji: "\u{1F440}", label: "Watching" },
  { emoji: "\u{1F614}", label: "Meh" },
  { emoji: "\u{1F644}", label: "Skip" },
] as const;

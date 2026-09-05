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

// dateExact/dateStart/dateEnd/windowStart/windowEnd are calendar days, not
// real instants -- lib/crawler/dateParsing.ts always builds them as
// Date.UTC(year, month, day) at midnight, deliberately, since "release day
// is March 15" has no time-of-day component to begin with. Formatting them
// through a viewer's IANA timeZone (as this used to, via a per-user profile
// override) reinterprets that UTC midnight as a real instant and rolls it
// back to the previous day/month for anyone behind UTC -- e.g. a WINDOW
// stored as 2026-01-01T00:00:00Z rendered as "December 2025" for an
// America/New_York viewer. Always formatting in UTC reads back exactly the
// calendar day these fields were built from, for every viewer alike.
const DATE_FORMATTER = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const MONTH_FORMATTER = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

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

/**
 * Short label for a non-global release region, or null for a global one.
 *
 * Null for GLOBAL deliberately, and the null is the feature. Most events on the
 * calendar are global, so a "GLOBAL" pill on every card would be a column of
 * identical noise that teaches a reader to stop looking at that corner of the
 * card -- which is precisely where a "JP" needs to be noticed. A region badge
 * only ever means "this date is not the one that applies to you unless you are
 * there", so it only ever appears when that is true.
 *
 * Region became a real distinction in the v2 ingest pipeline's phase 4, where it
 * joined (productSet, type) as part of the event key: a Japanese street date and
 * a global one for the same product are now two events rather than one
 * self-contradicting one, so for the first time there are events on the calendar
 * whose date genuinely does not apply everywhere.
 */
const REGION_LABELS: Record<CalendarEvent["region"], string | null> = {
  GLOBAL: null,
  NA: "NA",
  EU: "EU",
  APAC: "APAC",
  JP: "JP",
  OTHER: "Regional",
};

export function regionBadgeLabel(region: CalendarEvent["region"]): string | null {
  return REGION_LABELS[region];
}

/** The long form, for the badge's `title`/tooltip -- the short code alone is not self-explanatory. */
const REGION_TITLES: Record<CalendarEvent["region"], string> = {
  GLOBAL: "Global release date",
  NA: "North America release date",
  EU: "Europe release date",
  APAC: "Asia-Pacific release date",
  JP: "Japan release date",
  OTHER: "Region-specific release date",
};

export function regionBadgeTitle(region: CalendarEvent["region"]): string {
  return REGION_TITLES[region];
}

/**
 * The neutral pill the "Range" marker already uses.
 *
 * Shared rather than restated so the two read as one family, and deliberately
 * not colour-coded per region: the label carries the meaning (a screen reader
 * and a monochrome display both get "JP"), and colour here would compete with
 * the status badge, which is the one badge on the card whose colour is load
 * bearing.
 */
export const NEUTRAL_BADGE_CLASS =
  "shrink-0 rounded bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600 dark:bg-gray-800 dark:text-gray-300";

// Solid (not pale) colors -- these back a ~6px dot in the mobile month grid,
// where STATUS_STYLES' pastel badge backgrounds would be too faint to read.
const STATUS_DOT_STYLES: Record<CalendarEvent["status"], string> = {
  RUMORED: "bg-gray-400 dark:bg-gray-500",
  ANNOUNCED: "bg-blue-500",
  CONFIRMED: "bg-green-500",
  RELEASED: "bg-purple-500",
  CANCELLED: "bg-red-500",
};

export function statusDotClass(status: CalendarEvent["status"]): string {
  return STATUS_DOT_STYLES[status];
}

/**
 * Fixed emoji reaction set for the free-tier "hype" feature (item 32) --
 * deliberately a closed list (not free-text emoji) so counts stay
 * meaningful and there's nothing for the server action's zod schema to
 * sanitize beyond membership. Shared between the client component and
 * app/calendar/actions.ts's validation so both sides can't drift.
 */
export const REACTION_EMOJIS = [
  { emoji: "\u{1F525}", label: "Hype", sentiment: "positive" },
  { emoji: "\u{1F60D}", label: "Want it", sentiment: "positive" },
  { emoji: "\u{1F440}", label: "Watching", sentiment: "neutral" },
  { emoji: "\u{1F614}", label: "Meh", sentiment: "negative" },
  { emoji: "\u{1F644}", label: "Skip", sentiment: "negative" },
] as const;

export type ReactionCounts = Record<string, number>;

/** Highest-count emoji first, capped at `limit` -- for a compact badge on a card/list row/grid cell, as opposed to EventReactions' full interactive picker. */
export function topReactions(counts: ReactionCounts | undefined, limit = 2): { emoji: string; count: number }[] {
  if (!counts) return [];
  return Object.entries(counts)
    .map(([emoji, count]) => ({ emoji, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

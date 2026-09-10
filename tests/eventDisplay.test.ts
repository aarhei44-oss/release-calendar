import { describe, expect, it } from "vitest";
import {
  NEUTRAL_BADGE_CLASS,
  formatEventDate,
  formatRelativeTime,
  groupSourceClaims,
  regionBadgeLabel,
  regionBadgeTitle,
  sourceLabel,
  topReactions,
  typeBadgeLabel,
  type GroupableClaim,
} from "@/app/calendar/eventDisplay";
import type { CalendarEvent } from "@/data/calendar/calendarRepo";

function fakeDateFields(overrides: Partial<CalendarEvent>): CalendarEvent {
  return {
    dateType: "EXACT",
    dateExact: null,
    dateStart: null,
    dateEnd: null,
    windowGranularity: null,
    windowStart: null,
    windowEnd: null,
    ...overrides,
  } as CalendarEvent;
}

describe("formatEventDate", () => {
  // Regression test: dateExact/dateStart/dateEnd/windowStart/windowEnd are
  // always built as UTC midnight (see lib/ingest/dateParsing.ts) since
  // they're calendar days, not real instants. formatEventDate used to
  // reinterpret them through a viewer's IANA profile timezone, which rolled
  // a UTC-midnight date back to the previous day/month for anyone behind
  // UTC -- e.g. a WINDOW starting 2026-01-01T00:00:00Z showed as "December
  // 2025". It must always read back in UTC regardless of the environment's
  // local timezone.
  it("formats a YEAR window as just the year, not a false month/year", () => {
    const event = fakeDateFields({
      dateType: "WINDOW",
      windowGranularity: "YEAR",
      windowStart: new Date("2026-01-01T00:00:00.000Z"),
      windowEnd: new Date("2026-12-31T00:00:00.000Z"),
    });
    expect(formatEventDate(event)).toBe("2026");
  });

  // Regression test: a QUARTER window used to format through the same
  // month/year formatter as an exact month, so a Q4 2026 window (Oct-Dec)
  // silently truncated down to "October 2026" -- indistinguishable from a
  // genuinely narrowed-down single month, and confusing next to a SHELF
  // event for the same product that really does land in October.
  it("formats a QUARTER window as its quarter, not its start month", () => {
    const event = fakeDateFields({
      dateType: "WINDOW",
      windowGranularity: "QUARTER",
      windowStart: new Date("2026-10-01T00:00:00.000Z"),
      windowEnd: new Date("2026-12-31T00:00:00.000Z"),
    });
    expect(formatEventDate(event)).toBe("Q4 2026");
  });

  it("formats a MONTH window as its month/year", () => {
    const event = fakeDateFields({
      dateType: "WINDOW",
      windowGranularity: "MONTH",
      windowStart: new Date("2026-01-01T00:00:00.000Z"),
      windowEnd: new Date("2026-01-31T00:00:00.000Z"),
    });
    expect(formatEventDate(event)).toBe("January 2026");
  });

  it("formats an EXACT UTC-midnight date as its own day, not the previous day", () => {
    const event = fakeDateFields({ dateType: "EXACT", dateExact: new Date("2026-03-01T00:00:00.000Z") });
    expect(formatEventDate(event)).toBe("Mar 1, 2026");
  });

  it("formats a RANGE using both UTC-midnight endpoints", () => {
    const event = fakeDateFields({
      dateType: "RANGE",
      dateStart: new Date("2026-03-01T00:00:00.000Z"),
      dateEnd: new Date("2026-03-10T00:00:00.000Z"),
    });
    expect(formatEventDate(event)).toBe("Mar 1, 2026 – Mar 10, 2026");
  });

  it("shows 'Date unconfirmed' for TBD", () => {
    expect(formatEventDate(fakeDateFields({ dateType: "TBD" }))).toBe("Date unconfirmed");
  });
});

describe("formatRelativeTime", () => {
  it("formats a few days ago", () => {
    expect(formatRelativeTime(new Date(Date.now() - 3 * 24 * 60 * 60 * 1000))).toBe("3 days ago");
  });

  it("formats a few hours ago", () => {
    expect(formatRelativeTime(new Date(Date.now() - 2 * 60 * 60 * 1000))).toBe("2 hours ago");
  });

  it("formats a few minutes ago", () => {
    expect(formatRelativeTime(new Date(Date.now() - 5 * 60 * 1000))).toBe("5 minutes ago");
  });

  it("formats a moment just now", () => {
    expect(formatRelativeTime(new Date())).toBe("this minute");
  });

  it("formats a future time", () => {
    expect(formatRelativeTime(new Date(Date.now() + 2 * 24 * 60 * 60 * 1000))).toBe("in 2 days");
  });
});

describe("regionBadgeLabel", () => {
  // The event card renders the badge only when this returns a label, so "no
  // label for GLOBAL" is the whole rule: most releases are global, and a
  // "GLOBAL" pill on every card is a column of identical noise that trains a
  // reader to ignore exactly the corner where a "JP" has to be noticed.
  it("returns nothing for a global release", () => {
    expect(regionBadgeLabel("GLOBAL")).toBeNull();
  });

  it("labels every region that is not global", () => {
    expect(regionBadgeLabel("JP")).toBe("JP");
    expect(regionBadgeLabel("NA")).toBe("NA");
    expect(regionBadgeLabel("EU")).toBe("EU");
    expect(regionBadgeLabel("APAC")).toBe("APAC");
    // OTHER has no meaningful abbreviation, so it says what it means.
    expect(regionBadgeLabel("OTHER")).toBe("Regional");
  });

  it("carries the meaning in text, never in colour alone", () => {
    // The badge is rendered with the same neutral pill the "Range" marker uses
    // and is not colour-coded per region: a screen reader, a monochrome display
    // and a colour-blind reader all get the same information, and the one badge
    // on the card whose colour *is* load-bearing (status) keeps that job to
    // itself.
    for (const region of ["JP", "NA", "EU", "APAC", "OTHER"] as const) {
      const label = regionBadgeLabel(region);
      expect(label, region).toBeTruthy();
      expect(label?.trim().length).toBeGreaterThan(0);
      // ...and a tooltip that spells the short code out.
      expect(regionBadgeTitle(region)).toMatch(/release date$/);
    }
    expect(NEUTRAL_BADGE_CLASS).not.toMatch(/red|green|blue|amber|purple/);
  });
});

describe("typeBadgeLabel", () => {
  // Same "no label for the common case" shape as regionBadgeLabel: SHELF is
  // almost every event, so it stays silent, and PRERELEASE/PROMO/SPECIAL only
  // speak up when a card needs to be told apart from a sibling event for the
  // same product (e.g. a set's own PRERELEASE and SHELF cards, previously
  // indistinguishable without opening the drawer).
  it("returns nothing for SHELF", () => {
    expect(typeBadgeLabel("SHELF")).toBeNull();
  });

  it("labels every non-SHELF type", () => {
    expect(typeBadgeLabel("PRERELEASE")).toBe("Prerelease");
    expect(typeBadgeLabel("PROMO")).toBe("Promo");
    expect(typeBadgeLabel("SPECIAL")).toBe("Special");
  });
});

describe("topReactions", () => {
  it("returns an empty array for undefined counts", () => {
    expect(topReactions(undefined)).toEqual([]);
  });

  it("sorts by count descending and caps at the limit", () => {
    const counts = { "\u{1F525}": 2, "\u{1F60D}": 5, "\u{1F614}": 1 };
    expect(topReactions(counts, 2)).toEqual([
      { emoji: "\u{1F60D}", count: 5 },
      { emoji: "\u{1F525}", count: 2 },
    ]);
  });

  it("defaults to a limit of 2", () => {
    const counts = { "\u{1F525}": 1, "\u{1F60D}": 1, "\u{1F614}": 1 };
    expect(topReactions(counts)).toHaveLength(2);
  });
});

describe("groupSourceClaims", () => {
  function claim(overrides: Partial<GroupableClaim>): GroupableClaim {
    return {
      id: "c1",
      origin: "scryfall",
      host: "api.scryfall.com",
      url: "https://api.scryfall.com/sets/abc",
      tier: "COMMUNITY",
      disposition: "SUPPORTS",
      lastVerifiedAt: new Date("2026-01-01T03:00:00.000Z"),
      createdAt: new Date("2026-01-01T03:00:00.000Z"),
      ...overrides,
    };
  }

  // The bug this exists for: SourceClaim is keyed on (scanRunId, origin,
  // releaseEventId), so a nightly scan writes a fresh row for the same source
  // saying the same thing every day. The drawer listed each of those as its
  // own source, so a long-tracked event grew a row a day forever.
  it("collapses one origin's nightly rows into a single row counting the days", () => {
    const claims = [1, 2, 3, 4].map((day) =>
      claim({
        id: `run-${day}`,
        lastVerifiedAt: new Date(`2026-01-0${day}T03:00:00.000Z`),
      }),
    );

    const grouped = groupSourceClaims(claims);
    expect(grouped).toHaveLength(1);
    expect(grouped[0].days).toBe(4);
    expect(grouped[0].firstSeenAt).toEqual(new Date("2026-01-01T03:00:00.000Z"));
    expect(grouped[0].lastVerifiedAt).toEqual(new Date("2026-01-04T03:00:00.000Z"));
  });

  // Two scans on one day are the same day of the same source saying the same
  // thing -- counting rows would let a busy day masquerade as a longer
  // standing claim.
  it("counts distinct days, not rows", () => {
    const grouped = groupSourceClaims([
      claim({ id: "morning", lastVerifiedAt: new Date("2026-01-01T03:00:00.000Z") }),
      claim({ id: "afternoon", lastVerifiedAt: new Date("2026-01-01T18:00:00.000Z") }),
    ]);
    expect(grouped).toHaveLength(1);
    expect(grouped[0].days).toBe(1);
  });

  // Grouping is by declared origin, not by where the row was fetched: one
  // origin paginating across URLs (or moving host) is still one source, which
  // is the same distinction gate rule G2 turns on.
  it("groups by origin even when the url differs between runs", () => {
    const grouped = groupSourceClaims([
      claim({ id: "a", url: "https://api.scryfall.com/sets/abc?page=1" }),
      claim({ id: "b", url: "https://api.scryfall.com/sets/abc?page=2" }),
    ]);
    expect(grouped).toHaveLength(1);
  });

  it("keeps genuinely separate origins separate", () => {
    const grouped = groupSourceClaims([
      claim({ id: "a", origin: "scryfall" }),
      claim({ id: "b", origin: "wizards-official", host: "magic.wizards.com", tier: "OFFICIAL" }),
    ]);
    expect(grouped).toHaveLength(2);
  });

  // v1 crawler rows predate the origin column entirely; falling back to host
  // keeps them one row per site instead of collapsing every legacy claim into
  // a single anonymous blob.
  it("falls back to host for rows with no origin", () => {
    const grouped = groupSourceClaims([
      claim({ id: "a", origin: null, host: "example.com" }),
      claim({ id: "b", origin: null, host: "example.com" }),
      claim({ id: "c", origin: null, host: "other.com" }),
    ]);
    expect(grouped).toHaveLength(2);
  });

  // A source that changed its mind should be shown holding its current
  // position, not the one it has since abandoned.
  it("reports the most recent row's tier, disposition and url", () => {
    const grouped = groupSourceClaims([
      claim({
        id: "old",
        disposition: "SUPPORTS",
        url: "https://api.scryfall.com/old",
        lastVerifiedAt: new Date("2026-01-01T03:00:00.000Z"),
      }),
      claim({
        id: "new",
        disposition: "CONTRADICTS",
        url: "https://api.scryfall.com/new",
        lastVerifiedAt: new Date("2026-01-05T03:00:00.000Z"),
      }),
    ]);
    expect(grouped[0].id).toBe("new");
    expect(grouped[0].disposition).toBe("CONTRADICTS");
    expect(grouped[0].url).toBe("https://api.scryfall.com/new");
  });

  it("orders the most recently confirmed source first", () => {
    const grouped = groupSourceClaims([
      claim({ id: "stale", origin: "wikipedia", lastVerifiedAt: new Date("2026-01-01T03:00:00.000Z") }),
      claim({ id: "fresh", origin: "scryfall", lastVerifiedAt: new Date("2026-02-01T03:00:00.000Z") }),
    ]);
    expect(grouped.map((g) => g.origin)).toEqual(["scryfall", "wikipedia"]);
  });

  // v1 rows can have a null lastVerifiedAt; createdAt is when that row was
  // written, so it's the day the source was observed saying this.
  it("falls back to createdAt when a row was never explicitly verified", () => {
    const grouped = groupSourceClaims([
      claim({ id: "a", lastVerifiedAt: null, createdAt: new Date("2026-03-01T00:00:00.000Z") }),
    ]);
    expect(grouped[0].days).toBe(1);
    expect(grouped[0].lastVerifiedAt).toEqual(new Date("2026-03-01T00:00:00.000Z"));
  });

  it("returns nothing for an event with no claims", () => {
    expect(groupSourceClaims([])).toEqual([]);
  });
});

describe("sourceLabel", () => {
  it("spells a hyphenated origin key out in title case", () => {
    const [grouped] = groupSourceClaims([
      {
        id: "a",
        origin: "wizards-official",
        host: "magic.wizards.com",
        url: "https://magic.wizards.com/sets",
        tier: "OFFICIAL",
        disposition: "SUPPORTS",
        lastVerifiedAt: new Date("2026-01-01T00:00:00.000Z"),
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    ]);
    expect(sourceLabel(grouped)).toBe("Wizards Official");
  });

  it("names an origin-less v1 row by its host", () => {
    const [grouped] = groupSourceClaims([
      {
        id: "a",
        origin: null,
        host: "example.com",
        url: "https://example.com/announcement",
        tier: "COMMUNITY",
        disposition: "SUPPORTS",
        lastVerifiedAt: null,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    ]);
    expect(sourceLabel(grouped)).toBe("example.com");
  });
});

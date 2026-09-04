import { describe, expect, it } from "vitest";
import { formatEventDate, formatRelativeTime, topReactions } from "@/app/calendar/eventDisplay";
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
  // always built as UTC midnight (see lib/crawler/dateParsing.ts) since
  // they're calendar days, not real instants. formatEventDate used to
  // reinterpret them through a viewer's IANA profile timezone, which rolled
  // a UTC-midnight date back to the previous day/month for anyone behind
  // UTC -- e.g. a WINDOW starting 2026-01-01T00:00:00Z showed as "December
  // 2025". It must always read back in UTC regardless of the environment's
  // local timezone.
  it("formats a WINDOW's year-start date as its own month/year, not the previous one", () => {
    const event = fakeDateFields({
      dateType: "WINDOW",
      windowGranularity: "YEAR",
      windowStart: new Date("2026-01-01T00:00:00.000Z"),
      windowEnd: new Date("2026-12-31T00:00:00.000Z"),
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

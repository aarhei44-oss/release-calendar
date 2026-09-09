import { describe, expect, it } from "vitest";
import { mapEventsForGrid } from "@/app/calendar/mapEvents";
import type { CalendarEvent } from "@/data/calendar/calendarRepo";

function fakeEvent(overrides: Partial<CalendarEvent>): CalendarEvent {
  return {
    id: "evt-1",
    productSetId: "set-1",
    type: "SHELF",
    dateType: "EXACT",
    dateExact: null,
    dateStart: null,
    dateEnd: null,
    windowGranularity: null,
    windowStart: null,
    windowEnd: null,
    region: "GLOBAL",
    status: "ANNOUNCED",
    confidence: 0.5,
    sourceSummary: null,
    lastSeenAt: null,
    isManualOverride: false,
    manualNotes: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    productSet: {
      id: "set-1",
      tcgProfileInstallId: "install-1",
      code: "CODE-1",
      name: "Test Set",
      meta: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      install: {
        id: "install-1",
        packageId: "pkg-1",
        installedVersion: "1.0.0",
        enabled: true,
        settings: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        package: {
          id: "pkg-1",
          slug: "test-pkg",
          name: "Test Package",
          version: "1.0.0",
          description: null,
          discoveryConfig: {},
          sourceConfigs: {},
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      },
    },
    ...overrides,
  } as CalendarEvent;
}

describe("mapEventsForGrid", () => {
  it("excludes TBD events from the calendar grid", () => {
    const events = [fakeEvent({ id: "tbd-1", dateType: "TBD" })];
    expect(mapEventsForGrid(events)).toHaveLength(0);
  });

  it("places an EXACT event as a single-day span", () => {
    const day = new Date("2026-03-15");
    const events = [fakeEvent({ id: "exact-1", dateType: "EXACT", dateExact: day })];
    const [mapped] = mapEventsForGrid(events);
    expect(mapped.start).toEqual(day);
    expect(mapped.end).toEqual(day);
  });

  it("excludes RANGE events from the calendar grid", () => {
    const events = [
      fakeEvent({
        id: "range-1",
        dateType: "RANGE",
        dateStart: new Date("2026-03-01"),
        dateEnd: new Date("2026-03-10"),
      }),
    ];
    expect(mapEventsForGrid(events)).toHaveLength(0);
  });

  it("excludes WINDOW events from the calendar grid", () => {
    const events = [
      fakeEvent({
        id: "window-1",
        dateType: "WINDOW",
        windowGranularity: "QUARTER",
        windowStart: new Date("2026-04-01"),
        windowEnd: new Date("2026-06-30"),
      }),
    ];
    expect(mapEventsForGrid(events)).toHaveLength(0);
  });

  it("falls back to the product set code when name is missing", () => {
    const events = [
      fakeEvent({
        id: "no-name",
        dateType: "EXACT",
        dateExact: new Date("2026-03-15"),
        productSet: { ...fakeEvent({}).productSet, name: null, code: "CODE-42" },
      }),
    ];
    const [mapped] = mapEventsForGrid(events);
    expect(mapped.title).toBe("CODE-42");
  });

  it("skips a non-TBD event that is missing its date fields rather than throwing", () => {
    const events = [fakeEvent({ id: "broken", dateType: "EXACT", dateExact: null })];
    expect(mapEventsForGrid(events)).toHaveLength(0);
  });
});

/**
 * A pill is the only place an event appears with no badges beside it, so
 * anything the list views say with a chip has to be said in the title here or
 * not at all.
 */
describe("gridPillTitle", () => {
  function pillFor(overrides: Partial<CalendarEvent>): string {
    const [mapped] = mapEventsForGrid([
      fakeEvent({ dateType: "EXACT", dateExact: new Date("2026-03-15"), ...overrides }),
    ]);
    return mapped.title;
  }

  it("marks a prerelease", () => {
    // Without this, a set's prerelease weekend and its street date are two
    // pills a week apart reading identically.
    expect(pillFor({ type: "PRERELEASE" })).toBe("Test Set — Pre-release");
  });

  it("leaves a shelf date unmarked", () => {
    // Labelling the common case is how a reader learns to stop reading it.
    expect(pillFor({ type: "SHELF" })).toBe("Test Set");
  });

  it("marks the other non-shelf types too", () => {
    expect(pillFor({ type: "PROMO" })).toBe("Test Set");
  });
});

describe("eventTitle: Union Arena product types", () => {
  function titleFor(code: string, name: string): string {
    const [mapped] = mapEventsForGrid([
      fakeEvent({
        dateType: "EXACT",
        dateExact: new Date("2026-09-18"),
        productSet: { ...fakeEvent({}).productSet, code, name },
      }),
    ]);
    return mapped.title;
  }

  it("tells a Union Arena booster from its starter deck", () => {
    // Bandai publishes both under the identical franchise title, on the same
    // day; the last two letters of the code are the only difference there is.
    const franchise = "Re:ZERO -Starting Life in Another World-";
    expect(titleFor("UE24BT", franchise)).toBe(`${franchise} (Booster)`);
    expect(titleFor("UE24ST", franchise)).toBe(`${franchise} (Starter Deck)`);
  });

  it("stays quiet when the name already says it", () => {
    expect(titleFor("UE10DC", "Bleach: Thousand Year Blood War Advanced Deck")).toBe(
      "Bleach: Thousand Year Blood War Advanced Deck",
    );
  });

  it("leaves every other game's codes alone", () => {
    expect(titleFor("ST-31", "STARTER DECK -RED Monkey.D.Luffy-")).toBe("STARTER DECK -RED Monkey.D.Luffy-");
    expect(titleFor("HOB", "The Hobbit")).toBe("The Hobbit");
    expect(titleFor("GD05", "Freedom Ascension")).toBe("Freedom Ascension");
  });
});

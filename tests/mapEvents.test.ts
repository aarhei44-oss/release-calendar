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
      releaseQuarter: null,
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

  it("places a RANGE event spanning dateStart to dateEnd", () => {
    const start = new Date("2026-03-01");
    const end = new Date("2026-03-10");
    const events = [fakeEvent({ id: "range-1", dateType: "RANGE", dateStart: start, dateEnd: end })];
    const [mapped] = mapEventsForGrid(events);
    expect(mapped.start).toEqual(start);
    expect(mapped.end).toEqual(end);
  });

  it("places a WINDOW event spanning windowStart to windowEnd", () => {
    const start = new Date("2026-04-01");
    const end = new Date("2026-06-30");
    const events = [
      fakeEvent({ id: "window-1", dateType: "WINDOW", windowGranularity: "QUARTER", windowStart: start, windowEnd: end }),
    ];
    const [mapped] = mapEventsForGrid(events);
    expect(mapped.start).toEqual(start);
    expect(mapped.end).toEqual(end);
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

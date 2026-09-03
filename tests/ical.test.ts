import { describe, expect, it } from "vitest";
import { buildIcsFeed } from "@/lib/ical";
import type { CalendarEvent } from "@/data/calendar/calendarRepo";

function fakeEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: "evt-1",
    productSetId: "set-1",
    type: "SHELF",
    dateType: "EXACT",
    dateExact: new Date(2026, 2, 15), // local midnight, avoids UTC-boundary flakiness
    dateStart: null,
    dateEnd: null,
    windowGranularity: null,
    windowStart: null,
    windowEnd: null,
    region: "GLOBAL",
    status: "CONFIRMED",
    confidence: 0.8,
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
      name: "Foundations",
      releaseQuarter: null,
      meta: null,
      imageUrl: null,
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
          slug: "mtg",
          name: "Magic: The Gathering",
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

describe("buildIcsFeed", () => {
  it("produces a valid VCALENDAR wrapper", () => {
    const ics = buildIcsFeed([]);
    expect(ics).toMatch(/^BEGIN:VCALENDAR\r\n/);
    expect(ics).toMatch(/END:VCALENDAR\r\n$/);
    expect(ics).toContain("VERSION:2.0");
  });

  it("emits one VEVENT per EXACT event with DTEND one day after DTSTART (exclusive all-day span)", () => {
    const ics = buildIcsFeed([fakeEvent({ dateType: "EXACT", dateExact: new Date(2026, 2, 15) })]);
    expect(ics).toContain("DTSTART;VALUE=DATE:20260315");
    expect(ics).toContain("DTEND;VALUE=DATE:20260316");
  });

  it("spans DTSTART/DTEND across a RANGE event's start and end+1", () => {
    const ics = buildIcsFeed([
      fakeEvent({ dateType: "RANGE", dateStart: new Date(2026, 2, 1), dateEnd: new Date(2026, 2, 10) }),
    ]);
    expect(ics).toContain("DTSTART;VALUE=DATE:20260301");
    expect(ics).toContain("DTEND;VALUE=DATE:20260311");
  });

  it("spans DTSTART/DTEND across a WINDOW event's start and end+1", () => {
    const ics = buildIcsFeed([
      fakeEvent({ dateType: "WINDOW", windowStart: new Date(2026, 3, 1), windowEnd: new Date(2026, 5, 30) }),
    ]);
    expect(ics).toContain("DTSTART;VALUE=DATE:20260401");
    expect(ics).toContain("DTEND;VALUE=DATE:20260701");
  });

  it("skips a TBD event (no date to export)", () => {
    const ics = buildIcsFeed([fakeEvent({ id: "tbd-1", dateType: "TBD" })]);
    expect(ics).not.toContain("BEGIN:VEVENT");
  });

  it("includes the game name and set name in SUMMARY", () => {
    const ics = buildIcsFeed([fakeEvent()]);
    expect(ics).toContain("SUMMARY:Magic: The Gathering - Foundations");
  });

  it("escapes commas, semicolons, and backslashes in SUMMARY per RFC 5545", () => {
    const ics = buildIcsFeed([
      fakeEvent({
        productSet: {
          ...fakeEvent().productSet,
          name: "Foundations, Set; Two\\Special",
        },
      }),
    ]);
    expect(ics).toContain("Foundations\\, Set\\; Two\\\\Special");
  });

  it("gives each event a unique UID derived from its id", () => {
    const ics = buildIcsFeed([fakeEvent({ id: "evt-abc" })]);
    expect(ics).toContain("UID:evt-abc@releasewatcher.com");
  });

  it("marks a CANCELLED event's STATUS as CANCELLED, everything else as CONFIRMED", () => {
    const cancelled = buildIcsFeed([fakeEvent({ status: "CANCELLED" })]);
    expect(cancelled).toContain("STATUS:CANCELLED");

    const rumored = buildIcsFeed([fakeEvent({ status: "RUMORED" })]);
    expect(rumored).toContain("STATUS:CONFIRMED");
  });
});

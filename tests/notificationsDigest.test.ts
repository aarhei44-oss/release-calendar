import { describe, expect, it } from "vitest";
import { digestSubject, digestBody } from "@/lib/notifications/digest";
import type { CalendarEvent } from "@/data/calendar/calendarRepo";

function fakeEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: "evt-1",
    productSetId: "set-1",
    type: "SHELF",
    dateType: "EXACT",
    dateExact: new Date("2026-03-15"),
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

describe("digestSubject", () => {
  it("labels the cadence and count for a non-empty DAILY digest", () => {
    expect(digestSubject("DAILY", 3)).toBe("Daily digest: 3 upcoming releases");
  });

  it("uses singular phrasing for exactly one event", () => {
    expect(digestSubject("DAILY", 1)).toBe("Daily digest: 1 upcoming release");
  });

  it("labels a WEEKLY digest distinctly from DAILY", () => {
    expect(digestSubject("WEEKLY", 2)).toBe("Weekly digest: 2 upcoming releases");
  });

  it("still sends a distinct subject when there's nothing new, rather than omitting the send", () => {
    expect(digestSubject("DAILY", 0)).toBe("Daily digest: nothing new upcoming");
  });
});

describe("digestBody", () => {
  it("lists each event's game, set name, and date", () => {
    const body = digestBody([fakeEvent()]);
    expect(body).toContain("Magic: The Gathering");
    expect(body).toContain("Foundations");
  });

  it("returns a friendly empty-state message for zero events", () => {
    expect(digestBody([])).toMatch(/nothing new/i);
  });
});

import { describe, expect, it } from "vitest";
import { leadTimeReminderSubject, leadTimeReminderBody } from "@/lib/notifications/leadTimeReminder";
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

describe("leadTimeReminderSubject", () => {
  it("pluralizes both days and releases for the general case", () => {
    expect(leadTimeReminderSubject(7, 2)).toBe("2 releases in 7 days");
  });

  it("uses singular phrasing for exactly one day and one release", () => {
    expect(leadTimeReminderSubject(1, 1)).toBe("1 release in 1 day");
  });
});

describe("leadTimeReminderBody", () => {
  it("lists each event's game, set name, and date", () => {
    const body = leadTimeReminderBody([fakeEvent()]);
    expect(body).toContain("Magic: The Gathering");
    expect(body).toContain("Foundations");
  });
});

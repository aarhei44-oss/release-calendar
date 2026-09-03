import { describe, expect, it } from "vitest";
import { stripPremiumImageUrls } from "@/app/calendar/eventDisplay";
import type { CalendarEvent } from "@/data/calendar/calendarRepo";

function fakeEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: "evt-1",
    productSetId: "set-1",
    type: "SHELF",
    dateType: "TBD",
    dateExact: null,
    dateStart: null,
    dateEnd: null,
    windowGranularity: null,
    windowStart: null,
    windowEnd: null,
    region: "GLOBAL",
    status: "RUMORED",
    confidence: 0.1,
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
      imageUrl: "https://example.com/secret-marketing-image.png",
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

describe("stripPremiumImageUrls", () => {
  it("nulls out productSet.imageUrl for a non-premium caller", () => {
    const [result] = stripPremiumImageUrls([fakeEvent()], false);
    expect(result.productSet.imageUrl).toBeNull();
  });

  it("leaves productSet.imageUrl intact for a premium caller", () => {
    const [result] = stripPremiumImageUrls([fakeEvent()], true);
    expect(result.productSet.imageUrl).toBe("https://example.com/secret-marketing-image.png");
  });

  it("leaves an event with no image unchanged (same reference, no unnecessary copy)", () => {
    const event = fakeEvent({ productSet: { ...fakeEvent().productSet, imageUrl: null } });
    const [result] = stripPremiumImageUrls([event], false);
    expect(result).toBe(event);
  });

  it("does not mutate the input array or events", () => {
    const event = fakeEvent();
    const originalUrl = event.productSet.imageUrl;
    stripPremiumImageUrls([event], false);
    expect(event.productSet.imageUrl).toBe(originalUrl);
  });

  it("handles an empty list", () => {
    expect(stripPremiumImageUrls([], false)).toEqual([]);
  });
});

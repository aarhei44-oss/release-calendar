import { describe, expect, it } from "vitest";
import {
  googleCalendarEventUrl,
  outlookComEventUrl,
  office365EventUrl,
  googleCalendarSubscribeUrl,
  outlookComSubscribeUrl,
  office365SubscribeUrl,
} from "@/lib/calendarLinks";
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

describe("googleCalendarEventUrl", () => {
  it("builds a TEMPLATE link with an exclusive end date, matching the ICS DTEND convention", () => {
    const url = googleCalendarEventUrl(fakeEvent({ dateExact: new Date(2026, 2, 15) }));
    expect(url).toContain("https://calendar.google.com/calendar/render?");
    expect(url).toContain("action=TEMPLATE");
    expect(url).toContain("dates=20260315%2F20260316");
    expect(url).toContain("text=Magic%3A+The+Gathering+-+Foundations");
  });

  it("spans a RANGE event across start and end+1", () => {
    const url = googleCalendarEventUrl(
      fakeEvent({ dateType: "RANGE", dateStart: new Date(2026, 2, 1), dateEnd: new Date(2026, 2, 10) }),
    );
    expect(url).toContain("dates=20260301%2F20260311");
  });

  it("returns null for a TBD event with no date to place", () => {
    expect(googleCalendarEventUrl(fakeEvent({ dateType: "TBD" }))).toBeNull();
  });
});

describe("outlookComEventUrl / office365EventUrl", () => {
  it("uses an inclusive end date (one day back from the exclusive ICS span)", () => {
    const url = outlookComEventUrl(fakeEvent({ dateExact: new Date(2026, 2, 15) }));
    expect(url).toContain("https://outlook.live.com/calendar/0/deeplink/compose?");
    expect(url).toContain("startdt=2026-03-15");
    expect(url).toContain("enddt=2026-03-15");
    expect(url).toContain("allday=true");
  });

  it("spans a multi-day RANGE event inclusively", () => {
    const url = office365EventUrl(
      fakeEvent({ dateType: "RANGE", dateStart: new Date(2026, 2, 1), dateEnd: new Date(2026, 2, 10) }),
    );
    expect(url).toContain("https://outlook.office.com/calendar/0/deeplink/compose?");
    expect(url).toContain("startdt=2026-03-01");
    expect(url).toContain("enddt=2026-03-10");
  });

  it("returns null for a TBD event", () => {
    expect(outlookComEventUrl(fakeEvent({ dateType: "TBD" }))).toBeNull();
    expect(office365EventUrl(fakeEvent({ dateType: "TBD" }))).toBeNull();
  });
});

describe("subscribe deep links", () => {
  const feedUrl = "https://releasewatcher.com/api/ical/abc123/feed.ics";

  it("converts the feed URL to webcal:// for Google's cid param", () => {
    const url = googleCalendarSubscribeUrl(feedUrl);
    expect(url).toBe(
      "https://calendar.google.com/calendar/render?cid=webcal%3A%2F%2Freleasewatcher.com%2Fapi%2Fical%2Fabc123%2Ffeed.ics",
    );
  });

  it("builds outlook.live.com and outlook.office.com add-calendar links carrying the feed URL and name", () => {
    expect(outlookComSubscribeUrl(feedUrl, "Release Watcher")).toBe(
      "https://outlook.live.com/calendar/0/addcalendar?url=" +
        encodeURIComponent(feedUrl) +
        "&name=Release+Watcher",
    );
    expect(office365SubscribeUrl(feedUrl, "Release Watcher")).toContain("https://outlook.office.com/calendar/0/addcalendar?");
  });
});

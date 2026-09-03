import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { msUntilNextMidnight } from "@/lib/crawler/scheduler";

// The "reschedules" test below advances fake timers far enough to fire the
// scheduled callback, which calls runScan -- mocked so that doesn't touch
// the real database or attempt any network fetch.
vi.mock("@/lib/crawler/orchestrate", () => ({
  runScan: vi.fn().mockResolvedValue({ skipped: true, reason: "mocked in scheduler tests" }),
}));

describe("msUntilNextMidnight", () => {
  it("returns a full day when `now` is exactly local midnight (standard time, PST = UTC-8)", () => {
    expect(msUntilNextMidnight("America/Los_Angeles", new Date("2026-01-15T08:00:00.000Z"))).toBe(
      24 * 60 * 60 * 1000,
    );
  });

  it("returns a full day when `now` is exactly local midnight (daylight time, PDT = UTC-7)", () => {
    expect(msUntilNextMidnight("America/Los_Angeles", new Date("2026-07-15T07:00:00.000Z"))).toBe(
      24 * 60 * 60 * 1000,
    );
  });

  it("returns the remaining time until midnight when partway through the day", () => {
    // 2026-01-14T23:59:00 local (PST) -- one minute before midnight.
    expect(msUntilNextMidnight("America/Los_Angeles", new Date("2026-01-15T07:59:00.000Z"))).toBe(60 * 1000);
  });
});

describe("startCrawlerScheduler", () => {
  const originalSchedule = process.env.CRAWLER_SCHEDULE;

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
  });

  afterEach(() => {
    process.env.CRAWLER_SCHEDULE = originalSchedule;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does not schedule a run when CRAWLER_SCHEDULE is unset", async () => {
    delete process.env.CRAWLER_SCHEDULE;
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const { startCrawlerScheduler } = await import("@/lib/crawler/scheduler");

    startCrawlerScheduler();

    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });

  it("does not schedule a run when CRAWLER_SCHEDULE is 0", async () => {
    process.env.CRAWLER_SCHEDULE = "0";
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const { startCrawlerScheduler } = await import("@/lib/crawler/scheduler");

    startCrawlerScheduler();

    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });

  it("schedules the first run for the delay until the next local midnight in Los Angeles", async () => {
    vi.setSystemTime(new Date("2026-01-15T07:59:00.000Z")); // one minute before midnight PST
    process.env.CRAWLER_SCHEDULE = "1";
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const { startCrawlerScheduler } = await import("@/lib/crawler/scheduler");

    startCrawlerScheduler();

    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    expect(setTimeoutSpy.mock.calls[0][1]).toBe(60 * 1000);
  });

  it("only starts once even if called multiple times", async () => {
    process.env.CRAWLER_SCHEDULE = "1";
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const { startCrawlerScheduler } = await import("@/lib/crawler/scheduler");

    startCrawlerScheduler();
    startCrawlerScheduler();
    startCrawlerScheduler();

    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
  });

  it("reschedules the next day's run, anchored to midnight again, after firing", async () => {
    vi.setSystemTime(new Date("2026-01-15T07:59:00.000Z")); // one minute before midnight PST
    process.env.CRAWLER_SCHEDULE = "1";
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const { startCrawlerScheduler } = await import("@/lib/crawler/scheduler");

    startCrawlerScheduler();
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60 * 1000); // fire the first run, landing exactly at midnight

    expect(setTimeoutSpy).toHaveBeenCalledTimes(2);
    expect(setTimeoutSpy.mock.calls[1][1]).toBe(24 * 60 * 60 * 1000);
  });
});

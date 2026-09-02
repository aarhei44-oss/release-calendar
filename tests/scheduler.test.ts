import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

  it("does not schedule an interval when CRAWLER_SCHEDULE is unset", async () => {
    delete process.env.CRAWLER_SCHEDULE;
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const { startCrawlerScheduler } = await import("@/lib/crawler/scheduler");

    startCrawlerScheduler();

    expect(setIntervalSpy).not.toHaveBeenCalled();
  });

  it("does not schedule an interval when CRAWLER_SCHEDULE is 0", async () => {
    process.env.CRAWLER_SCHEDULE = "0";
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const { startCrawlerScheduler } = await import("@/lib/crawler/scheduler");

    startCrawlerScheduler();

    expect(setIntervalSpy).not.toHaveBeenCalled();
  });

  it("schedules a recurring interval matching CRAWLER_SCHEDULE minutes", async () => {
    process.env.CRAWLER_SCHEDULE = "10";
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const { startCrawlerScheduler } = await import("@/lib/crawler/scheduler");

    startCrawlerScheduler();

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy.mock.calls[0][1]).toBe(10 * 60 * 1000);
  });

  it("only starts once even if called multiple times", async () => {
    process.env.CRAWLER_SCHEDULE = "10";
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const { startCrawlerScheduler } = await import("@/lib/crawler/scheduler");

    startCrawlerScheduler();
    startCrawlerScheduler();
    startCrawlerScheduler();

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
  });
});

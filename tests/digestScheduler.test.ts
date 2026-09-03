import { describe, expect, it } from "vitest";
import { msUntilNextLocalHour } from "@/lib/notifications/digestScheduler";

describe("msUntilNextLocalHour", () => {
  it("returns the ms until later today when the target hour hasn't passed yet", () => {
    // 2026-01-15 is not near a DST transition in America/Los_Angeles.
    const now = new Date("2026-01-15T14:00:00.000Z"); // 06:00 PST
    const ms = msUntilNextLocalHour("America/Los_Angeles", 8, now);
    expect(ms).toBe(2 * 60 * 60 * 1000); // 2 hours until 08:00 PST
  });

  it("rolls over to tomorrow when the target hour has already passed today", () => {
    const now = new Date("2026-01-15T20:00:00.000Z"); // 12:00 PST
    const ms = msUntilNextLocalHour("America/Los_Angeles", 8, now);
    expect(ms).toBe(20 * 60 * 60 * 1000); // 20 hours until tomorrow's 08:00 PST
  });

  it("returns a full day when now is exactly the target hour", () => {
    const now = new Date("2026-01-15T16:00:00.000Z"); // 08:00 PST exactly
    const ms = msUntilNextLocalHour("America/Los_Angeles", 8, now);
    expect(ms).toBe(24 * 60 * 60 * 1000);
  });
});

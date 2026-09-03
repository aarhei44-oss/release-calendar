import { describe, expect, it } from "vitest";
import { formatRelativeTime } from "@/app/calendar/eventDisplay";

describe("formatRelativeTime", () => {
  it("formats a few days ago", () => {
    expect(formatRelativeTime(new Date(Date.now() - 3 * 24 * 60 * 60 * 1000))).toBe("3 days ago");
  });

  it("formats a few hours ago", () => {
    expect(formatRelativeTime(new Date(Date.now() - 2 * 60 * 60 * 1000))).toBe("2 hours ago");
  });

  it("formats a few minutes ago", () => {
    expect(formatRelativeTime(new Date(Date.now() - 5 * 60 * 1000))).toBe("5 minutes ago");
  });

  it("formats a moment just now", () => {
    expect(formatRelativeTime(new Date())).toBe("this minute");
  });

  it("formats a future time", () => {
    expect(formatRelativeTime(new Date(Date.now() + 2 * 24 * 60 * 60 * 1000))).toBe("in 2 days");
  });
});

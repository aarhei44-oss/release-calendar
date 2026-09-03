import { describe, expect, it } from "vitest";
import { formatRelativeTime, topReactions } from "@/app/calendar/eventDisplay";

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

describe("topReactions", () => {
  it("returns an empty array for undefined counts", () => {
    expect(topReactions(undefined)).toEqual([]);
  });

  it("sorts by count descending and caps at the limit", () => {
    const counts = { "\u{1F525}": 2, "\u{1F60D}": 5, "\u{1F614}": 1 };
    expect(topReactions(counts, 2)).toEqual([
      { emoji: "\u{1F60D}", count: 5 },
      { emoji: "\u{1F525}", count: 2 },
    ]);
  });

  it("defaults to a limit of 2", () => {
    const counts = { "\u{1F525}": 1, "\u{1F60D}": 1, "\u{1F614}": 1 };
    expect(topReactions(counts)).toHaveLength(2);
  });
});

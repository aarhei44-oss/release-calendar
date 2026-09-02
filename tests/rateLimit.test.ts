import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkRateLimit, RateLimitError } from "@/lib/rateLimit";

describe("checkRateLimit", () => {
  it("allows calls up to the max within the window", () => {
    const key = `test-${crypto.randomUUID()}`;
    for (let i = 0; i < 3; i++) {
      expect(() => checkRateLimit(key, { max: 3, windowMs: 60_000 })).not.toThrow();
    }
  });

  it("throws RateLimitError once the max is exceeded", () => {
    const key = `test-${crypto.randomUUID()}`;
    for (let i = 0; i < 3; i++) {
      checkRateLimit(key, { max: 3, windowMs: 60_000 });
    }
    expect(() => checkRateLimit(key, { max: 3, windowMs: 60_000 })).toThrow(RateLimitError);
  });

  it("tracks separate keys independently", () => {
    const keyA = `test-a-${crypto.randomUUID()}`;
    const keyB = `test-b-${crypto.randomUUID()}`;
    checkRateLimit(keyA, { max: 1, windowMs: 60_000 });
    expect(() => checkRateLimit(keyB, { max: 1, windowMs: 60_000 })).not.toThrow();
  });

  describe("once the window has passed", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("rejects a second call within the window, then allows one after it elapses", () => {
      const key = `test-${crypto.randomUUID()}`;
      checkRateLimit(key, { max: 1, windowMs: 1000 });

      expect(() => checkRateLimit(key, { max: 1, windowMs: 1000 })).toThrow(RateLimitError);

      vi.advanceTimersByTime(1001);

      expect(() => checkRateLimit(key, { max: 1, windowMs: 1000 })).not.toThrow();
    });
  });
});

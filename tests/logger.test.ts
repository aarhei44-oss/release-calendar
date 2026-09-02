import { afterEach, describe, expect, it, vi } from "vitest";
import { logEvent, withActionLogging } from "@/lib/logger";

describe("logEvent", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes a single JSON line to stdout with a timestamp", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    logEvent({ action: "test.event", outcome: "success" });

    expect(spy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(spy.mock.calls[0][0] as string);
    expect(parsed.action).toBe("test.event");
    expect(parsed.outcome).toBe("success");
    expect(typeof parsed.timestamp).toBe("string");
  });
});

describe("withActionLogging", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the wrapped function's result and logs success", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await withActionLogging("test.action", async () => 42);

    expect(result).toBe(42);
    const parsed = JSON.parse(spy.mock.calls[0][0] as string);
    expect(parsed.action).toBe("test.action");
    expect(parsed.outcome).toBe("success");
    expect(typeof parsed.durationMs).toBe("number");
  });

  it("re-throws the original error and logs the failure", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(
      withActionLogging("test.failingAction", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const parsed = JSON.parse(spy.mock.calls[0][0] as string);
    expect(parsed.action).toBe("test.failingAction");
    expect(parsed.outcome).toBe("error");
    expect(parsed.error).toBe("boom");
  });
});

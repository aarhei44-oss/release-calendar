import { describe, expect, it } from "vitest";
import { findMatchingEvent, dispositionFor, type EventDateInfo } from "@/lib/crawler/dedup";

function exact(dateStr: string): EventDateInfo {
  return { dateType: "EXACT", dateExact: new Date(dateStr) };
}

function tbd(): EventDateInfo {
  return { dateType: "TBD" };
}

describe("findMatchingEvent", () => {
  it("matches an existing event within the proximity window", () => {
    const existing = [{ id: "a", ...exact("2026-03-15") }, { id: "b", ...exact("2026-06-01") }];
    const match = findMatchingEvent(exact("2026-03-20"), existing);
    expect(match?.id).toBe("a");
  });

  it("does not match an event outside the proximity window", () => {
    const existing = [{ id: "a", ...exact("2026-03-15") }];
    const match = findMatchingEvent(exact("2026-05-01"), existing);
    expect(match).toBeNull();
  });

  it("picks the closest match when multiple are within range", () => {
    const existing = [{ id: "far", ...exact("2026-03-01") }, { id: "near", ...exact("2026-03-10") }];
    const match = findMatchingEvent(exact("2026-03-12"), existing);
    expect(match?.id).toBe("near");
  });

  it("matches TBD candidates only against existing TBD events", () => {
    const existing = [{ id: "a", ...exact("2026-03-15") }, { id: "b", ...tbd() }];
    const match = findMatchingEvent(tbd(), existing);
    expect(match?.id).toBe("b");
  });

  it("returns null when there is nothing to match", () => {
    expect(findMatchingEvent(exact("2026-03-15"), [])).toBeNull();
  });
});

describe("dispositionFor", () => {
  it("supports when there is no current event yet", () => {
    expect(dispositionFor(exact("2026-03-15"), null)).toBe("SUPPORTS");
  });

  it("supports when the current event is still TBD", () => {
    expect(dispositionFor(exact("2026-03-15"), tbd())).toBe("SUPPORTS");
  });

  it("supports when dates agree within the proximity window", () => {
    expect(dispositionFor(exact("2026-03-15"), exact("2026-03-18"))).toBe("SUPPORTS");
  });

  it("contradicts when dates disagree beyond the proximity window", () => {
    expect(dispositionFor(exact("2026-03-15"), exact("2026-06-01"))).toBe("CONTRADICTS");
  });
});

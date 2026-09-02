import { describe, expect, it } from "vitest";
import { parseFlexibleDate } from "@/lib/crawler/dateParsing";

describe("parseFlexibleDate", () => {
  it("parses 'Month Day, Year' as EXACT", () => {
    const result = parseFlexibleDate("May 9, 2012");
    expect(result.dateType).toBe("EXACT");
    if (result.dateType === "EXACT") {
      expect(result.dateExact.getUTCFullYear()).toBe(2012);
      expect(result.dateExact.getUTCMonth()).toBe(4);
      expect(result.dateExact.getUTCDate()).toBe(9);
    }
  });

  it("parses an abbreviated month with day", () => {
    const result = parseFlexibleDate("Jun 12, 2026");
    expect(result.dateType).toBe("EXACT");
    if (result.dateType === "EXACT") {
      expect(result.dateExact.getUTCMonth()).toBe(5);
      expect(result.dateExact.getUTCDate()).toBe(12);
    }
  });

  it("parses an ISO 'YYYY-MM-DD' date as EXACT", () => {
    const result = parseFlexibleDate("2026-07-25");
    expect(result.dateType).toBe("EXACT");
    if (result.dateType === "EXACT") {
      expect(result.dateExact.getUTCFullYear()).toBe(2026);
      expect(result.dateExact.getUTCMonth()).toBe(6);
      expect(result.dateExact.getUTCDate()).toBe(25);
    }
  });

  it("falls back to TBD for an invalid ISO date", () => {
    expect(parseFlexibleDate("2024-02-30").dateType).toBe("TBD");
  });

  it("parses 'Month Year' (no day) as a one-month WINDOW", () => {
    const result = parseFlexibleDate("December 1993");
    expect(result.dateType).toBe("WINDOW");
    if (result.dateType === "WINDOW") {
      expect(result.windowGranularity).toBe("MONTH");
      expect(result.windowStart.getUTCMonth()).toBe(11);
      expect(result.windowStart.getUTCDate()).toBe(1);
      expect(result.windowEnd.getUTCMonth()).toBe(11);
      expect(result.windowEnd.getUTCDate()).toBe(31);
    }
  });

  it("falls back to TBD for unrecognized text", () => {
    expect(parseFlexibleDate("TBA").dateType).toBe("TBD");
    expect(parseFlexibleDate("").dateType).toBe("TBD");
    expect(parseFlexibleDate("Coming soon").dateType).toBe("TBD");
  });

  it("falls back to TBD for an invalid calendar date", () => {
    expect(parseFlexibleDate("February 30, 2024").dateType).toBe("TBD");
  });
});

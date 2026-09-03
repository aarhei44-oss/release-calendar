import { describe, expect, it } from "vitest";
import { DEFAULT_DASHBOARD_CARD_ORDER, isDashboardCardId, resolveDashboardCardOrder } from "@/app/dashboard/cards";

describe("isDashboardCardId", () => {
  it("accepts every known card id", () => {
    for (const id of DEFAULT_DASHBOARD_CARD_ORDER) expect(isDashboardCardId(id)).toBe(true);
  });

  it("rejects an unknown id", () => {
    expect(isDashboardCardId("somethingElse")).toBe(false);
  });
});

describe("resolveDashboardCardOrder", () => {
  it("falls back to the default order for null (never customized)", () => {
    expect(resolveDashboardCardOrder(null)).toEqual(DEFAULT_DASHBOARD_CARD_ORDER);
  });

  it("falls back to the default order for malformed (non-array) stored data", () => {
    expect(resolveDashboardCardOrder({ not: "an array" })).toEqual(DEFAULT_DASHBOARD_CARD_ORDER);
  });

  it("preserves a valid custom subset and order", () => {
    expect(resolveDashboardCardOrder(["recentActivity", "upcoming"])).toEqual(["recentActivity", "upcoming"]);
  });

  it("drops unknown ids while keeping valid ones", () => {
    expect(resolveDashboardCardOrder(["upcoming", "bogus", "newlyConfirmed"])).toEqual(["upcoming", "newlyConfirmed"]);
  });

  it("de-duplicates repeated ids, keeping the first occurrence's position", () => {
    expect(resolveDashboardCardOrder(["upcoming", "recentActivity", "upcoming"])).toEqual(["upcoming", "recentActivity"]);
  });

  it("preserves an explicit empty array (user unchecked every card) rather than reverting to the default", () => {
    expect(resolveDashboardCardOrder([])).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import {
  PREMIUM_ANNUAL_CENTS,
  PREMIUM_MONTHLY_CENTS,
  annualSavings,
  formatUsd,
} from "@/lib/premiumPricing";

describe("premium pricing copy", () => {
  it("formats the two plans as shown on the Upgrade page", () => {
    expect(formatUsd(PREMIUM_MONTHLY_CENTS)).toBe("$7.99");
    expect(formatUsd(PREMIUM_ANNUAL_CENTS)).toBe("$80.00");
  });

  it("computes what annual saves over twelve monthly payments", () => {
    expect(annualSavings()).toEqual({ cents: 1588, percent: 17 });
  });
});

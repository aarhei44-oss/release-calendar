import { describe, expect, it } from "vitest";
import { computeConfidenceAndStatus } from "@/lib/crawler/confidence";

describe("computeConfidenceAndStatus", () => {
  it("returns zero confidence and RUMORED for no claims", () => {
    const result = computeConfidenceAndStatus([]);
    expect(result.confidence).toBe(0);
    expect(result.status).toBe("RUMORED");
  });

  it("marks CONFIRMED for a single official supporting claim", () => {
    const result = computeConfidenceAndStatus([
      { tier: "OFFICIAL", disposition: "SUPPORTS", confidenceWeight: 1 },
    ]);
    expect(result.status).toBe("CONFIRMED");
    expect(result.confidence).toBeGreaterThan(0.9);
  });

  it("treats a lone speculative claim as low-confidence RUMORED", () => {
    const result = computeConfidenceAndStatus([
      { tier: "SPECULATIVE", disposition: "SUPPORTS", confidenceWeight: 0.5 },
    ]);
    expect(result.status).toBe("RUMORED");
    expect(result.confidence).toBeLessThan(0.3);
  });

  it("raises confidence as corroborating claims accumulate", () => {
    const one = computeConfidenceAndStatus([
      { tier: "COMMUNITY", disposition: "SUPPORTS", confidenceWeight: 0.6 },
    ]);
    const two = computeConfidenceAndStatus([
      { tier: "COMMUNITY", disposition: "SUPPORTS", confidenceWeight: 0.6 },
      { tier: "COMMUNITY", disposition: "SUPPORTS", confidenceWeight: 0.6 },
    ]);
    expect(two.confidence).toBeGreaterThan(one.confidence);
  });

  it("never lets confidence exceed 1", () => {
    const result = computeConfidenceAndStatus([
      { tier: "OFFICIAL", disposition: "SUPPORTS", confidenceWeight: 1 },
      { tier: "OFFICIAL", disposition: "SUPPORTS", confidenceWeight: 1 },
      { tier: "OFFICIAL", disposition: "SUPPORTS", confidenceWeight: 1 },
    ]);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });

  it("discounts confidence when a contradicting claim is present", () => {
    const supported = computeConfidenceAndStatus([
      { tier: "RETAILER", disposition: "SUPPORTS", confidenceWeight: 0.8 },
    ]);
    const contradicted = computeConfidenceAndStatus([
      { tier: "RETAILER", disposition: "SUPPORTS", confidenceWeight: 0.8 },
      { tier: "COMMUNITY", disposition: "CONTRADICTS", confidenceWeight: 0.5 },
    ]);
    expect(contradicted.confidence).toBeLessThan(supported.confidence);
  });

  it("does not let a single low-tier contradiction zero out strong corroboration", () => {
    const result = computeConfidenceAndStatus([
      { tier: "OFFICIAL", disposition: "SUPPORTS", confidenceWeight: 1 },
      { tier: "RETAILER", disposition: "SUPPORTS", confidenceWeight: 0.8 },
      { tier: "SPECULATIVE", disposition: "CONTRADICTS", confidenceWeight: 0.3 },
    ]);
    expect(result.confidence).toBeGreaterThan(0.5);
  });
});

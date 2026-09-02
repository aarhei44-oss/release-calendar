import type { ReleaseStatus, SourceDisposition, SourceTier } from "@/app/generated/prisma/client";

export type ClaimForConfidence = {
  tier: SourceTier;
  disposition: SourceDisposition;
  confidenceWeight: number;
};

const TIER_BASE_WEIGHT: Record<SourceTier, number> = {
  OFFICIAL: 1.0,
  RETAILER: 0.7,
  COMMUNITY: 0.45,
  SPECULATIVE: 0.2,
};

const CONTRADICTION_DISCOUNT = 0.7;

/**
 * Combines a release event's source claims into a single confidence score
 * and status, per technical-spec.md §6.3/§6.5: higher-tier sources and
 * more corroborating claims raise confidence; nothing here mutates or
 * deletes a claim, this only derives the event's current view of them.
 *
 * Supporting claims combine via a noisy-OR (1 - product of "doesn't
 * support" probabilities): each independent corroborating claim raises
 * confidence, with diminishing returns, and it's naturally bounded to
 * [0, 1). Each contradicting claim then discounts the result -- evidence
 * against the date should pull confidence down, but a single low-tier
 * contradiction should not zero out an otherwise well-corroborated event.
 */
export function computeConfidenceAndStatus(claims: ClaimForConfidence[]): {
  confidence: number;
  status: ReleaseStatus;
} {
  const supporting = claims.filter((c) => c.disposition === "SUPPORTS");
  const contradicting = claims.filter((c) => c.disposition === "CONTRADICTS");

  const survivalProbability = supporting.reduce((acc, claim) => {
    const weight = clamp01(TIER_BASE_WEIGHT[claim.tier] * claim.confidenceWeight);
    return acc * (1 - weight);
  }, 1);

  let confidence = 1 - survivalProbability;
  confidence *= CONTRADICTION_DISCOUNT ** contradicting.length;
  confidence = clamp01(confidence);

  const hasOfficialSupport = supporting.some((c) => c.tier === "OFFICIAL");

  let status: ReleaseStatus;
  if (hasOfficialSupport || confidence >= 0.6) {
    status = "CONFIRMED";
  } else if (confidence >= 0.3) {
    status = "ANNOUNCED";
  } else {
    status = "RUMORED";
  }

  return { confidence, status };
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

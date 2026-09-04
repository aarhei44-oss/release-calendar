import { describe, expect, it } from "vitest";
import { GATE_THRESHOLDS, evaluateGate, type GateInput } from "@/lib/ingest/gate";
import {
  originLineage,
  originsAreIndependent,
  type CandidateDate,
  type ClaimRecord,
  type OriginRegistry,
  type PublishedState,
} from "@/lib/ingest/types";

/**
 * The gate decides what the calendar shows, so this file is deliberately the
 * most exhaustive one in the repo. Every rule G1-G7 is covered on its own, at
 * its exact threshold boundary, and in combination with the rules it can
 * collide with.
 *
 * Everything here is a plain unit test over a pure function -- no database, no
 * clock, no network. `now` is injected, which is the only reason the absence
 * and streak boundaries can be asserted exactly rather than approximately.
 */

// A hand-built registry rather than the production ORIGINS, so the lineage
// relationships under test are visible right here and cannot drift when a real
// provider is added in a later phase.
const REGISTRY: OriginRegistry = {
  official: { key: "official", tier: "OFFICIAL", derivesFrom: null },
  official2: { key: "official2", tier: "OFFICIAL", derivesFrom: null },
  retailerA: { key: "retailerA", tier: "RETAILER", derivesFrom: null },
  retailerB: { key: "retailerB", tier: "RETAILER", derivesFrom: null },
  communityA: { key: "communityA", tier: "COMMUNITY", derivesFrom: null },
  communityB: { key: "communityB", tier: "COMMUNITY", derivesFrom: null },

  // A community mirror of the official feed, and a mirror of that mirror --
  // the transitive-lineage case G2 must not mistake for corroboration.
  mirror: { key: "mirror", tier: "COMMUNITY", derivesFrom: "official" },
  deepMirror: { key: "deepMirror", tier: "COMMUNITY", derivesFrom: "mirror" },
  // A second mirror of the same official feed: no direct ancestry between it
  // and `mirror`, but a shared root, so still not independent.
  sibling: { key: "sibling", tier: "COMMUNITY", derivesFrom: "official" },

  // A non-official lineage chain, so transitive dependence can be tested
  // without rule G1 short-circuiting the case.
  hub: { key: "hub", tier: "COMMUNITY", derivesFrom: null },
  hubMirror: { key: "hubMirror", tier: "COMMUNITY", derivesFrom: "hub" },
  hubDeep: { key: "hubDeep", tier: "COMMUNITY", derivesFrom: "hubMirror" },

  rumor: { key: "rumor", tier: "SPECULATIVE", derivesFrom: null },
  rumor2: { key: "rumor2", tier: "SPECULATIVE", derivesFrom: null },
};

const NOW = new Date("2026-06-01T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function exact(iso: string): CandidateDate {
  return { kind: "EXACT", date: new Date(iso) };
}

function daysBefore(days: number): Date {
  return new Date(NOW.getTime() - days * DAY_MS);
}

function claim(overrides: Partial<ClaimRecord> & Pick<ClaimRecord, "origin">): ClaimRecord {
  return {
    tier: REGISTRY[overrides.origin]?.tier ?? "COMMUNITY",
    date: exact("2026-07-01T00:00:00.000Z"),
    consecutiveRuns: 1,
    seenInCurrentRun: true,
    lastSeenAt: NOW,
    confidenceWeight: 0.8,
    ...overrides,
  };
}

function publishedAt(iso: string, status: PublishedState["status"] = "CONFIRMED"): PublishedState {
  return { date: exact(iso), status };
}

function gate(claims: ClaimRecord[], published: PublishedState | null = null, now: Date = NOW) {
  const input: GateInput = { now, claims, published, origins: REGISTRY };
  return evaluateGate(input);
}

// ---------------------------------------------------------------------------

describe("GATE_THRESHOLDS", () => {
  it("keeps every tunable number in one exported place", () => {
    expect(GATE_THRESHOLDS).toEqual({
      agreementDays: 3,
      retailerCorroborationRuns: 7,
      largeShiftDays: 14,
      absenceCancelDays: 14,
    });
  });
});

describe("origin lineage (the basis of G2 independence)", () => {
  it("walks a chain transitively", () => {
    expect(originLineage("hubDeep", REGISTRY)).toEqual(["hubDeep", "hubMirror", "hub"]);
  });

  it("treats an origin as dependent on itself", () => {
    expect(originsAreIndependent("hub", "hub", REGISTRY)).toBe(false);
  });

  it("treats a direct mirror as dependent", () => {
    expect(originsAreIndependent("mirror", "official", REGISTRY)).toBe(false);
  });

  it("treats a transitive mirror as dependent", () => {
    expect(originsAreIndependent("hubDeep", "hub", REGISTRY)).toBe(false);
  });

  it("treats two mirrors of one root as dependent", () => {
    expect(originsAreIndependent("mirror", "sibling", REGISTRY)).toBe(false);
  });

  it("treats unrelated origins as independent", () => {
    expect(originsAreIndependent("retailerA", "communityA", REGISTRY)).toBe(true);
  });

  it("terminates on a cyclic registry instead of hanging", () => {
    const cyclic: OriginRegistry = {
      a: { key: "a", tier: "COMMUNITY", derivesFrom: "b" },
      b: { key: "b", tier: "COMMUNITY", derivesFrom: "a" },
    };
    expect(originLineage("a", cyclic)).toEqual(["a", "b"]);
    expect(originsAreIndependent("a", "b", cyclic)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// G1 -- a single OFFICIAL claim publishes.
// ---------------------------------------------------------------------------

describe("G1: a single OFFICIAL claim publishes", () => {
  it("publishes on one official claim with nothing else on record", () => {
    const verdict = gate([claim({ origin: "official", date: exact("2026-07-01T00:00:00.000Z") })]);
    expect(verdict.action).toBe("PUBLISH");
    expect(verdict.rule).toBe("G1");
    expect(verdict.reason).toBe("OFFICIAL_SINGLE");
    expect(verdict.date).toEqual(exact("2026-07-01T00:00:00.000Z"));
    expect(verdict.status).toBe("CONFIRMED");
    expect(verdict.review).toBeNull();
  });

  it("publishes despite a lone uncorroborated community claim disagreeing", () => {
    // The community claim never qualified on its own, so it is not a
    // "competing claim" in G5's sense -- it is just noise.
    const verdict = gate([
      claim({ origin: "official", date: exact("2026-07-01T00:00:00.000Z") }),
      claim({ origin: "communityA", date: exact("2026-08-01T00:00:00.000Z") }),
    ]);
    expect(verdict.action).toBe("PUBLISH");
    expect(verdict.rule).toBe("G1");
    expect(verdict.date).toEqual(exact("2026-07-01T00:00:00.000Z"));
  });

  it("does not publish from an official claim that states no date", () => {
    const verdict = gate([claim({ origin: "official", date: { kind: "TBD" } })]);
    expect(verdict.action).toBe("HOLD");
    expect(verdict.reason).toBe("NO_DATED_CLAIMS");
    expect(verdict.date).toBeNull();
  });

  it("publishes a WINDOW date from an official source", () => {
    const window: CandidateDate = {
      kind: "WINDOW",
      granularity: "MONTH",
      start: new Date("2026-07-01T00:00:00.000Z"),
      end: new Date("2026-07-31T00:00:00.000Z"),
    };
    const verdict = gate([claim({ origin: "official", date: window })]);
    expect(verdict.action).toBe("PUBLISH");
    expect(verdict.date).toEqual(window);
  });
});

// ---------------------------------------------------------------------------
// G2 -- two independent origins agreeing.
// ---------------------------------------------------------------------------

describe("G2: two independent origins agreeing within the agreement window", () => {
  it("publishes when two unrelated origins agree", () => {
    const verdict = gate([
      claim({ origin: "retailerA", date: exact("2026-07-01T00:00:00.000Z") }),
      claim({ origin: "communityA", date: exact("2026-07-02T00:00:00.000Z") }),
    ]);
    expect(verdict.action).toBe("PUBLISH");
    expect(verdict.rule).toBe("G2");
    expect(verdict.reason).toBe("INDEPENDENT_AGREEMENT");
  });

  it("publishes the higher-tier claim's date when the two differ slightly", () => {
    const verdict = gate([
      claim({ origin: "communityA", date: exact("2026-07-03T00:00:00.000Z") }),
      claim({ origin: "retailerA", date: exact("2026-07-01T00:00:00.000Z") }),
    ]);
    expect(verdict.action).toBe("PUBLISH");
    expect(verdict.date).toEqual(exact("2026-07-01T00:00:00.000Z"));
    expect(verdict.supportingOrigins.sort()).toEqual(["communityA", "retailerA"]);
  });

  it("publishes at exactly the agreement threshold (3 days)", () => {
    const verdict = gate([
      claim({ origin: "retailerA", date: exact("2026-07-01T00:00:00.000Z") }),
      claim({ origin: "communityA", date: exact("2026-07-04T00:00:00.000Z") }),
    ]);
    expect(verdict.action).toBe("PUBLISH");
    expect(verdict.rule).toBe("G2");
  });

  it("does not publish one day past the agreement threshold", () => {
    const verdict = gate([
      claim({ origin: "retailerA", date: exact("2026-07-01T00:00:00.000Z") }),
      claim({ origin: "communityA", date: exact("2026-07-05T00:00:00.000Z") }),
    ]);
    expect(verdict.action).toBe("HOLD");
    expect(verdict.reason).toBe("CONTRADICTED");
    expect(verdict.date).toBeNull();
  });

  it("does NOT count two origins where one derives from the other", () => {
    const verdict = gate([
      claim({ origin: "hub", date: exact("2026-07-01T00:00:00.000Z") }),
      claim({ origin: "hubMirror", date: exact("2026-07-01T00:00:00.000Z") }),
    ]);
    expect(verdict.action).toBe("HOLD");
    expect(verdict.reason).toBe("AWAITING_CORROBORATION");
    expect(verdict.date).toBeNull();
  });

  it("does NOT count two origins related transitively through a third", () => {
    const verdict = gate([
      claim({ origin: "hub", date: exact("2026-07-01T00:00:00.000Z") }),
      claim({ origin: "hubDeep", date: exact("2026-07-01T00:00:00.000Z") }),
    ]);
    expect(verdict.action).toBe("HOLD");
    expect(verdict.reason).toBe("AWAITING_CORROBORATION");
  });

  it("does NOT count two mirrors of the same upstream root", () => {
    const verdict = gate([
      claim({ origin: "hubMirror", date: exact("2026-07-01T00:00:00.000Z") }),
      claim({ origin: "hubDeep", date: exact("2026-07-01T00:00:00.000Z") }),
    ]);
    expect(verdict.action).toBe("HOLD");
  });

  it("publishes once a genuinely independent third origin joins two dependent ones", () => {
    const verdict = gate([
      claim({ origin: "hub", date: exact("2026-07-01T00:00:00.000Z") }),
      claim({ origin: "hubMirror", date: exact("2026-07-01T00:00:00.000Z") }),
      claim({ origin: "communityA", date: exact("2026-07-01T00:00:00.000Z") }),
    ]);
    expect(verdict.action).toBe("PUBLISH");
    expect(verdict.rule).toBe("G2");
  });

  it("never publishes from a single origin reported twice", () => {
    const verdict = gate([
      claim({ origin: "communityA", date: exact("2026-07-01T00:00:00.000Z") }),
      claim({ origin: "communityA", date: exact("2026-07-01T00:00:00.000Z") }),
    ]);
    expect(verdict.action).toBe("HOLD");
  });
});

// ---------------------------------------------------------------------------
// G3 -- a lone retailer claim, held still for long enough.
// ---------------------------------------------------------------------------

describe("G3: a lone RETAILER claim needs 7 consecutive unchanged runs", () => {
  it("holds at six runs", () => {
    const verdict = gate([claim({ origin: "retailerA", consecutiveRuns: 6 })]);
    expect(verdict.action).toBe("HOLD");
    expect(verdict.reason).toBe("AWAITING_CORROBORATION");
    expect(verdict.date).toBeNull();
  });

  it("publishes at exactly seven runs", () => {
    const verdict = gate([claim({ origin: "retailerA", consecutiveRuns: 7 })]);
    expect(verdict.action).toBe("PUBLISH");
    expect(verdict.rule).toBe("G3");
    expect(verdict.reason).toBe("RETAILER_STREAK");
  });

  it("keeps publishing past seven runs", () => {
    expect(gate([claim({ origin: "retailerA", consecutiveRuns: 20 })]).action).toBe("PUBLISH");
  });

  it("never applies to a COMMUNITY-tier claim, however long its streak", () => {
    const verdict = gate([claim({ origin: "communityA", consecutiveRuns: 500 })]);
    expect(verdict.action).toBe("HOLD");
    expect(verdict.reason).toBe("AWAITING_CORROBORATION");
  });

  it("does not publish when another origin contradicts, and reports the streak reset", () => {
    const verdict = gate([
      claim({ origin: "retailerA", consecutiveRuns: 7, date: exact("2026-07-01T00:00:00.000Z") }),
      claim({ origin: "communityA", date: exact("2026-07-20T00:00:00.000Z") }),
    ]);
    expect(verdict.action).toBe("HOLD");
    expect(verdict.reason).toBe("CONTRADICTED");
    expect(verdict.streakResets.sort()).toEqual(["communityA", "retailerA"]);
  });

  it("is not contradicted by a SPECULATIVE claim -- rumour tier cannot veto either", () => {
    const verdict = gate([
      claim({ origin: "retailerA", consecutiveRuns: 7, date: exact("2026-07-01T00:00:00.000Z") }),
      claim({ origin: "rumor", date: exact("2026-09-01T00:00:00.000Z") }),
    ]);
    expect(verdict.action).toBe("PUBLISH");
    expect(verdict.rule).toBe("G3");
    expect(verdict.streakResets).toEqual([]);
  });

  it("is unaffected by a second retailer that agrees -- that is G2's job, and it wins", () => {
    const verdict = gate([
      claim({ origin: "retailerA", consecutiveRuns: 1, date: exact("2026-07-01T00:00:00.000Z") }),
      claim({ origin: "retailerB", consecutiveRuns: 1, date: exact("2026-07-01T00:00:00.000Z") }),
    ]);
    expect(verdict.action).toBe("PUBLISH");
    expect(verdict.rule).toBe("G2");
  });
});

// ---------------------------------------------------------------------------
// G4 -- speculative never publishes a date.
// ---------------------------------------------------------------------------

describe("G4: SPECULATIVE tier never publishes a date", () => {
  it("holds a dateless RUMORED event when only rumour tier has a date", () => {
    const verdict = gate([claim({ origin: "rumor", date: exact("2026-07-01T00:00:00.000Z") })]);
    expect(verdict.action).toBe("HOLD");
    expect(verdict.rule).toBe("G4");
    expect(verdict.reason).toBe("SPECULATIVE_ONLY");
    expect(verdict.date).toBeNull();
    expect(verdict.status).toBe("RUMORED");
    expect(verdict.supportingOrigins).toEqual(["rumor"]);
  });

  it("does not publish even when two independent rumour origins agree", () => {
    const verdict = gate([
      claim({ origin: "rumor", date: exact("2026-07-01T00:00:00.000Z") }),
      claim({ origin: "rumor2", date: exact("2026-07-01T00:00:00.000Z") }),
    ]);
    expect(verdict.action).toBe("HOLD");
    expect(verdict.rule).toBe("G4");
    expect(verdict.date).toBeNull();
  });

  it("does not publish even on a very long rumour streak", () => {
    const verdict = gate([claim({ origin: "rumor", consecutiveRuns: 999 })]);
    expect(verdict.action).toBe("HOLD");
    expect(verdict.rule).toBe("G4");
  });

  it("corroborates an existing dateless RUMORED event without giving it a date", () => {
    const verdict = gate([claim({ origin: "rumor" })], { date: null, status: "RUMORED" });
    expect(verdict.action).toBe("HOLD");
    expect(verdict.rule).toBe("G4");
    expect(verdict.date).toBeNull();
    expect(verdict.status).toBe("RUMORED");
  });

  it("leaves an already-published date untouched", () => {
    const verdict = gate(
      [claim({ origin: "rumor", date: exact("2026-09-01T00:00:00.000Z") })],
      publishedAt("2026-07-01T00:00:00.000Z"),
    );
    expect(verdict.action).toBe("HOLD");
    expect(verdict.date).toEqual(exact("2026-07-01T00:00:00.000Z"));
    expect(verdict.status).toBe("CONFIRMED");
  });

  it("steps aside once a non-speculative claim exists, even an unqualified one", () => {
    const verdict = gate([
      claim({ origin: "rumor", date: exact("2026-07-01T00:00:00.000Z") }),
      claim({ origin: "communityA", date: exact("2026-07-01T00:00:00.000Z") }),
    ]);
    expect(verdict.rule).toBe("NONE");
    expect(verdict.reason).toBe("AWAITING_CORROBORATION");
  });
});

// ---------------------------------------------------------------------------
// G5 -- conflict.
// ---------------------------------------------------------------------------

describe("G5: qualifying claims that disagree by more than 3 days conflict", () => {
  it("flags rather than picking a winner when two official claims disagree", () => {
    const verdict = gate([
      claim({ origin: "official", date: exact("2026-07-01T00:00:00.000Z") }),
      claim({ origin: "official2", date: exact("2026-07-20T00:00:00.000Z") }),
    ]);
    expect(verdict.action).toBe("FLAG");
    expect(verdict.rule).toBe("G5");
    expect(verdict.reason).toBe("CONFLICT");
    expect(verdict.review?.reason).toBe("CONFLICT");
  });

  it("holds the PREVIOUSLY published value, not either competing claim", () => {
    const verdict = gate(
      [
        claim({ origin: "official", date: exact("2026-07-01T00:00:00.000Z") }),
        claim({ origin: "official2", date: exact("2026-07-20T00:00:00.000Z") }),
      ],
      publishedAt("2026-06-10T00:00:00.000Z"),
    );
    expect(verdict.action).toBe("FLAG");
    expect(verdict.date).toEqual(exact("2026-06-10T00:00:00.000Z"));
    expect(verdict.status).toBe("CONFIRMED");
  });

  it("does not resolve by recency: reversing the claim order changes nothing", () => {
    const claims = [
      claim({ origin: "official", date: exact("2026-07-01T00:00:00.000Z"), lastSeenAt: daysBefore(2) }),
      claim({ origin: "official2", date: exact("2026-07-20T00:00:00.000Z"), lastSeenAt: NOW }),
    ];
    const forward = gate(claims, publishedAt("2026-06-10T00:00:00.000Z"));
    const reversed = gate([...claims].reverse(), publishedAt("2026-06-10T00:00:00.000Z"));
    expect(reversed.action).toBe(forward.action);
    expect(reversed.date).toEqual(forward.date);
    expect(reversed.reason).toBe(forward.reason);
  });

  it("does not resolve by tier: an official and a qualifying retailer pair still conflict", () => {
    const verdict = gate(
      [
        claim({ origin: "official", date: exact("2026-07-01T00:00:00.000Z") }),
        claim({ origin: "retailerA", date: exact("2026-07-20T00:00:00.000Z") }),
        claim({ origin: "communityA", date: exact("2026-07-20T00:00:00.000Z") }),
      ],
      publishedAt("2026-06-10T00:00:00.000Z"),
    );
    expect(verdict.action).toBe("FLAG");
    expect(verdict.rule).toBe("G5");
    expect(verdict.date).toEqual(exact("2026-06-10T00:00:00.000Z"));
  });

  it("does not conflict at exactly the agreement threshold", () => {
    const verdict = gate([
      claim({ origin: "official", date: exact("2026-07-01T00:00:00.000Z") }),
      claim({ origin: "official2", date: exact("2026-07-04T00:00:00.000Z") }),
    ]);
    expect(verdict.action).toBe("PUBLISH");
    expect(verdict.rule).toBe("G1");
  });

  it("conflicts just past the agreement threshold", () => {
    const verdict = gate([
      claim({ origin: "official", date: exact("2026-07-01T00:00:00.000Z") }),
      claim({ origin: "official2", date: exact("2026-07-04T12:00:00.000Z") }),
    ]);
    expect(verdict.action).toBe("FLAG");
    expect(verdict.rule).toBe("G5");
    expect(verdict.review?.detail.gapDays).toBeCloseTo(3.5, 6);
  });

  it("holds nothing published as nothing published, and still flags", () => {
    const verdict = gate([
      claim({ origin: "official", date: exact("2026-07-01T00:00:00.000Z") }),
      claim({ origin: "official2", date: exact("2026-07-20T00:00:00.000Z") }),
    ]);
    expect(verdict.date).toBeNull();
    expect(verdict.status).toBe("RUMORED");
    expect(verdict.action).toBe("FLAG");
  });

  it("records every claim in the review detail, machine-readable", () => {
    const verdict = gate(
      [
        claim({ origin: "official", date: exact("2026-07-01T00:00:00.000Z"), url: "https://a.example/x" }),
        claim({ origin: "official2", date: exact("2026-07-20T00:00:00.000Z") }),
      ],
      publishedAt("2026-06-10T00:00:00.000Z"),
    );
    const detail = verdict.review?.detail;
    expect(detail?.publishedDate).toEqual({ kind: "EXACT", date: "2026-06-10T00:00:00.000Z" });
    expect(detail?.claims).toHaveLength(2);
    expect(detail?.claims[0]).toMatchObject({
      origin: "official",
      tier: "OFFICIAL",
      date: { kind: "EXACT", date: "2026-07-01T00:00:00.000Z" },
      url: "https://a.example/x",
    });
    // Must survive a JSON round trip -- it is stored in ReviewItem.detail.
    expect(JSON.parse(JSON.stringify(detail))).toEqual(detail);
  });
});

// ---------------------------------------------------------------------------
// G6 -- large shift.
// ---------------------------------------------------------------------------

describe("G6: a published date moving more than 14 days is flagged", () => {
  it("fires even when every origin agrees unanimously", () => {
    const verdict = gate(
      [
        claim({ origin: "official", date: exact("2026-07-20T00:00:00.000Z") }),
        claim({ origin: "retailerA", date: exact("2026-07-20T00:00:00.000Z") }),
        claim({ origin: "communityA", date: exact("2026-07-20T00:00:00.000Z") }),
      ],
      publishedAt("2026-07-01T00:00:00.000Z"),
    );
    expect(verdict.action).toBe("FLAG");
    expect(verdict.rule).toBe("G6");
    expect(verdict.reason).toBe("LARGE_SHIFT");
    expect(verdict.review?.reason).toBe("LARGE_SHIFT");
  });

  it("holds the old value pending review", () => {
    const verdict = gate(
      [claim({ origin: "official", date: exact("2026-07-20T00:00:00.000Z") })],
      publishedAt("2026-07-01T00:00:00.000Z"),
    );
    expect(verdict.date).toEqual(exact("2026-07-01T00:00:00.000Z"));
    expect(verdict.review?.detail.proposedDate).toEqual({ kind: "EXACT", date: "2026-07-20T00:00:00.000Z" });
    expect(verdict.review?.detail.gapDays).toBe(19);
  });

  it("does not fire at exactly 14 days", () => {
    const verdict = gate(
      [claim({ origin: "official", date: exact("2026-07-15T00:00:00.000Z") })],
      publishedAt("2026-07-01T00:00:00.000Z"),
    );
    expect(verdict.action).toBe("PUBLISH");
    expect(verdict.date).toEqual(exact("2026-07-15T00:00:00.000Z"));
  });

  it("fires just past 14 days", () => {
    const verdict = gate(
      [claim({ origin: "official", date: exact("2026-07-15T12:00:00.000Z") })],
      publishedAt("2026-07-01T00:00:00.000Z"),
    );
    expect(verdict.action).toBe("FLAG");
    expect(verdict.rule).toBe("G6");
  });

  it("fires on a large move backwards as well as forwards", () => {
    const verdict = gate(
      [claim({ origin: "official", date: exact("2026-06-01T00:00:00.000Z") })],
      publishedAt("2026-07-01T00:00:00.000Z"),
    );
    expect(verdict.action).toBe("FLAG");
    expect(verdict.rule).toBe("G6");
  });

  it("does not fire on a first publish, however far out the date is", () => {
    const verdict = gate([claim({ origin: "official", date: exact("2029-01-01T00:00:00.000Z") })], null);
    expect(verdict.action).toBe("PUBLISH");
  });

  it("does not fire when the event was published without a date", () => {
    const verdict = gate([claim({ origin: "official", date: exact("2029-01-01T00:00:00.000Z") })], {
      date: null,
      status: "RUMORED",
    });
    expect(verdict.action).toBe("PUBLISH");
  });
});

// ---------------------------------------------------------------------------
// G7 -- absence.
// ---------------------------------------------------------------------------

describe("G7: absence never unpublishes", () => {
  function absent(overrides: Partial<ClaimRecord> = {}): ClaimRecord {
    return claim({ origin: "official", seenInCurrentRun: false, lastSeenAt: daysBefore(5), ...overrides });
  }

  it("goes stale, keeping the published date and status, inside the window", () => {
    const verdict = gate([absent()], publishedAt("2026-12-01T00:00:00.000Z"));
    expect(verdict.action).toBe("STALE");
    expect(verdict.rule).toBe("G7");
    expect(verdict.reason).toBe("ABSENT");
    expect(verdict.date).toEqual(exact("2026-12-01T00:00:00.000Z"));
    expect(verdict.status).toBe("CONFIRMED");
  });

  it("cancels a still-future event at exactly 14 days of absence", () => {
    const verdict = gate([absent({ lastSeenAt: daysBefore(14) })], publishedAt("2026-12-01T00:00:00.000Z"));
    expect(verdict.action).toBe("STALE");
    expect(verdict.reason).toBe("ABSENT_CANCELLED");
    expect(verdict.status).toBe("CANCELLED");
    // The date survives the cancellation -- that is the whole rule.
    expect(verdict.date).toEqual(exact("2026-12-01T00:00:00.000Z"));
  });

  it("does not cancel one hour short of 14 days", () => {
    const verdict = gate(
      [absent({ lastSeenAt: new Date(daysBefore(14).getTime() + 60 * 60 * 1000) })],
      publishedAt("2026-12-01T00:00:00.000Z"),
    );
    expect(verdict.reason).toBe("ABSENT");
    expect(verdict.status).toBe("CONFIRMED");
  });

  it("never cancels an event whose date has already passed -- that is shipping, not cancellation", () => {
    const verdict = gate([absent({ lastSeenAt: daysBefore(60) })], publishedAt("2026-01-01T00:00:00.000Z", "RELEASED"));
    expect(verdict.action).toBe("STALE");
    expect(verdict.reason).toBe("ABSENT");
    expect(verdict.status).toBe("RELEASED");
    expect(verdict.date).toEqual(exact("2026-01-01T00:00:00.000Z"));
  });

  it("does not re-cancel an event that is already cancelled", () => {
    const verdict = gate(
      [absent({ lastSeenAt: daysBefore(90) })],
      publishedAt("2026-12-01T00:00:00.000Z", "CANCELLED"),
    );
    expect(verdict.reason).toBe("ABSENT");
    expect(verdict.status).toBe("CANCELLED");
  });

  it("cancels a dateless rumour that everyone stopped reporting", () => {
    const verdict = gate([absent({ lastSeenAt: daysBefore(30) })], { date: null, status: "RUMORED" });
    expect(verdict.reason).toBe("ABSENT_CANCELLED");
    expect(verdict.status).toBe("CANCELLED");
    expect(verdict.date).toBeNull();
  });

  it("survives an event with no claims on record at all", () => {
    const verdict = gate([], publishedAt("2026-12-01T00:00:00.000Z"));
    expect(verdict.action).toBe("STALE");
    expect(verdict.reason).toBe("ABSENT");
    expect(verdict.date).toEqual(exact("2026-12-01T00:00:00.000Z"));
    expect(verdict.status).toBe("CONFIRMED");
  });

  it("requires unanimous absence -- one live claim takes it out of G7 entirely", () => {
    const verdict = gate(
      [absent({ lastSeenAt: daysBefore(90) }), claim({ origin: "retailerA", consecutiveRuns: 7 })],
      publishedAt("2026-12-01T00:00:00.000Z"),
    );
    expect(verdict.action).not.toBe("STALE");
    expect(verdict.rule).not.toBe("G7");
  });

  it("never produces a delete or an archive, at any absence length", () => {
    for (const days of [1, 14, 30, 365, 3650]) {
      const verdict = gate([absent({ lastSeenAt: daysBefore(days) })], publishedAt("2026-12-01T00:00:00.000Z"));
      expect(verdict.action).toBe("STALE");
      expect(["ABSENT", "ABSENT_CANCELLED"]).toContain(verdict.reason);
      // The date is still there, whatever happened.
      expect(verdict.date).toEqual(exact("2026-12-01T00:00:00.000Z"));
      // And the verdict vocabulary simply has no way to express a removal.
      expect(Object.keys(verdict)).not.toContain("delete");
      expect(Object.keys(verdict)).not.toContain("archive");
      expect(["PUBLISH", "HOLD", "FLAG", "STALE"]).toContain(verdict.action);
    }
  });
});

// ---------------------------------------------------------------------------
// Rule interactions.
// ---------------------------------------------------------------------------

describe("rule interactions", () => {
  it("G5 wins over G1: a conflict is not settled by an official claim being present", () => {
    const verdict = gate(
      [
        claim({ origin: "official", date: exact("2026-07-01T00:00:00.000Z") }),
        claim({ origin: "official2", date: exact("2026-08-01T00:00:00.000Z") }),
      ],
      publishedAt("2026-07-01T00:00:00.000Z"),
    );
    expect(verdict.rule).toBe("G5");
  });

  it("G5 wins over G6 when both would apply", () => {
    // Two qualifying claims 30 days apart, and either would also be a large
    // shift from the published date. The conflict is the more specific
    // problem, and the one a human needs to see first.
    const verdict = gate(
      [
        claim({ origin: "official", date: exact("2026-08-01T00:00:00.000Z") }),
        claim({ origin: "official2", date: exact("2026-09-01T00:00:00.000Z") }),
      ],
      publishedAt("2026-07-01T00:00:00.000Z"),
    );
    expect(verdict.rule).toBe("G5");
    expect(verdict.review?.reason).toBe("CONFLICT");
  });

  it("G4 wins over G3: a speculative streak is still speculative", () => {
    const verdict = gate([claim({ origin: "rumor", consecutiveRuns: 50 })]);
    expect(verdict.rule).toBe("G4");
  });

  it("G7 wins over everything: with nothing observed there is nothing to weigh", () => {
    const verdict = gate(
      [claim({ origin: "official", seenInCurrentRun: false, lastSeenAt: daysBefore(1) })],
      publishedAt("2026-12-01T00:00:00.000Z"),
    );
    expect(verdict.rule).toBe("G7");
  });

  it("a contradiction resets the streak, and the rebuilt streak publishes again", () => {
    const contradicted = gate([
      claim({ origin: "retailerA", consecutiveRuns: 9, date: exact("2026-07-01T00:00:00.000Z") }),
      claim({ origin: "communityA", date: exact("2026-08-01T00:00:00.000Z") }),
    ]);
    expect(contradicted.action).toBe("HOLD");
    expect(contradicted.streakResets).toContain("retailerA");

    // Six runs after the reset: still not enough.
    expect(gate([claim({ origin: "retailerA", consecutiveRuns: 6 })]).action).toBe("HOLD");
    // Seventh: back in business.
    expect(gate([claim({ origin: "retailerA", consecutiveRuns: 7 })]).action).toBe("PUBLISH");
  });

  it("an absent claim still counts against a live one for conflict purposes only when live", () => {
    // The stale claim is not observed this run, so it cannot contradict.
    const verdict = gate([
      claim({ origin: "retailerA", consecutiveRuns: 7, date: exact("2026-07-01T00:00:00.000Z") }),
      claim({
        origin: "communityA",
        date: exact("2026-09-01T00:00:00.000Z"),
        seenInCurrentRun: false,
        lastSeenAt: daysBefore(20),
      }),
    ]);
    expect(verdict.action).toBe("PUBLISH");
    expect(verdict.rule).toBe("G3");
  });
});

// ---------------------------------------------------------------------------
// Confidence is computed but does not decide visibility.
// ---------------------------------------------------------------------------

describe("confidence is a display signal, never the visibility decision", () => {
  it("publishes an official claim whose confidence is very low", () => {
    const verdict = gate([claim({ origin: "official", confidenceWeight: 0.05 })]);
    expect(verdict.action).toBe("PUBLISH");
    expect(verdict.confidence).toBeLessThan(0.3);
  });

  it("holds a well-corroborated but non-independent claim set despite high confidence", () => {
    const verdict = gate([
      claim({ origin: "mirror", confidenceWeight: 1, date: exact("2026-07-01T00:00:00.000Z") }),
      claim({ origin: "deepMirror", confidenceWeight: 1, date: exact("2026-07-01T00:00:00.000Z") }),
      claim({ origin: "sibling", confidenceWeight: 1, date: exact("2026-07-01T00:00:00.000Z") }),
    ]);
    expect(verdict.confidence).toBeGreaterThan(0.6);
    expect(verdict.action).toBe("HOLD");
    expect(verdict.date).toBeNull();
  });

  it("still reports a confidence on a flagged conflict, for review-queue ranking", () => {
    const verdict = gate(
      [
        claim({ origin: "official", date: exact("2026-07-01T00:00:00.000Z") }),
        claim({ origin: "official2", date: exact("2026-08-01T00:00:00.000Z") }),
      ],
      publishedAt("2026-07-01T00:00:00.000Z"),
    );
    expect(verdict.action).toBe("FLAG");
    expect(verdict.confidence).toBeGreaterThan(0);
    expect(verdict.confidence).toBeLessThanOrEqual(1);
  });

  it("bounds confidence to [0, 1] with a large agreeing claim set", () => {
    const claims = Array.from({ length: 8 }, (_, i) =>
      claim({ origin: i % 2 === 0 ? "retailerA" : "communityA", confidenceWeight: 1 }),
    );
    const verdict = gate(claims);
    expect(verdict.confidence).toBeGreaterThanOrEqual(0);
    expect(verdict.confidence).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Determinism -- the property replay depends on.
// ---------------------------------------------------------------------------

describe("determinism", () => {
  it("returns an identical verdict for the same inputs in a different order", () => {
    const claims = [
      claim({ origin: "retailerA", date: exact("2026-07-01T00:00:00.000Z"), consecutiveRuns: 3 }),
      claim({ origin: "communityA", date: exact("2026-07-02T00:00:00.000Z"), consecutiveRuns: 5 }),
      claim({ origin: "communityB", date: exact("2026-07-01T00:00:00.000Z"), consecutiveRuns: 2 }),
    ];
    const a = gate(claims, publishedAt("2026-07-01T00:00:00.000Z"));
    const b = gate([...claims].reverse(), publishedAt("2026-07-01T00:00:00.000Z"));
    expect(b.action).toBe(a.action);
    expect(b.rule).toBe(a.rule);
    expect(b.date).toEqual(a.date);
    expect(b.confidence).toBeCloseTo(a.confidence, 10);
  });

  it("does not read the system clock -- moving `now` alone changes an absence outcome", () => {
    const absentClaim = claim({ origin: "official", seenInCurrentRun: false, lastSeenAt: NOW });
    const published = publishedAt("2027-12-01T00:00:00.000Z");
    expect(gate([absentClaim], published, NOW).reason).toBe("ABSENT");
    expect(gate([absentClaim], published, new Date(NOW.getTime() + 14 * DAY_MS)).reason).toBe("ABSENT_CANCELLED");
  });
});

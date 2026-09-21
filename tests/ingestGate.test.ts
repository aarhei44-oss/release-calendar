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
 * most exhaustive one in the repo. Every rule G1-G8 is covered on its own, at
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

/** As `gate`, but hands the gate a schedule to check claims against (rule G8). */
function gateWithSchedule(
  claims: ClaimRecord[],
  expectedDates: CandidateDate[],
  published: PublishedState | null = null,
  now: Date = NOW,
) {
  const input: GateInput = { now, claims, published, origins: REGISTRY, expectedDates };
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

// ---------------------------------------------------------------------------
// G8 -- schedule corroboration.
//
// The rule exists for exactly one shape of problem: a prerelease date that only
// one COMMUNITY source states, which every other rule correctly declines to
// publish and which therefore sat at a null date forever. These tests pin both
// halves of that -- that the schedule lets such a claim through, and that it is
// a real check rather than a rubber stamp.
// ---------------------------------------------------------------------------

describe("G8 -- a lone claim matching the game's own schedule", () => {
  const SHELF_FRIDAY = "2026-07-24T00:00:00.000Z";
  const PRERELEASE_FRIDAY = "2026-07-17T00:00:00.000Z";

  it("publishes a lone community claim that lands on the expected date", () => {
    const verdict = gateWithSchedule([claim({ origin: "communityA", date: exact(PRERELEASE_FRIDAY) })], [
      exact(PRERELEASE_FRIDAY),
    ]);
    expect(verdict.action).toBe("PUBLISH");
    expect(verdict.rule).toBe("G8");
    expect(verdict.reason).toBe("SCHEDULE_CORROBORATED");
    expect(verdict.date).toEqual(exact(PRERELEASE_FRIDAY));
  });

  it("is exactly the case that holds today without a schedule", () => {
    const claims = [claim({ origin: "communityA", date: exact(PRERELEASE_FRIDAY) })];
    const held = gate(claims);
    expect(held.action).toBe("HOLD");
    expect(held.reason).toBe("AWAITING_CORROBORATION");
    expect(held.date).toBeNull();
  });

  it("holds a claim that misses the expected date, so the check is a real one", () => {
    const verdict = gateWithSchedule([claim({ origin: "communityA", date: exact("2026-07-04T00:00:00.000Z") })], [
      exact(PRERELEASE_FRIDAY),
    ]);
    expect(verdict.action).toBe("HOLD");
    expect(verdict.rule).toBe("NONE");
    expect(verdict.date).toBeNull();
  });

  it("uses the same agreement window as every other rule -- 3 days in, 4 days out", () => {
    const inside = gateWithSchedule([claim({ origin: "communityA", date: exact("2026-07-20T00:00:00.000Z") })], [
      exact(PRERELEASE_FRIDAY),
    ]);
    expect(inside.rule).toBe("G8");

    const outside = gateWithSchedule([claim({ origin: "communityA", date: exact("2026-07-21T00:00:00.000Z") })], [
      exact(PRERELEASE_FRIDAY),
    ]);
    expect(outside.action).toBe("HOLD");
  });

  it("matches any slot when a game predicts several (Pokemon's two prerelease Fridays)", () => {
    const firstWeekend = exact("2026-07-10T00:00:00.000Z");
    const secondWeekend = exact(PRERELEASE_FRIDAY);
    const verdict = gateWithSchedule([claim({ origin: "communityA", date: firstWeekend })], [
      secondWeekend,
      firstWeekend,
    ]);
    expect(verdict.rule).toBe("G8");
    expect(verdict.date).toEqual(firstWeekend);
  });

  it("declines a claim another origin contradicts, the same way G3 does", () => {
    const verdict = gateWithSchedule(
      [
        claim({ origin: "communityA", date: exact(PRERELEASE_FRIDAY) }),
        claim({ origin: "retailerA", date: exact("2026-06-20T00:00:00.000Z") }),
      ],
      [exact(PRERELEASE_FRIDAY)],
    );
    expect(verdict.action).toBe("HOLD");
    expect(verdict.reason).toBe("CONTRADICTED");
  });

  it("never overrides G4 -- a speculative claim on the expected date still publishes nothing", () => {
    const verdict = gateWithSchedule([claim({ origin: "rumor", date: exact(PRERELEASE_FRIDAY) })], [
      exact(PRERELEASE_FRIDAY),
    ]);
    expect(verdict.action).toBe("HOLD");
    expect(verdict.rule).toBe("G4");
    expect(verdict.reason).toBe("SPECULATIVE_ONLY");
  });

  it("yields to G1 and G2 when they also fire, so the recorded rule names the stronger evidence", () => {
    const viaOfficial = gateWithSchedule([claim({ origin: "official", date: exact(PRERELEASE_FRIDAY) })], [
      exact(PRERELEASE_FRIDAY),
    ]);
    expect(viaOfficial.rule).toBe("G1");

    const viaAgreement = gateWithSchedule(
      [
        claim({ origin: "communityA", date: exact(PRERELEASE_FRIDAY) }),
        claim({ origin: "communityB", date: exact(PRERELEASE_FRIDAY) }),
      ],
      [exact(PRERELEASE_FRIDAY)],
    );
    expect(viaAgreement.rule).toBe("G2");
  });

  it("still defers to G6 -- a schedule match is not a licence to move a date two weeks", () => {
    const verdict = gateWithSchedule(
      [claim({ origin: "communityA", date: exact(PRERELEASE_FRIDAY) })],
      [exact(PRERELEASE_FRIDAY)],
      publishedAt("2026-06-01T00:00:00.000Z"),
    );
    expect(verdict.action).toBe("FLAG");
    expect(verdict.rule).toBe("G6");
    expect(verdict.date).toEqual(exact("2026-06-01T00:00:00.000Z"));
  });

  it("is inert when no schedule is supplied, which is every non-prerelease event", () => {
    const withEmpty = gateWithSchedule([claim({ origin: "communityA", date: exact(SHELF_FRIDAY) })], []);
    expect(withEmpty.action).toBe("HOLD");
    expect(withEmpty.rule).toBe("NONE");
  });
});

// ---------------------------------------------------------------------------
// RELEASED: the gate must not undo the release lifecycle
// ---------------------------------------------------------------------------

describe("a released event keeps its status while its sources restate the same past date", () => {
  const RELEASE_DAY = "2026-05-15T00:00:00.000Z"; // well before NOW (2026-06-01)

  const twoAgreeing = () => [
    claim({ origin: "official", date: exact(RELEASE_DAY) }),
    claim({ origin: "retailerA", date: exact(RELEASE_DAY) }),
  ];

  it("stays RELEASED when a fresh PUBLISH would otherwise score it CONFIRMED", () => {
    const verdict = gate(twoAgreeing(), publishedAt(RELEASE_DAY, "RELEASED"));
    expect(verdict.action).toBe("PUBLISH");
    expect(verdict.status).toBe("RELEASED");
  });

  it("is a no-op for an event that was not released: the score still decides", () => {
    const verdict = gate(twoAgreeing(), publishedAt(RELEASE_DAY, "CONFIRMED"));
    expect(verdict.action).toBe("PUBLISH");
    expect(verdict.status).toBe("CONFIRMED");
  });

  it("stops being RELEASED when the date moves to the future -- a real slip", () => {
    const justReleased = "2026-05-30T00:00:00.000Z";
    const slipped = "2026-06-10T00:00:00.000Z"; // after NOW, and 11 days on: inside the 14-day shift bound
    const verdict = gate(
      [claim({ origin: "official", date: exact(slipped) }), claim({ origin: "retailerA", date: exact(slipped) })],
      publishedAt(justReleased, "RELEASED"),
    );
    expect(verdict.action).toBe("PUBLISH");
    expect(verdict.status).toBe("CONFIRMED");
  });

  it("does not release an event whose date is today: the day is not over", () => {
    // The gate only *preserves* RELEASED; it never grants it. A published CONFIRMED
    // event dated today therefore stays CONFIRMED however it is restated.
    const today = "2026-06-01T00:00:00.000Z";
    const verdict = gate(
      [claim({ origin: "official", date: exact(today) }), claim({ origin: "retailerA", date: exact(today) })],
      publishedAt(today, "CONFIRMED"),
    );
    expect(verdict.status).toBe("CONFIRMED");
  });

  it("holds RELEASED through an absence, as it holds any status", () => {
    const verdict = gate(
      [claim({ origin: "official", date: exact(RELEASE_DAY), seenInCurrentRun: false, lastSeenAt: daysBefore(30) })],
      publishedAt(RELEASE_DAY, "RELEASED"),
    );
    expect(verdict.action).toBe("STALE");
    expect(verdict.status).toBe("RELEASED");
  });
});

// ---------------------------------------------------------------------------
// Lorcana: a numbered set's TCGplayer date is the local-store date
// ---------------------------------------------------------------------------

describe("Lorcana's split shelf and local-store dates, as tcgcsv.ts now emits them", () => {
  // Hyperia City: TCGplayer 2026-10-16 (local stores), Ravensburger wide release
  // 2026-10-23, Wikipedia states both. tcgcsv emits the shelf claim at +7 days.
  const WIDE = "2026-10-23T00:00:00.000Z";
  const LOCAL = "2026-10-16T00:00:00.000Z";

  it("publishes the wide date for the shelf event, where the raw TCGplayer date used to be published", () => {
    const verdict = gate([
      claim({ origin: "retailerA", date: exact(WIDE) }), // tcgplayer, +7 days
      claim({ origin: "communityA", date: exact(WIDE) }), // wikipedia shelf column
    ]);
    expect(verdict).toMatchObject({ action: "PUBLISH", rule: "G2" });
    expect(verdict.date).toEqual(exact(WIDE));
  });

  it("publishes the local-store date for the prerelease event under G2", () => {
    const verdict = gate([
      claim({ origin: "retailerA", date: exact(LOCAL) }), // tcgplayer as-is, now a PRERELEASE claim
      claim({ origin: "communityA", date: exact(LOCAL) }), // wikipedia's local-store column
    ]);
    expect(verdict).toMatchObject({ action: "PUBLISH", rule: "G2" });
    expect(verdict.date).toEqual(exact(LOCAL));
  });

  it("corrects an already-published early date by the one-week gap, without tripping the large-shift flag", () => {
    // Set 13 was published at the local-store date. The corrected claim is 7 days
    // later, inside GATE_THRESHOLDS.largeShiftDays.
    const verdict = gate(
      [claim({ origin: "retailerA", date: exact(WIDE) }), claim({ origin: "communityA", date: exact(WIDE) })],
      publishedAt(LOCAL, "RUMORED"),
    );
    expect(verdict.action).toBe("PUBLISH");
    expect(verdict.date).toEqual(exact(WIDE));
    expect(GATE_THRESHOLDS.largeShiftDays).toBeGreaterThan(7);
  });

  it("still flags rather than publishes if TCGplayer ever lists the set at its wide date", () => {
    // +7 days on a date that was already the wide one lands a week after
    // Wikipedia's, so the two disagree and the gate holds -- the safety net the
    // shelf-claim offset relies on.
    const verdict = gate(
      [
        claim({ origin: "retailerA", date: exact("2026-10-30T00:00:00.000Z"), consecutiveRuns: 1 }),
        claim({ origin: "communityA", date: exact(WIDE) }),
      ],
      publishedAt(WIDE, "CONFIRMED"),
    );
    expect(verdict.action).not.toBe("PUBLISH");
    expect(verdict.date).toEqual(exact(WIDE));
  });
});

// ---------------------------------------------------------------------------
// G6 does not fire when an exact date narrows a published window
// ---------------------------------------------------------------------------

describe("an exact date inside a published window is a refinement, not a large shift", () => {
  const QUARTER: CandidateDate = {
    kind: "WINDOW",
    granularity: "QUARTER",
    start: new Date("2026-10-01T00:00:00.000Z"),
    end: new Date("2026-12-31T00:00:00.000Z"),
  };
  const twoAgreeing = (iso: string) => [
    claim({ origin: "retailerA", date: exact(iso) }),
    claim({ origin: "communityA", date: exact(iso) }),
  ];

  it("publishes 2026-10-16 over 'Q4 2026' even though it is 15 days from the window's first day", () => {
    // Lorcana's Hyperia City prerelease: held at "Q4" behind a LARGE_SHIFT review
    // item while the real date sat unpublished.
    const verdict = gate(twoAgreeing("2026-10-16T00:00:00.000Z"), { date: QUARTER, status: "RUMORED" });
    expect(verdict.action).toBe("PUBLISH");
    expect(verdict.date).toEqual(exact("2026-10-16T00:00:00.000Z"));
  });

  it("accepts the window's own first and last days", () => {
    for (const iso of ["2026-10-01T00:00:00.000Z", "2026-12-31T00:00:00.000Z"]) {
      expect(gate(twoAgreeing(iso), { date: QUARTER, status: "RUMORED" }).action, iso).toBe("PUBLISH");
    }
  });

  it("still flags a date well outside the window, which is a genuine move", () => {
    const verdict = gate(twoAgreeing("2027-02-05T00:00:00.000Z"), { date: QUARTER, status: "RUMORED" });
    expect(verdict.action).toBe("FLAG");
    expect(verdict.reason).toBe("LARGE_SHIFT");
  });

  it("still flags a date one day past the window's end", () => {
    const verdict = gate(twoAgreeing("2027-01-20T00:00:00.000Z"), { date: QUARTER, status: "RUMORED" });
    expect(verdict.action).toBe("FLAG");
  });

  it("does not extend to a published EXACT date, which has no window to narrow", () => {
    const verdict = gate(twoAgreeing("2026-10-23T00:00:00.000Z"), publishedAt("2026-09-20T00:00:00.000Z"));
    expect(verdict.action).toBe("FLAG");
  });

  it("applies to a published RANGE as well", () => {
    const range: CandidateDate = {
      kind: "RANGE",
      start: new Date("2026-10-01T00:00:00.000Z"),
      end: new Date("2026-11-30T00:00:00.000Z"),
    };
    expect(gate(twoAgreeing("2026-11-25T00:00:00.000Z"), { date: range, status: "ANNOUNCED" }).action).toBe("PUBLISH");
  });
});

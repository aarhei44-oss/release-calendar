import type { ReleaseStatus, SourceDisposition } from "@/app/generated/prisma/client";
import { computeConfidenceAndStatus, type ClaimForConfidence } from "@/lib/crawler/confidence";
import {
  ORIGINS,
  dateGapDays,
  datesAgreeWithin,
  daysBetween,
  hasDate,
  originsAreIndependent,
  primaryDate,
  serializeDate,
  tierRank,
  type CandidateDate,
  type ClaimRecord,
  type GateRule,
  type Origin,
  type OriginRegistry,
  type PublishedState,
  type ReviewDetail,
  type Verdict,
  type VerdictReason,
} from "./types";

/**
 * The gate: given everything known about one release event, decide what the
 * calendar should show.
 *
 * This is the module the whole v2 rebuild exists for. The v1 crawler decided
 * visibility by accumulating a confidence float and comparing it to a
 * threshold, which meant "why is this date showing?" had no answer better than
 * "0.62 > 0.6" -- and worse, that a pile of low-quality agreement could
 * outvote a single authoritative correction, and that whichever source
 * happened to run last silently won a disagreement.
 *
 * Here, visibility is decided by named rules (G1..G7) with explicit
 * thresholds, and confidence is computed but demoted to a display and
 * review-ranking signal. Every verdict names the rule that produced it.
 *
 * Two properties are structural, not incidental:
 *
 *  - It is a pure function. No I/O, no imports that reach a database, and no
 *    reads of the system clock: `now` is an input. That is what makes replay
 *    (lib/ingest/replay.ts) meaningful -- re-running a stored run with a
 *    changed rule set gives a deterministic, diffable answer.
 *  - It never deletes or archives anything. The strongest thing it can say
 *    about a release that vanished from every source is CANCELLED (G7). A
 *    pipeline that can make user-visible history disappear on a scraping
 *    glitch is worse than one that occasionally holds a stale date.
 */

/**
 * Every tunable number the gate uses, in one place, because these are
 * judgement calls about the TCG release world rather than facts:
 *
 *  - agreementDays: release dates get restated with a day or two of slop
 *    across time zones and "street date vs. ship date" conventions. Three days
 *    absorbs that without absorbing a genuine one-week delay.
 *  - retailerCorroborationRuns: retailer listings routinely carry placeholder
 *    dates (end-of-month, end-of-quarter) that get corrected within a few
 *    days. Requiring the same date across seven consecutive runs outlives the
 *    placeholder churn without waiting so long that real dates arrive late.
 *  - largeShiftDays: publishers announce delays. A date that moves more than
 *    two weeks with nobody saying anything is far more likely to be a parsing
 *    or identity error than a real schedule change.
 *  - absenceCancelDays: sources drop rows for boring reasons (a site redesign,
 *    a paginated list we stopped following). Two weeks of every source
 *    agreeing that a product no longer exists is a real signal; two days is
 *    an outage.
 */
export const GATE_THRESHOLDS = {
  /** Max distance, in days, at which two dates count as the same date. */
  agreementDays: 3,
  /** Consecutive runs an unchanged lone RETAILER claim must survive before it publishes. */
  retailerCorroborationRuns: 7,
  /** A published date moving further than this, in days, is flagged rather than applied. */
  largeShiftDays: 14,
  /** Days of unanimous absence before a still-future event is cancelled. */
  absenceCancelDays: 14,
} as const;

const DEFAULT_CONFIDENCE_WEIGHT = 0.8;

export type GateInput = {
  /** Injected rather than read from Date.now() so every rule is testable at an exact boundary. */
  now: Date;
  /** Every claim on record for this event, including ones this run did not observe (G7 needs those). */
  claims: ClaimRecord[];
  /** What the event currently shows, or null for an event that has never published a date. */
  published: PublishedState | null;
  /** Defaults to the production ORIGINS; tests and later phases can substitute their own lineage. */
  origins?: OriginRegistry;
};

/** One way the evidence could justify publishing a date, before conflict and shift checks. */
type Proposal = {
  rule: Extract<GateRule, "G1" | "G2" | "G3">;
  date: CandidateDate;
  /** The claims that back it; their union across proposals is the "qualifying" set G5 examines. */
  claims: ClaimRecord[];
  /** Tier of the claim whose date was taken -- the tiebreak when several proposals stand. */
  tier: ClaimRecord["tier"];
};

export function evaluateGate(input: GateInput): Verdict {
  const registry = input.origins ?? ORIGINS;
  const { claims, published, now } = input;

  const live = claims.filter((claim) => claim.seenInCurrentRun);

  // -------------------------------------------------------------------------
  // G7 -- absence. Checked first because with nothing observed this run there
  // is no evidence for any other rule to weigh. Absence is never allowed to
  // unpublish: the event keeps its date and, at worst, gains a CANCELLED
  // status. There is deliberately no branch below that deletes or archives.
  // -------------------------------------------------------------------------
  if (live.length === 0) {
    return absenceVerdict(claims, published, now);
  }

  const dated = live.filter((claim) => hasDate(claim.date));

  // Claims exist but none states a date (every source says "TBD"/"coming
  // soon"). Nothing to publish, nothing to dispute -- hold whatever is
  // already showing.
  if (dated.length === 0) {
    return holdVerdict(claims, published, "NONE", "NO_DATED_CLAIMS", []);
  }

  // -------------------------------------------------------------------------
  // G4 -- SPECULATIVE tier never publishes a date. Rumour-tier sources exist
  // to tell us a product is coming at all, which is genuinely useful; they are
  // simply not allowed to put a number on the calendar. Filtered out here
  // rather than given a low weight, because a weight is something enough
  // agreement can overcome and this must not be overcomable.
  // -------------------------------------------------------------------------
  const eligible = dated.filter((claim) => claim.tier !== "SPECULATIVE");
  if (eligible.length === 0) {
    // A speculative claim may still corroborate (or create) a *dateless*
    // RUMORED event -- that is the one thing G4 does allow. holdVerdict
    // already defaults an event with nothing published to RUMORED, which is
    // exactly that dateless rumour.
    const verdict = holdVerdict(claims, published, "G4", "SPECULATIVE_ONLY", []);
    verdict.supportingOrigins = dedupeOrigins(dated.map((claim) => claim.origin));
    return verdict;
  }

  // A claim is contradicted when some *other* origin, this run, states a date
  // outside the agreement window. Speculative claims are excluded from
  // contradicting: G4 already says rumour tier cannot set a date, and letting
  // it veto instead would just be the same power wearing a different hat --
  // one rumour site could then hold a well-corroborated retailer date hostage
  // indefinitely.
  const contradictors = eligible;
  const isContradicted = (claim: ClaimRecord): boolean =>
    contradictors.some(
      (other) =>
        other.origin !== claim.origin && !datesAgreeWithin(other.date, claim.date, GATE_THRESHOLDS.agreementDays),
    );

  // Surfaced to Apply so the G3 streak counter is zeroed in the database.
  // Without this, a retailer date that is disputed for six runs and then
  // briefly un-disputed would publish on the strength of a streak it never
  // actually held.
  const streakResets = eligible.filter(isContradicted).map((claim) => claim.origin);

  const proposals: Proposal[] = [];

  // ----- G1: a single OFFICIAL-tier claim is enough. -----
  for (const claim of eligible) {
    if (claim.tier === "OFFICIAL") {
      proposals.push({ rule: "G1", date: claim.date, claims: [claim], tier: claim.tier });
    }
  }

  // ----- G2: two independent origins agreeing within the agreement window. -----
  for (let i = 0; i < eligible.length; i++) {
    for (let j = i + 1; j < eligible.length; j++) {
      const a = eligible[i];
      const b = eligible[j];
      if (!originsAreIndependent(a.origin, b.origin, registry)) continue;
      if (!datesAgreeWithin(a.date, b.date, GATE_THRESHOLDS.agreementDays)) continue;
      // "Published date = the higher-tier claim's": the two agree to within
      // three days, so this only picks which of two near-identical dates to
      // show, and the more authoritative source should win that.
      const preferred = tierRank(a.tier) <= tierRank(b.tier) ? a : b;
      proposals.push({ rule: "G2", date: preferred.date, claims: [a, b], tier: preferred.tier });
    }
  }

  // ----- G3: a lone RETAILER claim, unchanged and unchallenged for long enough. -----
  for (const claim of eligible) {
    if (claim.tier !== "RETAILER") continue;
    if (isContradicted(claim)) continue;
    if (claim.consecutiveRuns < GATE_THRESHOLDS.retailerCorroborationRuns) continue;
    proposals.push({ rule: "G3", date: claim.date, claims: [claim], tier: claim.tier });
  }

  if (proposals.length === 0) {
    // Evidence exists but no rule is satisfied. Distinguish "nobody has
    // corroborated it yet" from "somebody actively disagrees", because those
    // want different follow-up.
    const reason: VerdictReason = eligible.some(isContradicted) ? "CONTRADICTED" : "AWAITING_CORROBORATION";
    return holdVerdict(claims, published, "NONE", reason, streakResets);
  }

  // -------------------------------------------------------------------------
  // G5 -- conflict. Every claim participating in a proposal has, on its own,
  // earned the right to set the date. If two of them disagree by more than the
  // agreement window, there is no honest way to pick between them: recency
  // would mean whichever provider happened to run last wins, and tier would
  // mean a stale official page beats a corrected retailer feed. So the gate
  // refuses, holds what is already published, and asks a human.
  //
  // Note this is scoped to *qualifying* claims. A lone unqualified outlier --
  // one community site with a wrong date and no corroboration -- does not get
  // to block an otherwise clean publish; it simply never qualified.
  // -------------------------------------------------------------------------
  const qualifying = dedupeClaims(proposals.flatMap((proposal) => proposal.claims));
  const widestGap = widestGapDays(qualifying);
  if (widestGap !== null && widestGap > GATE_THRESHOLDS.agreementDays) {
    return flagVerdict(claims, published, "G5", "CONFLICT", "CONFLICT", {
      proposedDate: null,
      gapDays: widestGap,
      streakResets,
    });
  }

  const winner = pickProposal(proposals);

  // -------------------------------------------------------------------------
  // G6 -- large shift. Fires even when every origin agrees, which is the whole
  // point: unanimous agreement on a date fourteen days from the one we were
  // showing is exactly what an identity mix-up looks like (two products merged
  // into one event), and it is also what a real but unannounced delay looks
  // like. Both deserve a human glance before the calendar moves.
  // -------------------------------------------------------------------------
  const shift = published ? dateGapDays(published.date, winner.date) : null;
  if (shift !== null && shift > GATE_THRESHOLDS.largeShiftDays) {
    return flagVerdict(claims, published, "G6", "LARGE_SHIFT", "LARGE_SHIFT", {
      proposedDate: winner.date,
      gapDays: shift,
      streakResets,
    });
  }

  const supportingOrigins = dedupeOrigins(winner.claims.map((claim) => claim.origin));
  const { confidence, status } = scoreClaims(claims, winner.date);
  return {
    action: "PUBLISH",
    rule: winner.rule,
    reason: reasonForRule(winner.rule),
    date: winner.date,
    status,
    confidence,
    review: null,
    streakResets,
    supportingOrigins,
  };
}

// ---------------------------------------------------------------------------
// Rule G7's body, split out only for readability.
// ---------------------------------------------------------------------------

function absenceVerdict(claims: ClaimRecord[], published: PublishedState | null, now: Date): Verdict {
  const { confidence, status: derivedStatus } = scoreClaims(claims, published?.date ?? null);
  const heldStatus = published?.status ?? derivedStatus;

  const lastSeenAt = claims.reduce<Date | null>(
    (latest, claim) => (latest === null || claim.lastSeenAt > latest ? claim.lastSeenAt : latest),
    null,
  );
  const daysAbsent = lastSeenAt ? daysBetween(lastSeenAt, now) : 0;

  // Only a *future* event can be cancelled by absence. A release whose date
  // has already passed and which then drops off its source pages has simply
  // shipped and been archived upstream -- that is the normal end of a
  // product's life, not a cancellation, and marking it CANCELLED would rewrite
  // correct history for every set we have ever tracked. The release lifecycle
  // pass owns the past-dated case.
  const publishedDate = published?.date ?? null;
  const anchor = primaryDate(publishedDate);
  const isFuture = anchor === null || anchor.getTime() > now.getTime();

  const cancels =
    isFuture && claims.length > 0 && daysAbsent >= GATE_THRESHOLDS.absenceCancelDays && heldStatus !== "CANCELLED";

  return {
    action: "STALE",
    rule: "G7",
    reason: cancels ? "ABSENT_CANCELLED" : "ABSENT",
    // Unchanged either way. Absence never unpublishes.
    date: publishedDate,
    status: cancels ? "CANCELLED" : heldStatus,
    confidence,
    review: null,
    streakResets: [],
    supportingOrigins: [],
  };
}

// ---------------------------------------------------------------------------
// Verdict constructors
// ---------------------------------------------------------------------------

/** Hold the currently published value with no review item: the gate is simply not persuaded yet. */
function holdVerdict(
  claims: ClaimRecord[],
  published: PublishedState | null,
  rule: GateRule,
  reason: VerdictReason,
  streakResets: Origin[],
): Verdict {
  const { confidence } = scoreClaims(claims, published?.date ?? null);
  return {
    action: "HOLD",
    rule,
    reason,
    date: published?.date ?? null,
    status: published?.status ?? "RUMORED",
    confidence,
    review: null,
    streakResets,
    supportingOrigins: [],
  };
}

/**
 * Hold the currently published value *and* open a review item. FLAG is a
 * strictly stronger HOLD: the difference is that somebody is expected to look
 * at it, and until they do the event keeps showing what it showed before.
 */
function flagVerdict(
  claims: ClaimRecord[],
  published: PublishedState | null,
  rule: GateRule,
  reason: VerdictReason,
  reviewReason: "CONFLICT" | "LARGE_SHIFT",
  extra: { proposedDate: CandidateDate | null; gapDays: number | null; streakResets: Origin[] },
): Verdict {
  const { confidence } = scoreClaims(claims, published?.date ?? null);
  const detail: ReviewDetail = {
    publishedDate: serializeDate(published?.date ?? null),
    proposedDate: serializeDate(extra.proposedDate),
    gapDays: extra.gapDays,
    claims: claims.map((claim) => ({
      origin: claim.origin,
      tier: claim.tier,
      date: serializeDate(claim.date) ?? { kind: "TBD" },
      consecutiveRuns: claim.consecutiveRuns,
      seenInCurrentRun: claim.seenInCurrentRun,
      lastSeenAt: claim.lastSeenAt.toISOString(),
      ...(claim.url ? { url: claim.url } : {}),
    })),
  };

  return {
    action: "FLAG",
    rule,
    reason,
    date: published?.date ?? null,
    status: published?.status ?? "RUMORED",
    confidence,
    review: { reason: reviewReason, detail },
    streakResets: extra.streakResets,
    supportingOrigins: [],
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function reasonForRule(rule: Proposal["rule"]): VerdictReason {
  switch (rule) {
    case "G1":
      return "OFFICIAL_SINGLE";
    case "G2":
      return "INDEPENDENT_AGREEMENT";
    case "G3":
      return "RETAILER_STREAK";
  }
}

const RULE_PRIORITY: Record<Proposal["rule"], number> = { G1: 0, G2: 1, G3: 2 };

/**
 * Picks between surviving proposals. Only reached once G5 has established that
 * they all agree to within the agreement window, so this is choosing which of
 * several near-identical dates to display, never resolving a dispute.
 *
 * Ordering is total and deterministic -- rule strength, then tier, then the
 * claim that has held still longest, then origin key alphabetically. The last
 * tiebreak exists purely so the same inputs always produce the same output on
 * replay; nothing about it is meaningful.
 */
function pickProposal(proposals: Proposal[]): Proposal {
  return [...proposals].sort((a, b) => {
    const byRule = RULE_PRIORITY[a.rule] - RULE_PRIORITY[b.rule];
    if (byRule !== 0) return byRule;
    const byTier = tierRank(a.tier) - tierRank(b.tier);
    if (byTier !== 0) return byTier;
    const byRuns = maxRuns(b.claims) - maxRuns(a.claims);
    if (byRuns !== 0) return byRuns;
    return sortKey(a).localeCompare(sortKey(b));
  })[0];
}

function maxRuns(claims: ClaimRecord[]): number {
  return claims.reduce((max, claim) => Math.max(max, claim.consecutiveRuns), 0);
}

function sortKey(proposal: Proposal): string {
  return [...proposal.claims.map((claim) => claim.origin)].sort().join("|");
}

function dedupeClaims(claims: ClaimRecord[]): ClaimRecord[] {
  const seen = new Set<ClaimRecord>();
  const out: ClaimRecord[] = [];
  for (const claim of claims) {
    if (seen.has(claim)) continue;
    seen.add(claim);
    out.push(claim);
  }
  return out;
}

function dedupeOrigins(origins: Origin[]): Origin[] {
  return [...new Set(origins)];
}

/** Largest pairwise distance among a set of claims' dates, or null when fewer than two carry one. */
function widestGapDays(claims: ClaimRecord[]): number | null {
  let widest: number | null = null;
  for (let i = 0; i < claims.length; i++) {
    for (let j = i + 1; j < claims.length; j++) {
      const gap = dateGapDays(claims[i].date, claims[j].date);
      if (gap === null) continue;
      if (widest === null || gap > widest) widest = gap;
    }
  }
  return widest;
}

/**
 * Confidence and the CONFIRMED/ANNOUNCED/RUMORED label, reusing v1's
 * noisy-OR scoring (lib/crawler/confidence.ts) unchanged so the number means
 * the same thing on both pipelines while they coexist.
 *
 * Dispositions are derived here rather than stored, against whichever date the
 * verdict settled on, and using the *gate's* agreement window (3 days) rather
 * than v1's dedup proximity window (14 days) -- inside the gate, "agrees with
 * the published date" has to mean the same thing everywhere or the score would
 * quietly disagree with the rule that produced it.
 *
 * The returned status is only ever used for a PUBLISH verdict; every other
 * verdict holds the status the event already had. This is the boundary that
 * keeps confidence out of the visibility decision.
 */
function scoreClaims(
  claims: ClaimRecord[],
  settledDate: CandidateDate | null,
): { confidence: number; status: ReleaseStatus } {
  const forConfidence: ClaimForConfidence[] = claims.map((claim) => ({
    tier: claim.tier,
    disposition: dispositionAgainst(claim.date, settledDate),
    confidenceWeight: claim.confidenceWeight ?? DEFAULT_CONFIDENCE_WEIGHT,
  }));
  return computeConfidenceAndStatus(forConfidence);
}

function dispositionAgainst(claimDate: CandidateDate, settledDate: CandidateDate | null): SourceDisposition {
  if (!settledDate || !hasDate(settledDate) || !hasDate(claimDate)) return "SUPPORTS";
  return datesAgreeWithin(claimDate, settledDate, GATE_THRESHOLDS.agreementDays) ? "SUPPORTS" : "CONTRADICTS";
}

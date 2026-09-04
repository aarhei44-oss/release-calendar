import type {
  DateType,
  ProviderStatus,
  Region,
  ReleaseEventType,
  ReleaseStatus,
  ReviewReason,
  SourceTier,
  VerdictAction,
  WindowGranularity,
} from "@/app/generated/prisma/client";

/**
 * Canonical shared vocabulary for the v2 ingest pipeline (lib/ingest/*).
 *
 * The pipeline is six stages -- Fetch, Normalize, Identity, Gate, Apply,
 * Diff -- of which only Fetch touches the network. Everything downstream is a
 * pure function of stored bytes, which is the whole reason RawPayload exists:
 * a parser bug or a gate-rule change can be re-run against yesterday's
 * responses without asking the upstream site anything (see lib/ingest/replay.ts).
 *
 * These types are deliberately kept free of Prisma row shapes. The gate in
 * particular must be callable from a test with hand-written literals and no
 * database, so it takes plain records like ClaimRecord rather than
 * `Prisma.SourceClaimGetPayload<...>`.
 */

// ---------------------------------------------------------------------------
// Origins
// ---------------------------------------------------------------------------

/**
 * A key into an OriginRegistry. Left as a plain string alias rather than a
 * union over ORIGINS so that tests (and later phases' providers) can declare
 * their own registries -- the gate never hardcodes ORIGINS, it takes whichever
 * registry it is handed.
 */
export type Origin = string;

export type OriginDescriptor = {
  key: Origin;
  tier: SourceTier;
  /**
   * The origin this one republishes, when it is not a primary source.
   *
   * This field is load-bearing for gate rule G2 (two independent origins
   * agreeing publishes a date). Two sites agreeing means nothing if one of
   * them is just mirroring the other's feed -- that is one source with two
   * URLs, and treating it as corroboration is exactly how a single upstream
   * typo becomes a "confirmed" release date. Declared explicitly rather than
   * inferred, because there is no way to detect a mirror from its output.
   */
  derivesFrom: Origin | null;
};

export type OriginRegistry = Readonly<Record<Origin, OriginDescriptor>>;

/**
 * The production origin registry.
 *
 * Providers themselves land in phase 2; what is declared here is the *lineage*
 * the gate reasons about, which is a property of the upstream data world and
 * not of our code. Publishers are OFFICIAL primaries with no ancestor;
 * community databases that mirror a publisher's own data declare that
 * ancestry, so that (say) Scryfall agreeing with Wizards is correctly read as
 * one source rather than two.
 */
export const ORIGINS = {
  "pokemon-official": { key: "pokemon-official", tier: "OFFICIAL", derivesFrom: null },
  "wizards-official": { key: "wizards-official", tier: "OFFICIAL", derivesFrom: null },
  "konami-official": { key: "konami-official", tier: "OFFICIAL", derivesFrom: null },
  "ravensburger-official": { key: "ravensburger-official", tier: "OFFICIAL", derivesFrom: null },
  "bandai-official": { key: "bandai-official", tier: "OFFICIAL", derivesFrom: null },
  "riot-official": { key: "riot-official", tier: "OFFICIAL", derivesFrom: null },

  // Scryfall's set data is sourced from Wizards' own Gatherer/product pages;
  // it is an excellent provider (structured, reliable, fast) but it is not an
  // independent observation of a release date.
  scryfall: { key: "scryfall", tier: "COMMUNITY", derivesFrom: "wizards-official" },
  // Likewise YGOPRODeck relative to Konami's database.
  ygoprodeck: { key: "ygoprodeck", tier: "COMMUNITY", derivesFrom: "konami-official" },

  // Retailers list what they have been told they can sell and when, which is
  // real independent evidence of a street date -- and also the source most
  // prone to placeholder dates, hence gate rule G3.
  tcgplayer: { key: "tcgplayer", tier: "RETAILER", derivesFrom: null },

  wikipedia: { key: "wikipedia", tier: "COMMUNITY", derivesFrom: null },
} as const satisfies OriginRegistry;

export type KnownOrigin = keyof typeof ORIGINS;

/**
 * Every origin this one transitively republishes, starting with itself.
 * Cycle-safe: a misdeclared registry that loops (a derivesFrom b derivesFrom
 * a) terminates instead of hanging the gate.
 */
export function originLineage(origin: Origin, registry: OriginRegistry): Origin[] {
  const chain: Origin[] = [];
  const seen = new Set<Origin>();
  let current: Origin | null = origin;
  while (current && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    current = registry[current]?.derivesFrom ?? null;
  }
  return chain;
}

/**
 * Whether two origins count as separate observations for gate rule G2.
 *
 * Independence fails when the two lineages intersect at all -- not only when
 * one derives from the other. A shared *ancestor* correlates two origins just
 * as thoroughly as a direct mirror does (two community databases both
 * rebuilding from the same publisher feed will agree on that feed's mistakes
 * with perfect reliability), and the gate's job is to be wrong in the
 * conservative direction, so a common root disqualifies the pair too.
 */
export function originsAreIndependent(a: Origin, b: Origin, registry: OriginRegistry): boolean {
  if (a === b) return false;
  const lineageA = new Set(originLineage(a, registry));
  for (const ancestor of originLineage(b, registry)) {
    if (lineageA.has(ancestor)) return false;
  }
  return true;
}

/** Tier ordering, most authoritative first, for "publish the higher-tier claim's date". */
const TIER_RANK: Record<SourceTier, number> = {
  OFFICIAL: 0,
  RETAILER: 1,
  COMMUNITY: 2,
  SPECULATIVE: 3,
};

export function tierRank(tier: SourceTier): number {
  return TIER_RANK[tier];
}

// ---------------------------------------------------------------------------
// Stage 1 output: raw payloads
// ---------------------------------------------------------------------------

export type RawPayloadRecord = {
  scanRunId: string;
  providerKey: string;
  /** SHA-256 of the *uncompressed* body -- comparable across runs even for providers that send no ETag. */
  contentHash: string;
  /**
   * gzipped JSON (node:zlib). Empty for a NOT_MODIFIED or FAILED fetch, where
   * there is no new body: the ProviderRun row still gets written so the
   * attempt is on the record and retryRun can find it.
   */
  // Typed with an explicit ArrayBuffer parameter to match what Prisma's Bytes
  // column accepts: a bare `Uint8Array` widens to `ArrayBufferLike`, which
  // includes SharedArrayBuffer and is rejected at the write.
  body: Uint8Array<ArrayBuffer>;
  fetchedAt: Date;
  status: ProviderStatus;
  etag?: string | null;
  error?: string | null;
};

// ---------------------------------------------------------------------------
// Stage 2 output: candidates
// ---------------------------------------------------------------------------

/**
 * A date as a provider stated it, mirroring the DateType enum. A discriminated
 * union rather than the DB's flat nullable columns so that "EXACT with no
 * dateExact" is unrepresentable rather than merely unlikely.
 */
export type CandidateDate =
  | { kind: "EXACT"; date: Date }
  | { kind: "RANGE"; start: Date; end: Date }
  | { kind: "WINDOW"; granularity: WindowGranularity; start: Date; end: Date }
  | { kind: "TBD" };

export type Candidate = {
  origin: Origin;
  /**
   * The TcgProfilePackage slug this candidate belongs to.
   *
   * Not in the original stage sketch, but the pipeline cannot place a
   * candidate without it: a single provider (a retailer, say) covers several
   * games at once, so "which provider produced this" does not answer "which
   * install owns it", and identity matching has to be scoped per install or
   * two games' catalogues start name-matching against each other.
   */
  game: string;
  /**
   * Every upstream id this candidate carries, keyed by the origin that owns
   * the id space. A provider usually knows its own id and sometimes knows a
   * sibling's (e.g. a retailer listing that cites a publisher SKU) -- each one
   * is a chance for identity.ts to pin the candidate exactly instead of
   * guessing from its name.
   */
  externalIds: Record<Origin, string>;
  name: string;
  code: string | null;
  date: CandidateDate;
  region: Region;
  type: ReleaseEventType;
  /** The page this was read from, carried through to SourceClaim.url. */
  url?: string;
  description?: string;
};

// ---------------------------------------------------------------------------
// Stage 3 output: resolved candidates
// ---------------------------------------------------------------------------

export type MatchedBy = "id" | "name" | "new";

export type IdentityResolution = {
  productSetId: string | null;
  matchedBy: MatchedBy;
  /** Which origin's external id produced an "id" match, for debugging a bad pin. */
  matchedOrigin?: Origin;
  /** Name-similarity score for a "name" match, so a marginal match is auditable. */
  score?: number;
};

export type ResolvedCandidate = Candidate & {
  resolution: IdentityResolution;
  tier: SourceTier;
};

// ---------------------------------------------------------------------------
// Stage 4 input/output: claims and verdicts
// ---------------------------------------------------------------------------

/**
 * One origin's standing claim about a single release event, as the gate sees
 * it. Assembled by Apply from stored SourceClaims plus this run's candidates;
 * the gate never queries for it.
 */
export type ClaimRecord = {
  origin: Origin;
  tier: SourceTier;
  date: CandidateDate;
  /**
   * How many consecutive runs this origin has reported this same date. 1 on
   * first sight. Consumed by gate rule G3 (a lone retailer date has to hold
   * still for a while before it is trusted); reset to 0 by Apply whenever the
   * gate reports the claim as contradicted.
   */
  consecutiveRuns: number;
  /** Whether this run actually observed the claim -- the input to rule G7. */
  seenInCurrentRun: boolean;
  lastSeenAt: Date;
  /** Per-claim quality multiplier fed to computeConfidenceAndStatus; defaults to 0.8. */
  confidenceWeight?: number;
  url?: string;
};

/** What the event currently shows to users, before this run's verdict. */
export type PublishedState = {
  date: CandidateDate | null;
  status: ReleaseStatus;
};

export type GateRule = "G1" | "G2" | "G3" | "G4" | "G5" | "G6" | "G7" | "NONE";

/**
 * Machine-readable "why". Deliberately finer-grained than GateRule: two
 * different situations can both land on HOLD, and the review queue needs to
 * tell "nobody has corroborated this yet" apart from "somebody actively
 * disagrees".
 */
export type VerdictReason =
  /** G1: an official source said so. */
  | "OFFICIAL_SINGLE"
  /** G2: two independent origins agree. */
  | "INDEPENDENT_AGREEMENT"
  /** G3: a lone retailer date that has held still long enough. */
  | "RETAILER_STREAK"
  /** G4: the only dated evidence is speculative, so no date is published. */
  | "SPECULATIVE_ONLY"
  /** G5: qualifying claims disagree beyond the agreement window. */
  | "CONFLICT"
  /** G6: the agreed date moved further than a release date plausibly moves unannounced. */
  | "LARGE_SHIFT"
  /** G7: nobody reported it this run, but not for long enough to mean anything. */
  | "ABSENT"
  /** G7: absent long enough, and its date is still ahead of us -- treat as cancelled. */
  | "ABSENT_CANCELLED"
  /** Evidence exists but no rule is satisfied yet. */
  | "AWAITING_CORROBORATION"
  /** A would-be qualifier is disputed, so it does not qualify. */
  | "CONTRADICTED"
  /** Claims exist but none of them states a date. */
  | "NO_DATED_CLAIMS";

/** JSON-safe rendering of a CandidateDate, for ReviewItem.detail and RunDiff.changes. */
export type SerializedDate =
  | { kind: "EXACT"; date: string }
  | { kind: "RANGE"; start: string; end: string }
  | { kind: "WINDOW"; granularity: WindowGranularity; start: string; end: string }
  | { kind: "TBD" };

export type ReviewDetail = {
  publishedDate: SerializedDate | null;
  proposedDate: SerializedDate | null;
  /** The largest disagreement, in days, among the claims that triggered this. */
  gapDays: number | null;
  claims: Array<{
    origin: Origin;
    tier: SourceTier;
    date: SerializedDate;
    consecutiveRuns: number;
    seenInCurrentRun: boolean;
    lastSeenAt: string;
    url?: string;
  }>;
};

export type Verdict = {
  action: VerdictAction;
  rule: GateRule;
  reason: VerdictReason;
  /**
   * The date the event should carry once this verdict is applied. For HOLD,
   * FLAG and STALE this is the *previously published* value unchanged -- the
   * gate expresses "don't move it" by restating it, so Apply never has to
   * re-derive what holding means.
   */
  date: CandidateDate | null;
  status: ReleaseStatus;
  /**
   * Display + review-ranking signal only. Deliberately not an input to any
   * rule above: visibility is decided by the rules, so that "why is this
   * showing" always has an answer more specific than a float crossing a line.
   */
  confidence: number;
  /** Non-null exactly when action is FLAG. */
  review: { reason: ReviewReason; detail: ReviewDetail } | null;
  /** Origins whose G3 corroboration streak Apply should zero, because this run contradicted them. */
  streakResets: Origin[];
  /** Origins whose claims backed the published date, for the run diff. */
  supportingOrigins: Origin[];
};

// ---------------------------------------------------------------------------
// Stage 6 output: the run diff
// ---------------------------------------------------------------------------

export type RunDiffChange = {
  releaseEventId: string;
  productSetId: string;
  action: VerdictAction;
  rule: GateRule;
  reason: VerdictReason;
  before: SerializedDate | null;
  after: SerializedDate | null;
  statusBefore: ReleaseStatus | null;
  statusAfter: ReleaseStatus;
};

export type RunDiff = {
  scanRunId: string;
  changes: RunDiffChange[];
};

// ---------------------------------------------------------------------------
// Date helpers
//
// Shared by the gate, identity and apply so that "how far apart are these two
// dates" has exactly one answer across the pipeline.
// ---------------------------------------------------------------------------

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The single point on the calendar a CandidateDate is anchored to, for
 * distance comparisons. A RANGE/WINDOW compares by its start: a month-window
 * and an exact date inside that month are talking about the same release, and
 * anchoring on the start keeps the comparison stable as a window narrows.
 */
export function primaryDate(date: CandidateDate | null | undefined): Date | null {
  if (!date) return null;
  switch (date.kind) {
    case "EXACT":
      return date.date;
    case "RANGE":
    case "WINDOW":
      return date.start;
    case "TBD":
      return null;
  }
}

/** Absolute distance in whole-ish days, or null when either side has no date at all. */
export function dateGapDays(a: CandidateDate | null, b: CandidateDate | null): number | null {
  const left = primaryDate(a);
  const right = primaryDate(b);
  if (!left || !right) return null;
  return Math.abs(left.getTime() - right.getTime()) / MS_PER_DAY;
}

/** True when both sides carry a date and they sit within `days` of each other (inclusive). */
export function datesAgreeWithin(a: CandidateDate | null, b: CandidateDate | null, days: number): boolean {
  const gap = dateGapDays(a, b);
  return gap !== null && gap <= days;
}

export function daysBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / MS_PER_DAY;
}

export function hasDate(date: CandidateDate | null | undefined): boolean {
  return primaryDate(date) !== null;
}

export function serializeDate(date: CandidateDate | null): SerializedDate | null {
  if (!date) return null;
  switch (date.kind) {
    case "EXACT":
      return { kind: "EXACT", date: date.date.toISOString() };
    case "RANGE":
      return { kind: "RANGE", start: date.start.toISOString(), end: date.end.toISOString() };
    case "WINDOW":
      return {
        kind: "WINDOW",
        granularity: date.granularity,
        start: date.start.toISOString(),
        end: date.end.toISOString(),
      };
    case "TBD":
      return { kind: "TBD" };
  }
}

export type EventDateColumns = {
  dateType: DateType;
  dateExact: Date | null;
  dateStart: Date | null;
  dateEnd: Date | null;
  windowGranularity: WindowGranularity | null;
  windowStart: Date | null;
  windowEnd: Date | null;
};

/**
 * Flattens a CandidateDate onto ReleaseEvent's columns. Every branch nulls the
 * other branches' columns explicitly, for the same reason v1's
 * orchestrate.toDateInfo does: Prisma only writes the fields it is given, so a
 * date that changes kind would otherwise keep stale values from its old kind
 * sitting beside its new dateType forever.
 */
export function toEventDateColumns(date: CandidateDate | null): EventDateColumns {
  const empty: EventDateColumns = {
    dateType: "TBD",
    dateExact: null,
    dateStart: null,
    dateEnd: null,
    windowGranularity: null,
    windowStart: null,
    windowEnd: null,
  };
  if (!date) return empty;
  switch (date.kind) {
    case "EXACT":
      return { ...empty, dateType: "EXACT", dateExact: date.date };
    case "RANGE":
      return { ...empty, dateType: "RANGE", dateStart: date.start, dateEnd: date.end };
    case "WINDOW":
      return {
        ...empty,
        dateType: "WINDOW",
        windowGranularity: date.granularity,
        windowStart: date.start,
        windowEnd: date.end,
      };
    case "TBD":
      return empty;
  }
}

/** Inverse of toEventDateColumns, for rebuilding a PublishedState from a stored row. */
export function fromEventDateColumns(columns: EventDateColumns): CandidateDate {
  switch (columns.dateType) {
    case "EXACT":
      return columns.dateExact ? { kind: "EXACT", date: columns.dateExact } : { kind: "TBD" };
    case "RANGE":
      return columns.dateStart && columns.dateEnd
        ? { kind: "RANGE", start: columns.dateStart, end: columns.dateEnd }
        : { kind: "TBD" };
    case "WINDOW":
      return columns.windowGranularity && columns.windowStart && columns.windowEnd
        ? {
            kind: "WINDOW",
            granularity: columns.windowGranularity,
            start: columns.windowStart,
            end: columns.windowEnd,
          }
        : { kind: "TBD" };
    case "TBD":
      return { kind: "TBD" };
  }
}

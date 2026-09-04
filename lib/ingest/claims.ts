import type { SourceTier } from "@/app/generated/prisma/client";
import type { CandidateDate, ClaimRecord, Origin } from "./types";

/**
 * Assembles the claim set the gate reasons over, from stored history plus what
 * this run observed.
 *
 * Split out of the orchestrator because the interesting part -- the G3
 * corroboration streak -- is real logic that deserves to be pure and tested
 * on its own, and because the gate must be handed a finished ClaimRecord[]
 * rather than being given a database to go and ask.
 */

/** A stored SourceClaim reduced to what streak reconstruction needs (see ingestRepo.getClaimHistoryForEvent). */
export type StoredClaim = {
  origin: string | null;
  scanRunId: string | null;
  tier: SourceTier;
  confidenceWeight: number;
  url: string;
  dateExact: Date | null;
  dateStart: Date | null;
  dateEnd: Date | null;
  lastVerifiedAt: Date | null;
  createdAt: Date;
};

/** What one provider said about one event this run. */
export type ObservedClaim = {
  origin: Origin;
  tier: SourceTier;
  date: CandidateDate;
  url: string;
  confidenceWeight?: number;
};

/**
 * Reconstructs a claim's date from the flat columns. Claims store a WINDOW's
 * bounds in dateStart/dateEnd (see ingestRepo.upsertIngestClaim), so a stored
 * claim cannot distinguish RANGE from WINDOW -- it comes back as RANGE, which
 * is fine because everything downstream compares by the shared anchor. The
 * event row, not the claim, is the record of a date's exact kind.
 */
export function claimDateFromStored(claim: StoredClaim): CandidateDate {
  if (claim.dateExact) return { kind: "EXACT", date: claim.dateExact };
  if (claim.dateStart && claim.dateEnd) return { kind: "RANGE", start: claim.dateStart, end: claim.dateEnd };
  return { kind: "TBD" };
}

/**
 * "Unchanged" for streak purposes: the same kind anchored on the same instant.
 *
 * Deliberately stricter than the gate's three-day agreement window. G3 is
 * asking whether a retailer's date has *stopped moving*, and a date that
 * drifts by two days every run has plainly not stopped moving even though
 * every consecutive pair of readings would "agree".
 */
export function isSameStoredDate(a: CandidateDate, b: CandidateDate): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "TBD":
      return true;
    case "EXACT":
      return a.date.getTime() === (b as typeof a).date.getTime();
    case "RANGE":
    case "WINDOW": {
      const other = b as typeof a;
      return a.start.getTime() === other.start.getTime() && a.end.getTime() === other.end.getTime();
    }
  }
}

/**
 * How many consecutive prior runs this origin reported this same date,
 * counting back from the most recent run and stopping at the first run that
 * said something else (or did not report at all).
 *
 * History is grouped by run rather than by row so a run that wrote the same
 * claim twice -- which replay's upsert makes impossible, but a future bug
 * might not -- cannot inflate the count.
 */
export function consecutiveRunsFor(history: StoredClaim[], origin: Origin, date: CandidateDate): number {
  const forOrigin = history
    .filter((claim) => claim.origin === origin && claim.scanRunId !== null)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  // Latest run last; collapse to one entry per run.
  const byRun = new Map<string, CandidateDate>();
  for (const claim of forOrigin) {
    byRun.set(claim.scanRunId as string, claimDateFromStored(claim));
  }

  let streak = 0;
  for (const storedDate of [...byRun.values()].reverse()) {
    if (!isSameStoredDate(storedDate, date)) break;
    streak += 1;
  }
  return streak;
}

/**
 * Builds the full ClaimRecord set for one event.
 *
 * Two populations end up in the result:
 *  - what this run observed, with its streak extended by one (this run counts);
 *  - every other origin that has claimed this event before and did *not*
 *    report this time, carried in with `seenInCurrentRun: false`. Those are
 *    not noise: they are precisely the input rule G7 needs, and dropping them
 *    would make absence indistinguishable from having never existed.
 *
 * An origin's streak is reported as 0 when it was contradicted, but that reset
 * is the gate's call and is applied by Apply -- this function only reports
 * what the history says.
 */
export function buildClaimRecords(params: {
  history: StoredClaim[];
  observed: ObservedClaim[];
  now: Date;
}): ClaimRecord[] {
  const { history, observed, now } = params;
  const records: ClaimRecord[] = [];
  const observedOrigins = new Set<Origin>();

  for (const claim of observed) {
    observedOrigins.add(claim.origin);
    records.push({
      origin: claim.origin,
      tier: claim.tier,
      date: claim.date,
      // +1 for this run: `consecutiveRunsFor` counts prior runs only, so a
      // date seen for the very first time reports 1, and the seventh
      // consecutive sighting reports 7 -- which is what G3's threshold means.
      consecutiveRuns: consecutiveRunsFor(history, claim.origin, claim.date) + 1,
      seenInCurrentRun: true,
      lastSeenAt: now,
      confidenceWeight: claim.confidenceWeight,
      url: claim.url,
    });
  }

  // Latest stored claim per origin, for the origins that went quiet.
  const latestByOrigin = new Map<Origin, StoredClaim>();
  for (const claim of history) {
    if (!claim.origin) continue;
    if (observedOrigins.has(claim.origin)) continue;
    const existing = latestByOrigin.get(claim.origin);
    if (!existing || claim.createdAt.getTime() >= existing.createdAt.getTime()) {
      latestByOrigin.set(claim.origin, claim);
    }
  }

  for (const [origin, claim] of latestByOrigin) {
    const date = claimDateFromStored(claim);
    records.push({
      origin,
      tier: claim.tier,
      date,
      consecutiveRuns: consecutiveRunsFor(history, origin, date),
      seenInCurrentRun: false,
      lastSeenAt: claim.lastVerifiedAt ?? claim.createdAt,
      confidenceWeight: claim.confidenceWeight,
      url: claim.url,
    });
  }

  return records;
}

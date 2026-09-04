import type { Prisma } from "@/app/generated/prisma/client";
import type { SourceDisposition, SourceTier } from "@/app/generated/prisma/client";
import * as ingestRepo from "@/data/ingest/ingestRepo";
import { logEvent } from "@/lib/logger";
import { GATE_THRESHOLDS } from "./gate";
import {
  datesAgreeWithin,
  hasDate,
  serializeDate,
  type CandidateDate,
  type Origin,
  type PublishedState,
  type RunDiff,
  type RunDiffChange,
  type Verdict,
} from "./types";

/**
 * Stage 5: write the gate's verdicts down.
 *
 * The only stage after Fetch that touches the database, and deliberately the
 * thinnest one: no decisions are made here. Everything Apply writes was
 * already decided by the gate, which is why the gate could be pure. What Apply
 * *does* own is the ordering and idempotency of the writes, so that running it
 * twice on the same verdicts leaves the database in the same state as running
 * it once (see replay.ts and tests/ingestReplay.test.ts).
 *
 * Every database call goes through an injected `deps` object defaulting to
 * data/ingest/ingestRepo, so this module can be unit-tested against a fake
 * without a database and without mocking Prisma itself.
 */

/** One origin's claim for this run, ready to be persisted alongside the verdict. */
export type ClaimWrite = {
  origin: Origin;
  tier: SourceTier;
  date: CandidateDate;
  url: string;
  host?: string;
  confidenceWeight?: number;
};

export type ApplyItem = {
  releaseEventId: string;
  productSetId: string;
  /** What the event showed before this run, for the diff. Null for an event created this run. */
  before: PublishedState | null;
  verdict: Verdict;
  /** The claims observed this run. Empty for a G7 (absence) verdict, which is exactly why it fired. */
  claims: ClaimWrite[];
};

export type ApplyResult = {
  published: number;
  held: number;
  flagged: number;
  stale: number;
  claimsWritten: number;
  reviewItemsOpened: number;
  errors: number;
  diff: RunDiff;
};

/** The slice of ingestRepo Apply uses; narrowed so a test fake only has to provide these five. */
export type ApplyDeps = Pick<
  typeof ingestRepo,
  "upsertIngestClaim" | "applyVerdictToEvent" | "openReviewItem" | "saveRunDiff"
>;

const DEFAULT_CONFIDENCE_WEIGHT = 0.8;

export async function applyVerdicts(
  params: { scanRunId: string; now: Date; items: ApplyItem[] },
  deps: ApplyDeps = ingestRepo,
): Promise<ApplyResult> {
  const { scanRunId, now, items } = params;
  const result: ApplyResult = {
    published: 0,
    held: 0,
    flagged: 0,
    stale: 0,
    claimsWritten: 0,
    reviewItemsOpened: 0,
    errors: 0,
    diff: { scanRunId, changes: [] },
  };

  for (const item of items) {
    // Isolated per event, on the same reasoning as v1's per-candidate try:
    // one event hitting a constraint must not silently drop every event queued
    // behind it. A partial apply is a partial run, which the pipeline treats
    // as a first-class outcome rather than a failure.
    try {
      await applyOne(scanRunId, now, item, deps, result);
    } catch (error) {
      result.errors += 1;
      logEvent({
        action: "ingest.applyVerdict",
        scanRunId,
        releaseEventId: item.releaseEventId,
        outcome: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  await deps.saveRunDiff(scanRunId, result.diff.changes);
  return result;
}

async function applyOne(
  scanRunId: string,
  now: Date,
  item: ApplyItem,
  deps: ApplyDeps,
  result: ApplyResult,
): Promise<void> {
  const { verdict } = item;

  // Claims first: the verdict was derived from them, so if the apply is
  // interrupted between the two writes, the evidence on record is at worst
  // ahead of the conclusion drawn from it, never behind. A gate run over
  // claims-without-verdict reproduces the verdict; a verdict without its
  // claims cannot be explained or re-derived.
  for (const claim of item.claims) {
    await deps.upsertIngestClaim({
      scanRunId,
      origin: claim.origin,
      releaseEventId: item.releaseEventId,
      tier: claim.tier,
      disposition: dispositionFor(claim.date, verdict.date),
      confidenceWeight: claim.confidenceWeight ?? DEFAULT_CONFIDENCE_WEIGHT,
      url: claim.url,
      host: claim.host ?? safeHostname(claim.url),
      date: claim.date,
      now,
    });
    result.claimsWritten += 1;
  }

  await deps.applyVerdictToEvent({
    releaseEventId: item.releaseEventId,
    date: verdict.date,
    status: verdict.status,
    confidence: verdict.confidence,
    // An absence verdict must not refresh the freshness stamp -- that stamp is
    // the very thing G7 counts days from, and bumping it here would make an
    // absent event look permanently fresh and never reach the cancel threshold.
    lastSeenAt: item.claims.length > 0 ? now : null,
  });

  if (verdict.review) {
    await deps.openReviewItem({
      releaseEventId: item.releaseEventId,
      reason: verdict.review.reason,
      detail: verdict.review.detail as unknown as Prisma.InputJsonValue,
    });
    result.reviewItemsOpened += 1;
  }

  switch (verdict.action) {
    case "PUBLISH":
      result.published += 1;
      break;
    case "HOLD":
      result.held += 1;
      break;
    case "FLAG":
      result.flagged += 1;
      break;
    case "STALE":
      // Note what is *not* here: no delete, no archive, no soft-delete. A
      // STALE verdict is a status change and nothing more (gate rule G7).
      result.stale += 1;
      break;
  }

  result.diff.changes.push(toDiffChange(item));
}

/**
 * Stage 6 in miniature: the run diff is assembled as verdicts are applied
 * rather than recomputed afterwards, so it describes what was actually written
 * (including the events that errored out and are therefore absent from it).
 */
function toDiffChange(item: ApplyItem): RunDiffChange {
  return {
    releaseEventId: item.releaseEventId,
    productSetId: item.productSetId,
    action: item.verdict.action,
    rule: item.verdict.rule,
    reason: item.verdict.reason,
    before: serializeDate(item.before?.date ?? null),
    after: serializeDate(item.verdict.date),
    statusBefore: item.before?.status ?? null,
    statusAfter: item.verdict.status,
  };
}

/**
 * How a claim describes itself relative to the date that was actually
 * published. Uses the gate's agreement window rather than v1's 14-day dedup
 * proximity, for the same reason gate.ts's scoreClaims does: within v2,
 * "agrees" has to mean one thing.
 */
function dispositionFor(claimDate: CandidateDate, settled: CandidateDate | null): SourceDisposition {
  if (!settled || !hasDate(settled) || !hasDate(claimDate)) return "SUPPORTS";
  return datesAgreeWithin(claimDate, settled, GATE_THRESHOLDS.agreementDays) ? "SUPPORTS" : "CONTRADICTS";
}

function safeHostname(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

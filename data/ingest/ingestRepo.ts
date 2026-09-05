import { Prisma } from "@/app/generated/prisma/client";
import type {
  ProviderStatus,
  Region,
  ReleaseEventType,
  ReleaseStatus,
  ReviewReason,
  ScanScopeType,
  ScanStatus,
  ScanTrigger,
  SourceDisposition,
  SourceTier,
} from "@/app/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import {
  fromEventDateColumns,
  toEventDateColumns,
  type CandidateDate,
  type Origin,
  type PublishedState,
  type RawPayloadRecord,
  type RunDiffChange,
} from "@/lib/ingest/types";

/**
 * Every database read and write the v2 ingest pipeline performs, in one place.
 *
 * This follows data/crawler/crawlerRepo.ts's shape deliberately: the stage
 * modules under lib/ingest/ stay thin and (apart from Fetch and Apply) pure,
 * and anything that needs Prisma lives here. The payoff is that apply.ts can
 * be handed a fake implementation of the handful of functions it calls and
 * tested without a database, while this module stays a straightforward
 * translation layer with no policy in it.
 */

/** Same transaction seam as crawlerRepo's `Db`: callers can pass a `$transaction` client through. */
type Db = typeof prisma | Prisma.TransactionClient;

// ---------------------------------------------------------------------------
// Run lifecycle
// ---------------------------------------------------------------------------

export async function createIngestRun(params: {
  scopeType: ScanScopeType;
  scopeId?: string;
  trigger: ScanTrigger;
  /** Set when this run exists to re-fetch another run's FAILED providers (replay.ts's retryRun). */
  retryOfRunId?: string;
}) {
  return prisma.scanRun.create({
    data: {
      scopeType: params.scopeType,
      scopeId: params.scopeId,
      trigger: params.trigger,
      retryOfRunId: params.retryOfRunId,
      status: "RUNNING",
      startedAt: new Date(),
    },
  });
}

export async function finalizeIngestRun(id: string, params: { status: ScanStatus; totals?: Prisma.InputJsonValue }) {
  return prisma.scanRun.update({
    where: { id },
    data: { status: params.status, totals: params.totals, finishedAt: new Date() },
  });
}

export async function getIngestRun(id: string) {
  return prisma.scanRun.findUnique({ where: { id } });
}

// ---------------------------------------------------------------------------
// Replay substrate: payloads, provider runs, etags
// ---------------------------------------------------------------------------

/**
 * Stores one provider's response body verbatim, keyed by (run, provider).
 *
 * Upserted rather than created so that retryRun can merge a fresh payload into
 * an existing run in place -- the point of a retry is that the run is repaired,
 * not that a second half-run appears beside it.
 */
export async function saveRawPayload(payload: RawPayloadRecord) {
  return prisma.rawPayload.upsert({
    where: { scanRunId_providerKey: { scanRunId: payload.scanRunId, providerKey: payload.providerKey } },
    update: {
      contentHash: payload.contentHash,
      body: payload.body,
      fetchedAt: payload.fetchedAt,
    },
    create: {
      scanRunId: payload.scanRunId,
      providerKey: payload.providerKey,
      contentHash: payload.contentHash,
      body: payload.body,
      fetchedAt: payload.fetchedAt,
    },
  });
}

/** Stored payloads for a run, optionally narrowed to specific providers (replayRun's `providers` option). */
export async function getRawPayloads(scanRunId: string, providerKeys?: string[]) {
  const rows = await prisma.rawPayload.findMany({
    where: {
      scanRunId,
      ...(providerKeys && providerKeys.length > 0 ? { providerKey: { in: providerKeys } } : {}),
    },
    orderBy: { providerKey: "asc" },
  });
  return rows;
}

export async function recordProviderRun(params: {
  scanRunId: string;
  providerKey: string;
  status: ProviderStatus;
  etag?: string | null;
  candidates?: number;
  error?: string | null;
  startedAt: Date;
  finishedAt?: Date | null;
}) {
  return prisma.providerRun.upsert({
    where: { scanRunId_providerKey: { scanRunId: params.scanRunId, providerKey: params.providerKey } },
    update: {
      status: params.status,
      etag: params.etag,
      candidates: params.candidates ?? 0,
      error: params.error,
      startedAt: params.startedAt,
      finishedAt: params.finishedAt,
    },
    create: {
      scanRunId: params.scanRunId,
      providerKey: params.providerKey,
      status: params.status,
      etag: params.etag,
      candidates: params.candidates ?? 0,
      error: params.error,
      startedAt: params.startedAt,
      finishedAt: params.finishedAt,
    },
  });
}

export async function getProviderRuns(scanRunId: string) {
  return prisma.providerRun.findMany({ where: { scanRunId }, orderBy: { providerKey: "asc" } });
}

/** The providers retryRun re-fetches: exactly the ones with no usable payload. */
export async function getFailedProviderKeys(scanRunId: string): Promise<string[]> {
  const rows = await prisma.providerRun.findMany({
    where: { scanRunId, status: "FAILED" },
    select: { providerKey: true },
  });
  return rows.map((row) => row.providerKey);
}

export async function getProviderEtag(providerKey: string) {
  return prisma.providerEtag.findUnique({ where: { providerKey } });
}

export async function upsertProviderEtag(params: {
  providerKey: string;
  etag?: string | null;
  contentHash?: string | null;
  lastFetchedAt: Date;
}) {
  return prisma.providerEtag.upsert({
    where: { providerKey: params.providerKey },
    update: { etag: params.etag, contentHash: params.contentHash, lastFetchedAt: params.lastFetchedAt },
    create: {
      providerKey: params.providerKey,
      etag: params.etag,
      contentHash: params.contentHash,
      lastFetchedAt: params.lastFetchedAt,
    },
  });
}

/**
 * Drops stored bodies older than `olderThanDays`. RawPayload is the one table
 * here that grows without bound (a body per provider per run, forever), and a
 * month is well past the window in which replaying a run is useful. Deletes
 * only the payloads: ProviderRun rows are small and are the run history.
 */
export async function cleanupOldRawPayloads(olderThanDays = 30): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
  const result = await prisma.rawPayload.deleteMany({ where: { fetchedAt: { lt: cutoff } } });
  return result.count;
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * Everything lib/ingest/identity.ts needs to resolve candidates in one
 * install, fetched in one shot. identity.ts is pure and takes this as an
 * argument -- the read lives here so the matching logic stays replayable.
 */
export async function getIdentityContext(tcgProfileInstallId: string) {
  const sets = await prisma.productSet.findMany({
    where: { tcgProfileInstallId, archivedAt: null },
    // `code` is selected for identity.ts's code tier: a stored set code is the
    // strongest thing short of an external id, and reading it here is what lets
    // a TCGplayer "ME06: Delta Reign" find the Bulbapedia "Mega Evolution-Delta
    // Reign" that was created for the same product on an earlier run.
    select: { id: true, name: true, code: true },
    // Oldest first, so identity.ts's "ties keep the first" tiebreak resolves
    // to the longest-standing set rather than an arbitrary one.
    orderBy: { createdAt: "asc" },
  });
  const identities = await prisma.setIdentity.findMany({
    where: { productSet: { tcgProfileInstallId } },
    select: { origin: true, externalId: true, productSetId: true },
  });
  return { sets, identities };
}

/**
 * Pins a candidate's upstream id to a ProductSet, so every later run resolves
 * it by id instead of re-guessing from its name. Idempotent, and deliberately
 * does *not* repoint an existing pin: an external id that already resolves
 * somewhere else is a genuine conflict (two products claiming one id) that a
 * human should see, not something to silently overwrite.
 */
export async function recordSetIdentity(
  params: { productSetId: string; origin: Origin; externalId: string },
  db: Db = prisma,
) {
  return db.setIdentity.upsert({
    where: { origin_externalId: { origin: params.origin, externalId: params.externalId } },
    update: {},
    create: params,
  });
}

export async function createProductSet(
  params: { tcgProfileInstallId: string; code: string | null; name: string; description?: string },
  db: Db = prisma,
) {
  return db.productSet.create({ data: params });
}

// ---------------------------------------------------------------------------
// Events, claims, verdicts
// ---------------------------------------------------------------------------

/** The event's current published state, in the shape the gate consumes. */
export async function getPublishedState(releaseEventId: string): Promise<PublishedState | null> {
  const event = await prisma.releaseEvent.findUnique({
    where: { id: releaseEventId },
    select: {
      status: true,
      dateType: true,
      dateExact: true,
      dateStart: true,
      dateEnd: true,
      windowGranularity: true,
      windowStart: true,
      windowEnd: true,
    },
  });
  if (!event) return null;
  const date = fromEventDateColumns(event);
  return { date: date.kind === "TBD" ? null : date, status: event.status };
}

export async function findOrCreateReleaseEvent(
  params: { productSetId: string; type: ReleaseEventType; region: Region; date: CandidateDate },
  db: Db = prisma,
) {
  const existing = await db.releaseEvent.findFirst({
    where: { productSetId: params.productSetId, type: params.type, archivedAt: null },
    orderBy: { createdAt: "asc" },
  });
  if (existing) return existing;
  return db.releaseEvent.create({
    data: {
      productSetId: params.productSetId,
      type: params.type,
      region: params.region,
      ...toEventDateColumns(params.date),
    },
  });
}

/**
 * Writes one origin's claim for one run.
 *
 * This is the idempotency hinge of the whole replay design. The claim is keyed
 * on (scanRunId, origin, releaseEventId), so replaying a run rewrites its own
 * previous claims in place instead of appending a second copy -- which matters
 * because confidence is computed by *counting* corroborating claims, so a run
 * replayed three times would otherwise look like three independent sources
 * agreeing and inflate the very number it was supposed to reproduce.
 */
export async function upsertIngestClaim(
  params: {
    scanRunId: string;
    origin: Origin;
    releaseEventId: string;
    tier: SourceTier;
    disposition: SourceDisposition;
    confidenceWeight: number;
    url: string;
    host?: string;
    date: CandidateDate;
    now: Date;
  },
  db: Db = prisma,
) {
  const columns = toEventDateColumns(params.date);
  const dateFields = {
    dateExact: columns.dateExact,
    // A WINDOW's start/end land on the claim's dateStart/dateEnd, matching
    // what v1's dateFieldsForClaim does, so both pipelines' claims read alike.
    dateStart: columns.dateStart ?? columns.windowStart,
    dateEnd: columns.dateEnd ?? columns.windowEnd,
  };

  return db.sourceClaim.upsert({
    where: {
      scanRunId_origin_releaseEventId: {
        scanRunId: params.scanRunId,
        origin: params.origin,
        releaseEventId: params.releaseEventId,
      },
    },
    update: {
      tier: params.tier,
      disposition: params.disposition,
      confidenceWeight: params.confidenceWeight,
      url: params.url,
      host: params.host,
      lastVerifiedAt: params.now,
      ...dateFields,
    },
    create: {
      scanRunId: params.scanRunId,
      origin: params.origin,
      releaseEventId: params.releaseEventId,
      tier: params.tier,
      disposition: params.disposition,
      confidenceWeight: params.confidenceWeight,
      url: params.url,
      host: params.host,
      lastVerifiedAt: params.now,
      ...dateFields,
    },
  });
}

/**
 * Applies a verdict's outcome to the event row.
 *
 * Date columns are written from `date` on every action, not only PUBLISH: for
 * HOLD/FLAG/STALE the gate restates the previously published value, so the
 * write is a no-op that also normalizes any stale columns left over from an
 * earlier date kind. Manual overrides are respected exactly as v1 does --
 * claims still get recorded for visibility, but the crawler never moves a date
 * a human has pinned.
 */
export async function applyVerdictToEvent(
  params: {
    releaseEventId: string;
    date: CandidateDate | null;
    status: ReleaseStatus;
    confidence: number;
    /** Null when this run observed nothing for the event, so an absent run does not refresh its freshness stamp. */
    lastSeenAt: Date | null;
  },
  db: Db = prisma,
) {
  const event = await db.releaseEvent.findUniqueOrThrow({
    where: { id: params.releaseEventId },
    select: { isManualOverride: true },
  });

  return db.releaseEvent.update({
    where: { id: params.releaseEventId },
    data: {
      status: params.status,
      confidence: params.confidence,
      ...(params.lastSeenAt ? { lastSeenAt: params.lastSeenAt } : {}),
      ...(event.isManualOverride ? {} : toEventDateColumns(params.date)),
    },
  });
}

/**
 * Opens a review item, or leaves the existing open one alone.
 *
 * Re-flagging the same unresolved conflict every run would bury the queue in
 * duplicates of one problem, so an open item for the same (event, reason) is
 * refreshed with the latest detail instead of being duplicated. A *resolved*
 * item is never reopened -- if the conflict recurs after somebody dealt with
 * it, that is genuinely new information and gets its own row.
 */
export async function openReviewItem(params: {
  releaseEventId: string;
  reason: ReviewReason;
  detail: Prisma.InputJsonValue;
}) {
  const existing = await prisma.reviewItem.findFirst({
    where: { releaseEventId: params.releaseEventId, reason: params.reason, resolvedAt: null },
  });
  if (existing) {
    return prisma.reviewItem.update({ where: { id: existing.id }, data: { detail: params.detail } });
  }
  return prisma.reviewItem.create({
    data: { releaseEventId: params.releaseEventId, reason: params.reason, detail: params.detail },
  });
}

/** Upserted, not created, so a replay overwrites its run's diff rather than colliding on RunDiff's unique scanRunId. */
export async function saveRunDiff(scanRunId: string, changes: RunDiffChange[]) {
  const payload = changes as unknown as Prisma.InputJsonValue;
  return prisma.runDiff.upsert({
    where: { scanRunId },
    update: { changes: payload },
    create: { scanRunId, changes: payload },
  });
}

export async function getRunDiff(scanRunId: string) {
  return prisma.runDiff.findUnique({ where: { scanRunId } });
}

/**
 * Live events the v2 pipeline has claimed before, in the given installs.
 *
 * This is how rule G7 ever gets a chance to fire: an event nobody reported
 * this run is, by definition, not in the run's candidate set, so the
 * orchestrator has to go looking for it. Scoped to events carrying at least
 * one origin-bearing claim so v2 never passes judgement on rows only the v1
 * crawler has ever touched -- while both pipelines coexist, each owns what it
 * wrote.
 */
export async function getIngestTrackedEvents(installIds: string[]) {
  if (installIds.length === 0) return [];
  return prisma.releaseEvent.findMany({
    where: {
      archivedAt: null,
      productSet: { tcgProfileInstallId: { in: installIds } },
      sourceClaims: { some: { origin: { not: null } } },
    },
    select: { id: true, productSetId: true },
  });
}

/**
 * Prior claims for an event, for rebuilding the gate's ClaimRecord set --
 * specifically the G3 corroboration streak, which is "how many consecutive
 * runs has this origin said this same date".
 */
export async function getClaimHistoryForEvent(releaseEventId: string) {
  return prisma.sourceClaim.findMany({
    where: { releaseEventId, origin: { not: null } },
    select: {
      origin: true,
      scanRunId: true,
      tier: true,
      confidenceWeight: true,
      url: true,
      dateExact: true,
      dateStart: true,
      dateEnd: true,
      lastVerifiedAt: true,
      createdAt: true,
    },
    orderBy: { createdAt: "asc" },
  });
}

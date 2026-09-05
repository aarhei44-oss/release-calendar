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

/**
 * Backfills the real candidate count onto a ProviderRun row that
 * recordProviderRun already wrote at fetch time (necessarily with 0 --
 * parsing hasn't happened yet at that point). Called once per provider after
 * Normalize, from lib/ingest/normalize.ts's candidatesByProvider.
 */
export async function updateProviderRunCandidateCount(
  params: { scanRunId: string; providerKey: string; candidates: number },
  db: Db = prisma,
) {
  return db.providerRun.update({
    where: { scanRunId_providerKey: { scanRunId: params.scanRunId, providerKey: params.providerKey } },
    data: { candidates: params.candidates },
  });
}

/** The providers retryRun re-fetches: exactly the ones with no usable payload. */
export async function getFailedProviderKeys(scanRunId: string): Promise<string[]> {
  const rows = await prisma.providerRun.findMany({
    where: { scanRunId, status: "FAILED" },
    select: { providerKey: true },
  });
  return rows.map((row) => row.providerKey);
}

/**
 * Per-provider first-attempt and last-success timestamps, for
 * lib/ingest/freshness.ts.
 *
 * Two groupBy queries rather than one, because the question has two halves
 * that filter differently: "when did we last hear anything usable" is scoped
 * to OK/NOT_MODIFIED, while "how long have we been trying at all" is over
 * every attempt. NOT_MODIFIED counts as a success on purpose -- a 304 means
 * the upstream answered and confirmed nothing changed, which is the pipeline
 * working exactly as intended, not a provider going quiet.
 */
export async function getProviderRunTimestamps(): Promise<
  Array<{ providerKey: string; lastOkAt: Date | null; firstSeenAt: Date | null }>
> {
  const [successes, attempts] = await Promise.all([
    prisma.providerRun.groupBy({
      by: ["providerKey"],
      where: { status: { in: ["OK", "NOT_MODIFIED"] } },
      _max: { startedAt: true },
    }),
    prisma.providerRun.groupBy({
      by: ["providerKey"],
      _min: { startedAt: true },
    }),
  ]);

  const lastOk = new Map(successes.map((row) => [row.providerKey, row._max.startedAt]));
  return attempts.map((row) => ({
    providerKey: row.providerKey,
    lastOkAt: lastOk.get(row.providerKey) ?? null,
    firstSeenAt: row._min.startedAt,
  }));
}

/**
 * The most recent ProviderRun per provider, so the System tab can show what
 * the current state actually is (FAILED with an error, DEGRADED, or fine)
 * rather than only when it was last OK.
 */
export async function getLatestProviderRuns() {
  const latest = await prisma.providerRun.groupBy({
    by: ["providerKey"],
    _max: { startedAt: true },
  });
  if (latest.length === 0) return [];

  // SQLite has no lateral join through Prisma, so this fetches the candidate
  // rows by (providerKey, startedAt) and picks one per provider. The pair is
  // indexed (@@index([providerKey, startedAt])), and there is one row per
  // provider per run, so the over-fetch is at most a handful of duplicates.
  const rows = await prisma.providerRun.findMany({
    where: {
      OR: latest
        .filter((row) => row._max.startedAt !== null)
        .map((row) => ({ providerKey: row.providerKey, startedAt: row._max.startedAt as Date })),
    },
    orderBy: { startedAt: "desc" },
  });

  const byProvider = new Map<string, (typeof rows)[number]>();
  for (const row of rows) if (!byProvider.has(row.providerKey)) byProvider.set(row.providerKey, row);
  return [...byProvider.values()].sort((a, b) => a.providerKey.localeCompare(b.providerKey));
}

// ---------------------------------------------------------------------------
// Freshness alarms (lib/ingest/freshness.ts)
// ---------------------------------------------------------------------------

export async function listProviderAlarms() {
  return prisma.providerAlarm.findMany({ orderBy: { providerKey: "asc" } });
}

/**
 * Opens an alarm for a provider, or re-stamps a standing one after the repeat
 * window. Upserted on providerKey so an episode reuses its row: the pass asks
 * "is this provider alarmed right now", never "how many times has it ever
 * been", and one row per provider makes the former a single lookup.
 */
export async function raiseProviderAlarm(params: {
  providerKey: string;
  openedAt: Date;
  notifiedAt: Date;
  lastOkAt: Date | null;
}) {
  return prisma.providerAlarm.upsert({
    where: { providerKey: params.providerKey },
    update: {
      openedAt: params.openedAt,
      notifiedAt: params.notifiedAt,
      lastOkAt: params.lastOkAt,
      // Reopening an episode that had been cleared.
      clearedAt: null,
    },
    create: {
      providerKey: params.providerKey,
      openedAt: params.openedAt,
      notifiedAt: params.notifiedAt,
      lastOkAt: params.lastOkAt,
    },
  });
}

/** Marks a standing alarm recovered. The row is kept, so the System tab can still show "recovered at". */
export async function clearProviderAlarm(providerKey: string, clearedAt: Date) {
  return prisma.providerAlarm.updateMany({
    where: { providerKey, clearedAt: null },
    data: { clearedAt },
  });
}

// ---------------------------------------------------------------------------
// Review queue
// ---------------------------------------------------------------------------

/**
 * Every unresolved ReviewItem, newest first, with enough of the event to name
 * it in the admin queue.
 *
 * `summary` is selected but is currently always null -- it is where a future
 * automated reviewer would write a plain-language explanation. The UI renders
 * the raw claim comparison out of `detail` when it is null rather than
 * inventing prose, because a fabricated "summary" of a date conflict is
 * exactly the kind of confident-sounding wrong thing a human would then act
 * on.
 */
export async function listOpenReviewItems(limit = 50) {
  return prisma.reviewItem.findMany({
    where: { resolvedAt: null },
    orderBy: { createdAt: "desc" },
    take: limit,
    include: {
      releaseEvent: {
        select: {
          id: true,
          type: true,
          region: true,
          status: true,
          isManualOverride: true,
          dateType: true,
          dateExact: true,
          dateStart: true,
          dateEnd: true,
          windowGranularity: true,
          windowStart: true,
          windowEnd: true,
          productSet: { select: { name: true, code: true, install: { select: { package: { select: { name: true } } } } } },
        },
      },
    },
  });
}

export async function countOpenReviewItems(): Promise<number> {
  return prisma.reviewItem.count({ where: { resolvedAt: null } });
}

export async function getReviewItem(id: string) {
  return prisma.reviewItem.findUnique({ where: { id } });
}

/**
 * Records a human's decision on a review item, and -- when they accepted a
 * specific claim's date -- pins that date onto the event.
 *
 * `isManualOverride` is the load-bearing part. Without it the next scan's
 * verdict would write straight over the date a human just chose, and the queue
 * would hand the same conflict back tomorrow, forever. It is the same flag v1
 * respects (data/crawler/crawlerRepo.ts's updateEventConfidence) and that v2's
 * applyVerdictToEvent already honours, so setting it here is enough for both
 * pipelines to leave the decision alone.
 *
 * Done in one transaction so an event can never end up pinned to a date whose
 * review item still reads as open, or vice versa.
 */
export async function resolveReviewItem(params: {
  id: string;
  note: string;
  /** Null for "keep the current value" and "dismiss"; a date for "accept this claim". */
  acceptedDate: CandidateDate | null;
  now: Date;
}) {
  return prisma.$transaction(async (tx) => {
    const item = await tx.reviewItem.findUniqueOrThrow({
      where: { id: params.id },
      select: { id: true, releaseEventId: true, resolvedAt: true },
    });
    if (item.resolvedAt) throw new Error("That review item has already been resolved.");

    if (params.acceptedDate) {
      await tx.releaseEvent.update({
        where: { id: item.releaseEventId },
        data: {
          ...toEventDateColumns(params.acceptedDate),
          isManualOverride: true,
          manualNotes: params.note,
        },
      });
    }

    return tx.reviewItem.update({
      where: { id: params.id },
      data: { resolvedAt: params.now, resolvedNote: params.note },
    });
  });
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
    // `codeIsSynthetic` rides along so identity.ts can tell a real published
    // code from one this pipeline invented to satisfy the NOT NULL column --
    // only the former is a fact worth matching on.
    select: { id: true, name: true, code: true, codeIsSynthetic: true },
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
  params: {
    tcgProfileInstallId: string;
    code: string;
    codeIsSynthetic?: boolean;
    name: string;
    description?: string;
  },
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

/**
 * Resolves the one event a (productSet, type, region) triple names, creating it
 * if this is the first time anything has claimed it.
 *
 * Region is part of the lookup, not just of the row it creates. Without it a
 * Japanese street date and a global one for the same expansion resolve to a
 * single event, arrive at the gate as two claims three months apart, and are
 * correctly read as a G5 conflict -- on every set with a JP release, forever.
 * That is the reason Phase 2 held back Bulbapedia's Japanese expansion list and
 * both Bandai sites' JP catalogues.
 *
 * Note the *absence* of a matching database constraint: ReleaseEvent carries an
 * `@@index([productSetId, type, region])` and deliberately no `@@unique`. The v1
 * crawler still creates several events per (productSet, type) on purpose, for
 * dates far enough apart to be different printings (lib/crawler/dedup.ts's
 * findMatchingEvent, +/-14 days), and it is still the live pipeline. Scoping
 * happens here, in v2's resolution logic, so v1 is untouched.
 */
export async function findOrCreateReleaseEvent(
  params: { productSetId: string; type: ReleaseEventType; region: Region; date: CandidateDate },
  db: Db = prisma,
) {
  const existing = await db.releaseEvent.findFirst({
    where: {
      productSetId: params.productSetId,
      type: params.type,
      region: params.region,
      archivedAt: null,
    },
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

import { Prisma } from "@/app/generated/prisma/client";
import type {
  ProductImageKind,
  ProviderStatus,
  Region,
  ReleaseEvent,
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
// Job lock / install scoping
//
// Moved here from data/crawler/crawlerRepo.ts at the v1 cutover (both
// orchestrate.ts's startIngest and replay.ts's replayRun/retryRun need
// these; they were never v1-specific, just historically defined alongside
// it). The "crawler" job name is shared, not renamed, so a lock taken by
// one caller is still visible to the other -- see orchestrate.ts's
// JOB_NAME for why that still matters even with v1 gone: nothing about
// the name implies which pipeline holds it.
// ---------------------------------------------------------------------------

export async function acquireJobLock(jobName: string, scopeKey: string, ttlMs: number) {
  // Wrapped in a transaction so the check-then-write is atomic: two
  // concurrent acquisition attempts for the same (jobName, scopeKey) must
  // not both observe "unlocked" and both proceed (UC-19).
  return prisma.$transaction(async (tx) => {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs);

    const existing = await tx.jobLock.findUnique({
      where: { jobName_scopeKey: { jobName, scopeKey } },
    });

    if (existing && existing.expiresAt && existing.expiresAt > now) {
      return null;
    }

    return tx.jobLock.upsert({
      where: { jobName_scopeKey: { jobName, scopeKey } },
      update: { acquiredAt: now, expiresAt },
      create: { jobName, scopeKey, acquiredAt: now, expiresAt },
    });
  });
}

export async function releaseJobLock(jobName: string, scopeKey: string) {
  await prisma.jobLock.deleteMany({ where: { jobName, scopeKey } });
}

/** Enabled installs in scope for a scan, with the package config providers read discoveryConfig from. */
export async function getInstallsForScan(scopeType: ScanScopeType, scopeId?: string) {
  return prisma.tcgProfileInstall.findMany({
    where: {
      enabled: true,
      ...(scopeType === "INSTALL" && scopeId ? { id: scopeId } : {}),
    },
    include: { package: true },
  });
}

/**
 * Permanently deletes ReleaseEvents whose date is more than `olderThanDays`
 * old, for lib/ingest/retention.ts's runRetentionCleanupPass.
 */
export async function deleteOldEvents(
  installIds?: string[],
  olderThanDays = 30,
  excludeEventIds?: string[],
): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
  const result = await prisma.releaseEvent.deleteMany({
    where: {
      ...(installIds ? { productSet: { tcgProfileInstallId: { in: installIds } } } : {}),
      ...(excludeEventIds && excludeEventIds.length > 0 ? { id: { notIn: excludeEventIds } } : {}),
      OR: [
        { dateType: "EXACT", dateExact: { lt: cutoff } },
        { dateType: "RANGE", dateEnd: { lt: cutoff } },
        { dateType: "WINDOW", windowEnd: { lt: cutoff } },
      ],
    },
  });
  return result.count;
}

/**
 * Permanently deletes ProductSets that have sat archived (merged away) for
 * more than `olderThanDays`. ProductSet has no date field of its own, so
 * this uses time-since-merge as its clock, independent of deleteOldEvents
 * (which already handles the events themselves by their own dates).
 */
export async function deleteStaleArchivedProductSets(installIds?: string[], olderThanDays = 30): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
  const result = await prisma.productSet.deleteMany({
    where: {
      archivedAt: { not: null, lt: cutoff },
      ...(installIds ? { tcgProfileInstallId: { in: installIds } } : {}),
    },
  });
  return result.count;
}

/**
 * Resolves event ids to enough context to name them in a subscriber/follower
 * notification (lib/ingest/notifications.ts's toScanChanges): which install,
 * and a human-readable game/product-set name.
 */
export async function getChangeContextForEvents(eventIds: string[]) {
  if (eventIds.length === 0) return [];
  const events = await prisma.releaseEvent.findMany({
    where: { id: { in: eventIds } },
    select: {
      id: true,
      productSet: {
        select: {
          name: true,
          code: true,
          tcgProfileInstallId: true,
          install: { select: { package: { select: { name: true } } } },
        },
      },
    },
  });
  return events.map((event) => ({
    eventId: event.id,
    installId: event.productSet.tcgProfileInstallId,
    productSetName: event.productSet.name ?? event.productSet.code ?? "Untitled release",
    gameName: event.productSet.install.package.name,
  }));
}

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

/**
 * The most recent payload this provider actually returned a body for, from any
 * run.
 *
 * Used by the presentational backfill in lib/ingest/orchestrate.ts, which needs
 * a parsable payload for a provider precisely when *this* run has none.
 *
 * The emptiness test has to happen in SQLite, not in JS over a fetched page.
 * NOT_MODIFIED writes a row with an empty body, and the providers this backfill
 * exists for are the ones that go NOT_MODIFIED for weeks: on production today
 * ygoprodeck's five most recent payload rows are all empty and the real one is
 * sixth. Any fixed `take` big enough to be safe is also big enough to drag
 * several megabytes of gzipped payload across for nothing -- and one too small
 * fails by finding nothing at all, silently, which is the exact failure mode
 * the backfill was written to end.
 *
 * So the length filter runs in the query and only the one chosen body is read.
 */
export async function getLatestStoredPayload(providerKey: string) {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "RawPayload"
     WHERE "providerKey" = ${providerKey} AND length("body") > 0
     ORDER BY "fetchedAt" DESC
     LIMIT 1
  `;
  if (rows.length === 0) return null;
  return prisma.rawPayload.findUnique({ where: { id: rows[0].id } });
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
 * would hand the same conflict back tomorrow, forever. applyVerdictToEvent
 * already honours it, so setting it here is enough to make the decision stick.
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
    // `imageUrl`/`description` are not identity inputs at all -- they ride
    // along so orchestrate.ts's enrichment step can tell an already-populated
    // set from an empty one without a second query per candidate. Reading them
    // here costs nothing (same row, same scan) and keeps the nightly run at
    // zero extra writes once every set has been filled in.
    select: {
      id: true,
      name: true,
      code: true,
      codeIsSynthetic: true,
      imageUrl: true,
      imageKind: true,
      description: true,
    },
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
    imageUrl?: string;
    imageKind?: ProductImageKind;
  },
  db: Db = prisma,
) {
  return db.productSet.create({ data: params });
}

/**
 * Fills in a set's presentational fields (the premium marketing image, the
 * free set description) after the fact.
 *
 * This exists because creation is not enough. Every set in the catalogue was
 * created by an earlier run, so threading a field through createProductSet
 * alone reaches only sets discovered *after* the change -- which for a mature
 * install is approximately none of them. `description` shipped with exactly
 * that gap and has stayed empty on every row since.
 *
 * Deliberately narrow: only ever called with fields the stored row is missing
 * (orchestrate.ts decides), so a populated value is never overwritten. There
 * is no confidence model for images the way SourceClaim gives one for dates,
 * so "first origin to supply one wins" is the only rule available that does
 * not make the result depend on provider ordering within a run.
 */
export async function updateProductSetEnrichment(
  productSetId: string,
  fields: { imageUrl?: string; imageKind?: ProductImageKind; description?: string },
  db: Db = prisma,
) {
  if (fields.imageUrl === undefined && fields.imageKind === undefined && fields.description === undefined) {
    return null;
  }
  return db.productSet.update({ where: { id: productSetId }, data: fields });
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
 * **A created event is dateless**, and reports itself as `created: true` so the
 * caller can tell the gate it has no published state. Both halves of that
 * matter, and both were wrong until they were fixed together.
 *
 * This used to seed the new row with the first candidate's date. That looked
 * harmless -- the gate was about to decide the date anyway -- but the seeded
 * value *became* the published state, because getPublishedState reads the row
 * that was just written. So a HOLD (which expresses "don't move it" by
 * restating the published date) restated the seed, and a single unqualified
 * claim put a date on the calendar that no gate rule had ever endorsed, on the
 * first run it was seen. It then froze there: every later run held the same
 * value, so the source could not correct it either.
 *
 * Worst hit was rule G3, whose entire purpose is that a lone retailer date must
 * hold still for seven runs before anyone believes it. Seeding published it on
 * run one and G3 had nothing left to gate. G5 and G6 were weakened the same
 * way, since both compare against a "published" date that was never published.
 *
 * Note this only ever governed *newly created* rows. Events already carrying a
 * seeded date keep it: a HOLD still restates whatever the row shows, and no
 * pass exists that could tell an endorsed date from a seeded one after the
 * fact.
 *
 * Region is part of the lookup, not just of the row it creates. Without it a
 * Japanese street date and a global one for the same expansion resolve to a
 * single event, arrive at the gate as two claims three months apart, and are
 * correctly read as a G5 conflict -- on every set with a JP release, forever.
 * That is the reason Phase 2 held back Bulbapedia's Japanese expansion list and
 * both Bandai sites' JP catalogues.
 *
 * Note the *absence* of a matching database constraint: ReleaseEvent carries an
 * `@@index([productSetId, type, region])` and deliberately no `@@unique`. That
 * was originally so the now-retired v1 crawler (which could create several
 * events per (productSet, type) for dates far enough apart to be different
 * printings) stayed unaffected; v1 is gone, but tightening this to a real
 * uniqueness constraint is a separate schema decision, not required for v2 to
 * work correctly -- scoping happens here, in v2's resolution logic, regardless.
 *
 * Derived rows are excluded from the lookup (`derivedFromEventId: null`). A
 * computed prerelease shares the (productSet, PRERELEASE, region) triple with a
 * sourced one, so without this filter the gate would find a row it has no
 * claims for, hand it to the absence sweep on the next run, and eventually
 * cancel a date the derivation pass is still actively maintaining. The two
 * populations stay disjoint: the gate owns rows with claims, the derivation
 * pass owns rows with an anchor.
 */
export async function findOrCreateReleaseEvent(
  params: { productSetId: string; type: ReleaseEventType; region: Region },
  db: Db = prisma,
): Promise<{ event: ReleaseEvent; created: boolean }> {
  const existing = await db.releaseEvent.findFirst({
    where: {
      productSetId: params.productSetId,
      type: params.type,
      region: params.region,
      archivedAt: null,
      derivedFromEventId: null,
    },
    orderBy: { createdAt: "asc" },
  });
  if (existing) return { event: existing, created: false };

  const event = await db.releaseEvent.create({
    data: {
      productSetId: params.productSetId,
      type: params.type,
      region: params.region,
      // Explicitly dateless. `dateType` is NOT NULL with no default, so this is
      // also the only way the row is writable at all -- but the reason it is
      // TBD rather than the candidate's date is the one above.
      ...toEventDateColumns(null),
    },
  });
  return { event, created: true };
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
 *
 * Derived prerelease rows are excluded explicitly as well as implicitly. They
 * carry no claims at all, so the clause above already skips them; stating it
 * outright means a future change that writes any claim against a derived row
 * cannot silently hand it to the absence sweep, which would cancel a date whose
 * only "source" is a shelf date the sweep never looks at.
 */
export async function getIngestTrackedEvents(installIds: string[]) {
  if (installIds.length === 0) return [];
  return prisma.releaseEvent.findMany({
    where: {
      archivedAt: null,
      derivedFromEventId: null,
      productSet: { tcgProfileInstallId: { in: installIds } },
      sourceClaims: { some: { origin: { not: null } } },
    },
    select: { id: true, productSetId: true },
  });
}

// ---------------------------------------------------------------------------
// Derived prerelease events (lib/ingest/derivePrereleases.ts)
//
// Three reads that between them describe the whole reconciliation: what shelf
// dates could anchor a prerelease, which prerelease dates a real source already
// owns, and which derived rows exist right now.
// ---------------------------------------------------------------------------

/**
 * Every live SHELF event in the given installs, with the game slug needed to
 * look up its prerelease schedule.
 *
 * Deliberately not filtered to CONFIRMED-and-exact in SQL, even though only
 * those anchor anything. The derivation pass has to answer "does this derived
 * row's anchor still qualify?", and an anchor that has slipped back to
 * ANNOUNCED has to be *seen* to be retracted -- filtering it out here would
 * make it indistinguishable from a deleted one, which is a different case with
 * a different outcome.
 */
export async function getShelfAnchors(installIds: string[]) {
  if (installIds.length === 0) return [];
  const events = await prisma.releaseEvent.findMany({
    where: {
      type: "SHELF",
      archivedAt: null,
      productSet: { tcgProfileInstallId: { in: installIds }, archivedAt: null },
    },
    select: {
      id: true,
      productSetId: true,
      region: true,
      status: true,
      confidence: true,
      dateType: true,
      dateExact: true,
      dateStart: true,
      dateEnd: true,
      windowGranularity: true,
      windowStart: true,
      windowEnd: true,
      productSet: { select: { install: { select: { package: { select: { slug: true } } } } } },
    },
  });
  return events.map((event) => ({
    id: event.id,
    productSetId: event.productSetId,
    region: event.region,
    status: event.status,
    confidence: event.confidence,
    game: event.productSet.install.package.slug,
    date: fromEventDateColumns(event),
  }));
}

/**
 * Prerelease dates that a real source already owns, keyed by product set.
 *
 * The derivation pass skips any slot one of these already covers. A stated date
 * beats a computed one even when they differ by a few days: the source is
 * describing an event somebody scheduled, and the schedule here is only ever a
 * model of what that person usually does.
 */
export async function getSourcedPrereleaseDates(installIds: string[]) {
  if (installIds.length === 0) return [];
  const events = await prisma.releaseEvent.findMany({
    where: {
      type: "PRERELEASE",
      archivedAt: null,
      derivedFromEventId: null,
      dateType: { not: "TBD" },
      productSet: { tcgProfileInstallId: { in: installIds }, archivedAt: null },
    },
    select: {
      id: true,
      productSetId: true,
      region: true,
      dateType: true,
      dateExact: true,
      dateStart: true,
      dateEnd: true,
      windowGranularity: true,
      windowStart: true,
      windowEnd: true,
    },
  });
  return events.map((event) => ({
    id: event.id,
    productSetId: event.productSetId,
    region: event.region,
    date: fromEventDateColumns(event),
  }));
}

/** Every derived prerelease row in the given installs, archived ones included -- a retracted row is un-archived, not re-created. */
export async function getDerivedPrereleaseEvents(installIds: string[]) {
  if (installIds.length === 0) return [];
  const events = await prisma.releaseEvent.findMany({
    where: {
      derivedFromEventId: { not: null },
      productSet: { tcgProfileInstallId: { in: installIds } },
    },
    select: {
      id: true,
      productSetId: true,
      region: true,
      status: true,
      archivedAt: true,
      derivedFromEventId: true,
      derivedSlot: true,
      dateType: true,
      dateExact: true,
      dateStart: true,
      dateEnd: true,
      windowGranularity: true,
      windowStart: true,
      windowEnd: true,
    },
  });
  return events.map((event) => ({
    id: event.id,
    productSetId: event.productSetId,
    region: event.region,
    status: event.status,
    archivedAt: event.archivedAt,
    derivedFromEventId: event.derivedFromEventId as string,
    derivedSlot: event.derivedSlot,
    date: fromEventDateColumns(event),
  }));
}

/**
 * Creates or refreshes the derived row for one (anchor, slot).
 *
 * Upserted on the (derivedFromEventId, derivedSlot) unique index rather than
 * created, so a row whose anchor date moved is *updated in place*. That is what
 * keeps a user's follow, personal note and reminder attached across a delay --
 * delete-and-recreate would cascade all three away and hand the user a new
 * event id they were never following.
 *
 * `archivedAt: null` on the update path is the un-retraction: a slot that was
 * archived when its shelf date lost CONFIRMED comes back as the same row, with
 * whatever was attached to it intact.
 */
export async function upsertDerivedPrereleaseEvent(params: {
  productSetId: string;
  derivedFromEventId: string;
  derivedSlot: string;
  region: Region;
  date: CandidateDate;
  status: ReleaseStatus;
  confidence: number;
  sourceSummary: string;
  now: Date;
}) {
  const columns = toEventDateColumns(params.date);
  return prisma.releaseEvent.upsert({
    where: {
      derivedFromEventId_derivedSlot: {
        derivedFromEventId: params.derivedFromEventId,
        derivedSlot: params.derivedSlot,
      },
    },
    update: {
      region: params.region,
      status: params.status,
      confidence: params.confidence,
      sourceSummary: params.sourceSummary,
      lastSeenAt: params.now,
      archivedAt: null,
      ...columns,
    },
    create: {
      productSetId: params.productSetId,
      type: "PRERELEASE",
      derivedFromEventId: params.derivedFromEventId,
      derivedSlot: params.derivedSlot,
      region: params.region,
      status: params.status,
      confidence: params.confidence,
      sourceSummary: params.sourceSummary,
      lastSeenAt: params.now,
      ...columns,
    },
  });
}

/**
 * Retracts a derived row by archiving it, which is how it leaves the calendar
 * (every calendar query filters `archivedAt: null` -- see data/calendar/
 * calendarRepo.ts).
 *
 * Not a delete, even though the retraction is triggered by the derived date
 * ceasing to be true. Deleting cascades to EventFollow, EventPersonalNote,
 * EventDismissal and EventReaction, so a publisher pushing a set back by a week
 * would silently drop every user who was following its prerelease -- and the
 * date is very likely to come back, at which point the upsert above restores
 * this same row with all of that still attached.
 */
export async function archiveDerivedPrereleaseEvent(releaseEventId: string, now: Date) {
  return prisma.releaseEvent.update({
    where: { id: releaseEventId },
    data: { archivedAt: now },
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

import { prisma } from "@/lib/prisma";
import type {
  ScanScopeType,
  ScanStatus,
  ScanTrigger,
  SourceTier,
  SourceDisposition,
  ReleaseEventType,
  ReleaseStatus,
  Region,
  DateType,
  WindowGranularity,
  Prisma,
} from "@/app/generated/prisma/client";

export async function createScanRun(params: { scopeType: ScanScopeType; scopeId?: string; trigger: ScanTrigger }) {
  return prisma.scanRun.create({
    data: {
      scopeType: params.scopeType,
      scopeId: params.scopeId,
      trigger: params.trigger,
      status: "RUNNING",
      startedAt: new Date(),
    },
  });
}

export async function finalizeScanRun(
  id: string,
  params: { status: ScanStatus; totals?: Prisma.InputJsonValue },
) {
  return prisma.scanRun.update({
    where: { id },
    data: { status: params.status, totals: params.totals, finishedAt: new Date() },
  });
}

export async function recordDiscoveryHit(params: {
  tcgProfileInstallId: string;
  url: string;
  title?: string;
  raw?: Prisma.InputJsonValue;
}) {
  return prisma.discoveryHit.upsert({
    where: {
      tcgProfileInstallId_url: {
        tcgProfileInstallId: params.tcgProfileInstallId,
        url: params.url,
      },
    },
    update: { title: params.title, raw: params.raw, seenAt: new Date() },
    create: {
      tcgProfileInstallId: params.tcgProfileInstallId,
      url: params.url,
      title: params.title,
      raw: params.raw,
    },
  });
}

export async function recordSourceClaim(params: {
  releaseEventId: string;
  tier: SourceTier;
  disposition: SourceDisposition;
  confidenceWeight: number;
  url: string;
  host?: string;
  dateExact?: Date;
  dateStart?: Date;
  dateEnd?: Date;
  raw?: Prisma.InputJsonValue;
}) {
  return prisma.sourceClaim.create({
    data: { ...params, lastVerifiedAt: new Date() },
  });
}

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

/** Enabled installs in scope for a scan, with the package config the crawler reads sourceConfigs/discoveryConfig from. */
export async function getInstallsForScan(scopeType: ScanScopeType, scopeId?: string) {
  return prisma.tcgProfileInstall.findMany({
    where: {
      enabled: true,
      ...(scopeType === "INSTALL" && scopeId ? { id: scopeId } : {}),
    },
    include: { package: true },
  });
}

export async function findOrCreateProductSet(params: {
  tcgProfileInstallId: string;
  code: string;
  name: string;
}) {
  return prisma.productSet.upsert({
    where: {
      tcgProfileInstallId_code: {
        tcgProfileInstallId: params.tcgProfileInstallId,
        code: params.code,
      },
    },
    update: { name: params.name },
    create: params,
  });
}

/**
 * Existing events for a product set + type, for dedup matching (business
 * rule 6.4). Excludes archived (merged-away) events -- otherwise a new claim
 * could silently attach to a frozen duplicate instead of the live survivor,
 * since after a merge they still share the same (productSetId, type).
 */
export async function findEventsForProductSetType(productSetId: string, type: ReleaseEventType) {
  return prisma.releaseEvent.findMany({ where: { productSetId, type, archivedAt: null } });
}

/**
 * Moves a duplicate event's claims and comments onto the primary, then
 * archives (not deletes) the duplicate -- undoable via undoReleaseEventMerge.
 * Each reassigned row is stamped with movedFromReleaseEventId so undo can
 * find it later. The stamp is written in two passes: rows with no existing
 * stamp get one (their first hop), rows that already carry one (already
 * moved by an earlier merge) keep it -- overwriting it would point undo at
 * the wrong duplicate and orphan whichever one it originally came from.
 */
export async function mergeReleaseEvents(primaryId: string, duplicateId: string) {
  await prisma.$transaction([
    prisma.sourceClaim.updateMany({
      where: { releaseEventId: duplicateId, movedFromReleaseEventId: null },
      data: { releaseEventId: primaryId, movedFromReleaseEventId: duplicateId },
    }),
    prisma.sourceClaim.updateMany({
      where: { releaseEventId: duplicateId },
      data: { releaseEventId: primaryId },
    }),
    prisma.userNote.updateMany({
      where: { releaseEventId: duplicateId, movedFromReleaseEventId: null },
      data: { releaseEventId: primaryId, movedFromReleaseEventId: duplicateId },
    }),
    prisma.userNote.updateMany({
      where: { releaseEventId: duplicateId },
      data: { releaseEventId: primaryId },
    }),
    prisma.releaseEvent.update({
      where: { id: duplicateId },
      data: { archivedAt: new Date(), mergedIntoId: primaryId },
    }),
  ]);
}

/**
 * Moves a duplicate ProductSet's release events onto the primary, then
 * archives (not deletes) the duplicate -- undoable via undoProductSetMerge.
 * Same two-pass stamping as mergeReleaseEvents, for the same reason (a
 * ProductSet that survived one merge can later become the duplicate of a
 * different one, e.g. if its name drifts via findOrCreateProductSet's
 * same-code upsert until it matches an older ProductSet).
 */
export async function mergeProductSets(primaryId: string, duplicateId: string) {
  await prisma.$transaction([
    prisma.releaseEvent.updateMany({
      where: { productSetId: duplicateId, movedFromProductSetId: null },
      data: { productSetId: primaryId, movedFromProductSetId: duplicateId },
    }),
    prisma.releaseEvent.updateMany({
      where: { productSetId: duplicateId },
      data: { productSetId: primaryId },
    }),
    prisma.productSet.update({
      where: { id: duplicateId },
      data: { archivedAt: new Date(), mergedIntoId: primaryId },
    }),
  ]);
}

/**
 * Undoes a ProductSet merge: moves every ReleaseEvent stamped with this
 * duplicate's id back onto it (wherever those events currently live, which
 * may not be the immediate primary if it was itself later merged away) and
 * un-archives the duplicate. Throws if the ProductSet isn't currently
 * archived as a merge duplicate -- callers should only offer this action for
 * rows listed as recently merged in the first place.
 */
export async function undoProductSetMerge(duplicateId: string): Promise<{ movedEventIds: string[] }> {
  const duplicate = await prisma.productSet.findUniqueOrThrow({ where: { id: duplicateId } });
  if (!duplicate.archivedAt || !duplicate.mergedIntoId) {
    throw new Error("This product set is not currently merged into another -- nothing to undo.");
  }

  const moved = await prisma.releaseEvent.findMany({
    where: { movedFromProductSetId: duplicateId },
    select: { id: true },
  });

  await prisma.$transaction([
    prisma.releaseEvent.updateMany({
      where: { movedFromProductSetId: duplicateId },
      data: { productSetId: duplicateId, movedFromProductSetId: null },
    }),
    prisma.productSet.update({
      where: { id: duplicateId },
      data: { archivedAt: null, mergedIntoId: null },
    }),
  ]);

  return { movedEventIds: moved.map((e) => e.id) };
}

/**
 * Undoes a ReleaseEvent merge: moves every SourceClaim/UserNote stamped with
 * this duplicate's id back onto it (wherever they currently live) and
 * un-archives the duplicate. Returns the distinct set of event ids that
 * actually lost data (not necessarily the original primary, if it was later
 * merged away itself) so the caller can recompute their confidence/status.
 * Throws if the event isn't currently archived as a merge duplicate.
 */
export async function undoReleaseEventMerge(duplicateId: string): Promise<{ affectedEventIds: string[] }> {
  const duplicate = await prisma.releaseEvent.findUniqueOrThrow({ where: { id: duplicateId } });
  if (!duplicate.archivedAt || !duplicate.mergedIntoId) {
    throw new Error("This event is not currently merged into another -- nothing to undo.");
  }

  const [movedClaims, movedNotes] = await Promise.all([
    prisma.sourceClaim.findMany({
      where: { movedFromReleaseEventId: duplicateId },
      select: { releaseEventId: true },
    }),
    prisma.userNote.findMany({
      where: { movedFromReleaseEventId: duplicateId },
      select: { releaseEventId: true },
    }),
  ]);
  const affectedEventIds = [...new Set([...movedClaims, ...movedNotes].map((r) => r.releaseEventId))];

  await prisma.$transaction([
    prisma.sourceClaim.updateMany({
      where: { movedFromReleaseEventId: duplicateId },
      data: { releaseEventId: duplicateId, movedFromReleaseEventId: null },
    }),
    prisma.userNote.updateMany({
      where: { movedFromReleaseEventId: duplicateId },
      data: { releaseEventId: duplicateId, movedFromReleaseEventId: null },
    }),
    prisma.releaseEvent.update({
      where: { id: duplicateId },
      data: { archivedAt: null, mergedIntoId: null },
    }),
  ]);

  return { affectedEventIds };
}

/** Named product sets, optionally scoped to specific installs, for cross-source identity matching. Excludes already-archived (merged-away) sets so a dedup pass never re-merges the same duplicate. */
export async function getProductSetsForFuzzyMerge(installIds?: string[]) {
  return prisma.productSet.findMany({
    where: {
      name: { not: null },
      archivedAt: null,
      ...(installIds ? { tcgProfileInstallId: { in: installIds } } : {}),
    },
    select: { id: true, tcgProfileInstallId: true, name: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
}

/**
 * Flips every non-terminal (not already RELEASED/CANCELLED) ReleaseEvent
 * whose known date has passed to RELEASED, and returns how many were
 * changed. TBD events are never matched (no date to compare), and a
 * RANGE/WINDOW event only releases once its *end* has passed, not its
 * start. A single bulk update, not a read-then-write loop: this never
 * depends on anything other than "is today past this event's date."
 */
export async function releasePastDueEvents(installIds?: string[]) {
  const now = new Date();
  const result = await prisma.releaseEvent.updateMany({
    where: {
      status: { notIn: ["RELEASED", "CANCELLED"] },
      archivedAt: null,
      ...(installIds ? { productSet: { tcgProfileInstallId: { in: installIds } } } : {}),
      OR: [
        { dateType: "EXACT", dateExact: { lt: now } },
        { dateType: "RANGE", dateEnd: { lt: now } },
        { dateType: "WINDOW", windowEnd: { lt: now } },
      ],
    },
    data: { status: "RELEASED" },
  });
  return result.count;
}

/**
 * Permanently deletes ReleaseEvents whose date is more than `olderThanDays`
 * in the past, to keep the live dataset lean -- this is a real delete, not
 * an archive, and deliberately has no archivedAt filter: it applies to
 * merged-away duplicates too, not just live events. A merged duplicate's own
 * date is always close to its survivor's (dedup only merges within
 * PROXIMITY_DAYS), so both sides of a merge age out together. Cascades to
 * SourceClaim/UserNote via the existing onDelete: Cascade. TBD events have
 * no date and are never matched, so they're never deleted by age.
 */
export async function deleteOldEvents(installIds?: string[], olderThanDays = 30): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
  const result = await prisma.releaseEvent.deleteMany({
    where: {
      ...(installIds ? { productSet: { tcgProfileInstallId: { in: installIds } } } : {}),
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

export async function getAllReleaseEventsForDedup(installIds?: string[]) {
  return prisma.releaseEvent.findMany({
    where: {
      archivedAt: null,
      ...(installIds ? { productSet: { tcgProfileInstallId: { in: installIds } } } : {}),
    },
    select: {
      id: true,
      productSetId: true,
      type: true,
      dateType: true,
      dateExact: true,
      dateStart: true,
      dateEnd: true,
      windowGranularity: true,
      windowStart: true,
      windowEnd: true,
      isManualOverride: true,
      createdAt: true,
    },
    orderBy: { createdAt: "asc" },
  });
}

export async function getClaimsForEvent(eventId: string) {
  return prisma.sourceClaim.findMany({
    where: { releaseEventId: eventId },
    select: { tier: true, disposition: true, confidenceWeight: true },
  });
}

export async function createReleaseEventFromCandidate(params: {
  productSetId: string;
  type: ReleaseEventType;
  region: Region;
  dateType: DateType;
  dateExact?: Date | null;
  windowGranularity?: WindowGranularity | null;
  windowStart?: Date | null;
  windowEnd?: Date | null;
}) {
  return prisma.releaseEvent.create({ data: params });
}

type EventDateFields = {
  dateType: DateType;
  dateExact?: Date | null;
  windowGranularity?: WindowGranularity | null;
  windowStart?: Date | null;
  windowEnd?: Date | null;
};

/**
 * Applies a recomputed confidence/status to an event and, unless the event
 * is under manual override, its date fields too -- crawler writes to dates
 * are skipped for manually-overridden events, but claims are still
 * recorded for visibility (technical-spec.md §6.3 step 5).
 */
export async function updateEventFromClaims(
  eventId: string,
  params: { confidence: number; status: ReleaseStatus; dateInfo?: EventDateFields },
) {
  const event = await prisma.releaseEvent.findUniqueOrThrow({ where: { id: eventId } });

  return prisma.releaseEvent.update({
    where: { id: eventId },
    data: {
      confidence: params.confidence,
      status: params.status,
      lastSeenAt: new Date(),
      ...(event.isManualOverride || !params.dateInfo ? {} : params.dateInfo),
    },
  });
}

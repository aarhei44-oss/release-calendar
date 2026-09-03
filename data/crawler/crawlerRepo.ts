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

/** Existing events for a product set + type, for dedup matching (business rule 6.4). */
export async function findEventsForProductSetType(productSetId: string, type: ReleaseEventType) {
  return prisma.releaseEvent.findMany({ where: { productSetId, type } });
}

/** Moves a duplicate event's claims and comments onto the primary, then deletes the duplicate. */
export async function mergeReleaseEvents(primaryId: string, duplicateId: string) {
  await prisma.$transaction([
    prisma.sourceClaim.updateMany({ where: { releaseEventId: duplicateId }, data: { releaseEventId: primaryId } }),
    prisma.userNote.updateMany({ where: { releaseEventId: duplicateId }, data: { releaseEventId: primaryId } }),
    prisma.releaseEvent.delete({ where: { id: duplicateId } }),
  ]);
}

/**
 * Moves a duplicate ProductSet's release events onto the primary, then
 * deletes the duplicate. Order matters: ProductSet.releaseEvents cascades on
 * delete, so reassigning first is what preserves them on the survivor
 * instead of losing them.
 */
export async function mergeProductSets(primaryId: string, duplicateId: string) {
  await prisma.$transaction([
    prisma.releaseEvent.updateMany({ where: { productSetId: duplicateId }, data: { productSetId: primaryId } }),
    prisma.productSet.delete({ where: { id: duplicateId } }),
  ]);
}

/** Named product sets, optionally scoped to specific installs, for cross-source identity matching. */
export async function getProductSetsForFuzzyMerge(installIds?: string[]) {
  return prisma.productSet.findMany({
    where: {
      name: { not: null },
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

export async function getAllReleaseEventsForDedup(installIds?: string[]) {
  return prisma.releaseEvent.findMany({
    where: installIds ? { productSet: { tcgProfileInstallId: { in: installIds } } } : undefined,
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

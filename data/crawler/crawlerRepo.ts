import { prisma } from "@/lib/prisma";
import { Prisma } from "@/app/generated/prisma/client";
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
} from "@/app/generated/prisma/client";

/**
 * Accepted by every crawler-write function below in place of the shared
 * `prisma` client -- orchestrate.ts's applyCandidate passes a
 * `$transaction` callback's `tx` through this parameter so a single
 * candidate's whole read-modify-write sequence (product set, event match,
 * claim, confidence recompute) commits once instead of once per statement,
 * without duplicating any of this module's logic for that hot path.
 */
type Db = typeof prisma | Prisma.TransactionClient;

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

export async function recordSourceClaim(
  params: {
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
  },
  db: Db = prisma,
) {
  return db.sourceClaim.create({
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

export async function findOrCreateProductSet(
  params: {
    tcgProfileInstallId: string;
    code: string;
    name: string;
    /** Only overwritten when a source actually yields one, so a source without a description column can't clobber one captured earlier from a richer source. */
    description?: string;
  },
  db: Db = prisma,
) {
  return db.productSet.upsert({
    where: {
      tcgProfileInstallId_code: {
        tcgProfileInstallId: params.tcgProfileInstallId,
        code: params.code,
      },
    },
    update: { name: params.name, ...(params.description ? { description: params.description } : {}) },
    create: params,
  });
}

/**
 * Existing events for a product set + type, for dedup matching (business
 * rule 6.4). Excludes archived (merged-away) events -- otherwise a new claim
 * could silently attach to a frozen duplicate instead of the live survivor,
 * since after a merge they still share the same (productSetId, type).
 */
export async function findEventsForProductSetType(
  productSetId: string,
  type: ReleaseEventType,
  db: Db = prisma,
) {
  return db.releaseEvent.findMany({ where: { productSetId, type, archivedAt: null } });
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
/**
 * EventFollow/EventDismissal are unique per (userId, releaseEventId) --
 * unlike SourceClaim/UserNote, a plain updateMany onto the primary can hit
 * that constraint if the same user already has a row on both the primary
 * and the duplicate (rare, but possible if they interacted with both
 * before this dedup pass ran). Since these are pure flags with nothing to
 * lose, the collision resolves by just dropping the duplicate's row -- the
 * user's "I follow/dismissed this" intent is already satisfied by the
 * primary's row. Written twice (not as one generic helper over a model
 * name) because Prisma's per-model delegate types don't unify cleanly
 * under a single dynamic "tx[model]" call without losing type safety.
 */
async function reassignEventFollows(tx: Prisma.TransactionClient, primaryId: string, duplicateId: string) {
  const primaryUserIds = new Set(
    (await tx.eventFollow.findMany({ where: { releaseEventId: primaryId }, select: { userId: true } })).map(
      (r) => r.userId,
    ),
  );
  const duplicateRows = await tx.eventFollow.findMany({
    where: { releaseEventId: duplicateId },
    select: { id: true, userId: true },
  });
  const collidingIds = duplicateRows.filter((r) => primaryUserIds.has(r.userId)).map((r) => r.id);
  const movableIds = duplicateRows.filter((r) => !primaryUserIds.has(r.userId)).map((r) => r.id);

  if (collidingIds.length > 0) {
    await tx.eventFollow.deleteMany({ where: { id: { in: collidingIds } } });
  }
  if (movableIds.length > 0) {
    await tx.eventFollow.updateMany({
      where: { id: { in: movableIds } },
      data: { releaseEventId: primaryId, movedFromReleaseEventId: duplicateId },
    });
  }
}

/** Same reasoning and collision handling as reassignEventFollows, for EventDismissal. */
async function reassignEventDismissals(tx: Prisma.TransactionClient, primaryId: string, duplicateId: string) {
  const primaryUserIds = new Set(
    (await tx.eventDismissal.findMany({ where: { releaseEventId: primaryId }, select: { userId: true } })).map(
      (r) => r.userId,
    ),
  );
  const duplicateRows = await tx.eventDismissal.findMany({
    where: { releaseEventId: duplicateId },
    select: { id: true, userId: true },
  });
  const collidingIds = duplicateRows.filter((r) => primaryUserIds.has(r.userId)).map((r) => r.id);
  const movableIds = duplicateRows.filter((r) => !primaryUserIds.has(r.userId)).map((r) => r.id);

  if (collidingIds.length > 0) {
    await tx.eventDismissal.deleteMany({ where: { id: { in: collidingIds } } });
  }
  if (movableIds.length > 0) {
    await tx.eventDismissal.updateMany({
      where: { id: { in: movableIds } },
      data: { releaseEventId: primaryId, movedFromReleaseEventId: duplicateId },
    });
  }
}

/** Same reasoning and collision handling as reassignEventFollows, for EventReaction -- a user's pick is just a flag-like emoji string, nothing lost by keeping whichever row already exists on the primary. */
async function reassignEventReactions(tx: Prisma.TransactionClient, primaryId: string, duplicateId: string) {
  const primaryUserIds = new Set(
    (await tx.eventReaction.findMany({ where: { releaseEventId: primaryId }, select: { userId: true } })).map(
      (r) => r.userId,
    ),
  );
  const duplicateRows = await tx.eventReaction.findMany({
    where: { releaseEventId: duplicateId },
    select: { id: true, userId: true },
  });
  const collidingIds = duplicateRows.filter((r) => primaryUserIds.has(r.userId)).map((r) => r.id);
  const movableIds = duplicateRows.filter((r) => !primaryUserIds.has(r.userId)).map((r) => r.id);

  if (collidingIds.length > 0) {
    await tx.eventReaction.deleteMany({ where: { id: { in: collidingIds } } });
  }
  if (movableIds.length > 0) {
    await tx.eventReaction.updateMany({
      where: { id: { in: movableIds } },
      data: { releaseEventId: primaryId, movedFromReleaseEventId: duplicateId },
    });
  }
}

/**
 * Same collision as reassignFlagRows, but a personal note has real content
 * to lose -- silently dropping the duplicate's note the way a flag can be
 * dropped would be actual data loss (something this merge system has never
 * done to SourceClaim/UserNote). Instead, on collision, both notes'
 * content is preserved by appending the duplicate's onto the primary's.
 */
async function reassignEventPersonalNotes(tx: Prisma.TransactionClient, primaryId: string, duplicateId: string) {
  const primaryNotes = await tx.eventPersonalNote.findMany({
    where: { releaseEventId: primaryId },
    select: { id: true, userId: true, content: true },
  });
  const primaryByUser = new Map(primaryNotes.map((n) => [n.userId, n]));

  const duplicateNotes = await tx.eventPersonalNote.findMany({
    where: { releaseEventId: duplicateId },
    select: { id: true, userId: true, content: true },
  });

  for (const note of duplicateNotes) {
    const existing = primaryByUser.get(note.userId);
    if (existing) {
      await tx.eventPersonalNote.update({
        where: { id: existing.id },
        data: { content: `${existing.content}\n\n---\n\n${note.content}` },
      });
      await tx.eventPersonalNote.delete({ where: { id: note.id } });
    } else {
      await tx.eventPersonalNote.update({
        where: { id: note.id },
        data: { releaseEventId: primaryId, movedFromReleaseEventId: duplicateId },
      });
    }
  }
}

export async function mergeReleaseEvents(primaryId: string, duplicateId: string) {
  await prisma.$transaction(async (tx) => {
    await tx.sourceClaim.updateMany({
      where: { releaseEventId: duplicateId, movedFromReleaseEventId: null },
      data: { releaseEventId: primaryId, movedFromReleaseEventId: duplicateId },
    });
    await tx.sourceClaim.updateMany({
      where: { releaseEventId: duplicateId },
      data: { releaseEventId: primaryId },
    });
    await tx.userNote.updateMany({
      where: { releaseEventId: duplicateId, movedFromReleaseEventId: null },
      data: { releaseEventId: primaryId, movedFromReleaseEventId: duplicateId },
    });
    await tx.userNote.updateMany({
      where: { releaseEventId: duplicateId },
      data: { releaseEventId: primaryId },
    });

    await reassignEventFollows(tx, primaryId, duplicateId);
    await reassignEventDismissals(tx, primaryId, duplicateId);
    await reassignEventPersonalNotes(tx, primaryId, duplicateId);
    await reassignEventReactions(tx, primaryId, duplicateId);

    // Note: undoReleaseEventMerge below only restores SourceClaim/UserNote
    // (movedFromReleaseEventId-stamped) back to the duplicate -- it does not
    // reverse the follow/dismissal/note/reaction reassignment above. A deliberate,
    // documented simplification: undo is a rare admin recovery action, and
    // unlike SourceClaim/UserNote's simple move, the collision-handling
    // above (drop/merge) isn't cleanly reversible in the general case.
    await tx.releaseEvent.update({
      where: { id: duplicateId },
      data: { archivedAt: new Date(), mergedIntoId: primaryId },
    });
  });
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
  const where: Prisma.ReleaseEventWhereInput = {
    status: { notIn: ["RELEASED", "CANCELLED"] },
    archivedAt: null,
    ...(installIds ? { productSet: { tcgProfileInstallId: { in: installIds } } } : {}),
    OR: [
      { dateType: "EXACT", dateExact: { lt: now } },
      { dateType: "RANGE", dateEnd: { lt: now } },
      { dateType: "WINDOW", windowEnd: { lt: now } },
    ],
  };

  // Selected before the bulk update (rather than read-then-write per row) so
  // callers can build notification context for exactly the events this pass
  // touched, without turning this back into a row-by-row update.
  const toRelease = await prisma.releaseEvent.findMany({ where, select: { id: true } });
  if (toRelease.length === 0) return { count: 0, eventIds: [] as string[] };

  const eventIds = toRelease.map((event) => event.id);
  await prisma.releaseEvent.updateMany({ where: { id: { in: eventIds } }, data: { status: "RELEASED" } });
  return { count: eventIds.length, eventIds };
}

/** Game/product-set context for a set of release events, for building notification copy after a bulk status change. */
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

/**
 * Permanently deletes ReleaseEvents whose date is more than `olderThanDays`
 * in the past, to keep the live dataset lean -- this is a real delete, not
 * an archive, and deliberately has no archivedAt filter: it applies to
 * merged-away duplicates too, not just live events. A merged duplicate's own
 * date is always close to its survivor's (dedup only merges within
 * PROXIMITY_DAYS), so both sides of a merge age out together. Cascades to
 * SourceClaim/UserNote via the existing onDelete: Cascade. TBD events have
 * no date and are never matched, so they're never deleted by age.
 *
 * `excludeEventIds`, when given, is skipped regardless of date -- see
 * runRetentionCleanupPass's docstring for why orchestrate.ts passes one.
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

/**
 * ProductSets still missing a marketing image, scoped to installs whose
 * package declares an imageSourceConfig (no config, nothing to fetch) and
 * limited to sets that have at least one CONFIRMED, non-archived release
 * event -- the image pass only runs for confirmed releases (business intent:
 * don't spend fetches speculatively chasing RUMORED/ANNOUNCED sets that may
 * never happen or may still get renamed/merged).
 */
export async function getProductSetsNeedingImages(installIds?: string[]) {
  return prisma.productSet.findMany({
    where: {
      imageUrl: null,
      archivedAt: null,
      install: {
        enabled: true,
        package: { imageSourceConfig: { not: Prisma.JsonNull } },
        ...(installIds ? { id: { in: installIds } } : {}),
      },
      releaseEvents: { some: { status: "CONFIRMED", archivedAt: null } },
    },
    select: {
      id: true,
      code: true,
      name: true,
      install: { select: { package: { select: { imageSourceConfig: true } } } },
    },
  });
}

export async function setProductSetImageUrl(id: string, imageUrl: string) {
  return prisma.productSet.update({ where: { id }, data: { imageUrl } });
}

export async function getClaimsForEvent(eventId: string, db: Db = prisma) {
  return db.sourceClaim.findMany({
    where: { releaseEventId: eventId },
    select: { tier: true, disposition: true, confidenceWeight: true },
  });
}

export async function createReleaseEventFromCandidate(
  params: {
    productSetId: string;
    type: ReleaseEventType;
    region: Region;
    dateType: DateType;
    dateExact?: Date | null;
    windowGranularity?: WindowGranularity | null;
    windowStart?: Date | null;
    windowEnd?: Date | null;
  },
  db: Db = prisma,
) {
  return db.releaseEvent.create({ data: params });
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
 *
 * `isManualOverride` lets a caller that already knows the event's current
 * value (e.g. orchestrate.ts's applyCandidate, from the row it just matched
 * or created) skip the extra lookup below -- it's only fetched when omitted
 * and `dateInfo` is actually present (dedupPass.ts/mergeUndo.ts never pass
 * dateInfo, so they never pay for it either way).
 */
export async function updateEventFromClaims(
  eventId: string,
  params: { confidence: number; status: ReleaseStatus; dateInfo?: EventDateFields; isManualOverride?: boolean },
  db: Db = prisma,
) {
  let dateFields: EventDateFields | Record<string, never> = {};
  if (params.dateInfo) {
    const isManualOverride =
      params.isManualOverride ??
      (await db.releaseEvent.findUniqueOrThrow({ where: { id: eventId }, select: { isManualOverride: true } }))
        .isManualOverride;
    if (!isManualOverride) dateFields = params.dateInfo;
  }

  return db.releaseEvent.update({
    where: { id: eventId },
    data: {
      confidence: params.confidence,
      status: params.status,
      lastSeenAt: new Date(),
      ...dateFields,
    },
  });
}

import { prisma } from "@/lib/prisma";
import type { UserRole } from "@/app/generated/prisma/client";
import { startIngest } from "@/lib/ingest/orchestrate";
import { runRetentionCleanupPass } from "@/lib/ingest/retention";
import * as ingestRepo from "@/data/ingest/ingestRepo";
import { evaluateFreshness, PROVIDER_STALE_AFTER_HOURS, runProviderFreshnessAlarmPass } from "@/lib/ingest/freshness";
import { replayRun, retryRun } from "@/lib/ingest/replay";
import { fromEventDateColumns, type CandidateDate, type ReviewDetail, type SerializedDate } from "@/lib/ingest/types";
import { logEvent } from "@/lib/logger";

export async function listPackagesWithInstalls() {
  return prisma.tcgProfilePackage.findMany({
    include: { installs: { include: { _count: { select: { productSets: true } } } } },
    orderBy: { name: "asc" },
  });
}

export async function toggleInstallEnabled(installId: string, enabled: boolean) {
  return prisma.tcgProfileInstall.update({
    where: { id: installId },
    data: { enabled },
  });
}

/**
 * Enables the install and, if it has no product sets yet, creates one
 * placeholder set so the install isn't empty in the UI while the admin
 * waits on real data. The next ingest run supersedes this placeholder with
 * real discovered product sets; it is never overwritten automatically
 * before that.
 */
export async function enableAndSeedInstall(installId: string) {
  const install = await prisma.tcgProfileInstall.update({
    where: { id: installId },
    data: { enabled: true },
    include: { _count: { select: { productSets: true } } },
  });

  if (install._count.productSets === 0) {
    await prisma.productSet.create({
      data: {
        tcgProfileInstallId: installId,
        code: `PLACEHOLDER-${installId}`,
        name: "Placeholder product set (awaiting crawler data)",
        meta: { placeholder: true },
      },
    });
  }

  return install;
}

export async function listUsers() {
  return prisma.user.findMany({ orderBy: { createdAt: "asc" } });
}

export async function setUserRole(userId: string, role: UserRole) {
  return prisma.user.update({ where: { id: userId }, data: { role } });
}

export async function setUserActive(userId: string, active: boolean) {
  return prisma.user.update({ where: { id: userId }, data: { active } });
}

/**
 * Manual override, independent of the real Stripe billing in
 * data/billing/billingRepo.ts. Setting premiumOverride alongside isPremium
 * tells the webhook (syncSubscriptionFromStripe/clearSubscription) to leave
 * isPremium alone on future subscription events, so this grant survives a
 * routine renewal/cancellation webhook until the user completes a real
 * checkout (which clears the override) or an admin toggles it again.
 */
export async function setUserPremium(userId: string, isPremium: boolean) {
  return prisma.user.update({ where: { id: userId }, data: { isPremium, premiumOverride: true } });
}

export async function listScanRuns(installId?: string) {
  return prisma.scanRun.findMany({
    where: installId ? { scopeId: installId } : undefined,
    orderBy: { createdAt: "desc" },
    take: 50,
  });
}

/**
 * Fire-and-forget, mirroring app/api/ingest/run/route.ts's own trigger: a
 * full rescan can take tens of seconds, and this is called directly from a
 * Server Action awaited by the browser (SystemTab.tsx) -- awaiting it here
 * risks the request outliving the reverse proxy's read timeout even though
 * the scan itself would have succeeded. startIngest's ScanRun row is what
 * the admin System tab already polls, so there's nothing this loses except
 * the immediate result, which the return value below still reports (a
 * double-click or two admins racing the same install now surfaces as
 * `started: false` rather than a silent no-op).
 */
export async function triggerRescan(installId: string): Promise<{ started: boolean; reason?: string }> {
  const result = await startIngest({ scope: { scopeType: "INSTALL", scopeId: installId }, trigger: "MANUAL" });
  if (!result.started) {
    return { started: false, reason: result.reason };
  }

  result.completed.catch((error) => {
    logEvent({
      action: "admin.triggerRescan.background",
      tcgProfileInstallId: installId,
      scanRunId: result.scanRunId,
      outcome: "error",
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return { started: true };
}

export async function triggerRetentionCleanup() {
  return runRetentionCleanupPass();
}

// ---------------------------------------------------------------------------
// v2 ingest: provider health, replay/retry, freshness alarms
//
// Phases 1-4 record all of this (ProviderRun, ProviderEtag, ProviderAlarm) and
// nothing displayed it. The reads live here rather than in the component, so
// the System tab stays a rendering concern -- same split as the rest of this
// file.
// ---------------------------------------------------------------------------

export type ProviderRunSummary = {
  providerKey: string;
  status: string;
  candidates: number;
  error: string | null;
  startedAt: Date;
  finishedAt: Date | null;
  durationMs: number | null;
};

/**
 * Whether a run's providers all worked, all failed, or -- the case worth
 * naming -- some of each.
 *
 * PARTIAL exists because ScanRun.status cannot express it: a run where four
 * providers succeeded and one failed is stored as SUCCEEDED (deliberately; see
 * orchestrate.ts's finalize comment), and reading that as "fine" is how a
 * provider stays broken for a fortnight. Reading it as "failed" is no better,
 * because it invites an operator to re-run the four that worked. So the
 * distinction is computed here and shown as its own state.
 */
export type RunHealthStatus = "OK" | "PARTIAL" | "FAILED" | "NO_PROVIDERS";

export type IngestRunHealth = {
  id: string;
  scopeType: string;
  scopeId: string | null;
  status: string;
  trigger: string;
  retryOfRunId: string | null;
  createdAt: Date;
  finishedAt: Date | null;
  providerRuns: ProviderRunSummary[];
  providerHealth: RunHealthStatus;
  /** Whether any provider FAILED, i.e. whether "Retry failed" has anything to do. */
  hasFailedProviders: boolean;
};

function healthFor(providerRuns: ProviderRunSummary[]): RunHealthStatus {
  if (providerRuns.length === 0) return "NO_PROVIDERS";
  const failed = providerRuns.filter((run) => run.status === "FAILED").length;
  if (failed === 0) return "OK";
  return failed === providerRuns.length ? "FAILED" : "PARTIAL";
}

/**
 * Recent ScanRuns with each run's per-provider outcome attached.
 *
 * ProviderRun has no Prisma relation to ScanRun (it is keyed by a plain
 * scanRunId string -- see schema.prisma), so this is two queries joined in
 * memory rather than an `include`.
 */
export async function listIngestRunHealth(limit = 10): Promise<IngestRunHealth[]> {
  const runs = await prisma.scanRun.findMany({ orderBy: { createdAt: "desc" }, take: limit });
  if (runs.length === 0) return [];

  const providerRuns = await prisma.providerRun.findMany({
    where: { scanRunId: { in: runs.map((run) => run.id) } },
    orderBy: [{ providerKey: "asc" }],
  });

  const byRun = new Map<string, ProviderRunSummary[]>();
  for (const row of providerRuns) {
    const list = byRun.get(row.scanRunId) ?? [];
    list.push({
      providerKey: row.providerKey,
      status: row.status,
      candidates: row.candidates,
      error: row.error,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      durationMs: row.finishedAt ? row.finishedAt.getTime() - row.startedAt.getTime() : null,
    });
    byRun.set(row.scanRunId, list);
  }

  return runs.map((run) => {
    const rows = byRun.get(run.id) ?? [];
    return {
      id: run.id,
      scopeType: run.scopeType,
      scopeId: run.scopeId,
      status: run.status,
      trigger: run.trigger,
      retryOfRunId: run.retryOfRunId,
      createdAt: run.createdAt,
      finishedAt: run.finishedAt,
      providerRuns: rows,
      providerHealth: healthFor(rows),
      hasFailedProviders: rows.some((row) => row.status === "FAILED"),
    };
  });
}

export type ProviderHealth = {
  providerKey: string;
  /** Last run in which the provider returned OK or NOT_MODIFIED. */
  lastOkAt: Date | null;
  hoursSinceOk: number | null;
  stale: boolean;
  /** The provider's most recent outcome, which can be worse than its last success suggests. */
  latestStatus: string | null;
  latestError: string | null;
  latestAt: Date | null;
  /** Non-null when an alarm is currently standing for this provider. */
  alarm: { openedAt: Date; notifiedAt: Date } | null;
};

/** The threshold the UI quotes, re-exported so the tab never restates the number itself. */
export const PROVIDER_STALE_HOURS = PROVIDER_STALE_AFTER_HOURS;

/**
 * Per-provider freshness for the System tab: when each provider last returned
 * usable data, what it did most recently, and whether an alarm is standing.
 *
 * Freshness is recomputed here with the same pure function the alarm pass uses
 * (evaluateFreshness) rather than read off ProviderAlarm, so the tab shows the
 * live condition even before anything has run the alarm pass -- the alarm row
 * only ever answers "has anyone been told".
 */
export async function listProviderHealth(now: Date = new Date()): Promise<ProviderHealth[]> {
  const [timestamps, latestRuns, alarms] = await Promise.all([
    ingestRepo.getProviderRunTimestamps(),
    ingestRepo.getLatestProviderRuns(),
    ingestRepo.listProviderAlarms(),
  ]);

  const latestByKey = new Map(latestRuns.map((row) => [row.providerKey, row]));
  const alarmByKey = new Map(alarms.filter((row) => row.clearedAt === null).map((row) => [row.providerKey, row]));

  return evaluateFreshness(timestamps, now).map((freshness) => {
    const latest = latestByKey.get(freshness.providerKey);
    const alarm = alarmByKey.get(freshness.providerKey);
    return {
      providerKey: freshness.providerKey,
      lastOkAt: freshness.lastOkAt,
      hoursSinceOk: freshness.hoursSinceOk,
      stale: freshness.stale,
      latestStatus: latest?.status ?? null,
      latestError: latest?.error ?? null,
      latestAt: latest?.startedAt ?? null,
      alarm: alarm ? { openedAt: alarm.openedAt, notifiedAt: alarm.notifiedAt } : null,
    };
  });
}

/**
 * Re-runs Normalize -> Apply over a stored run's payloads. No network I/O of
 * any kind (lib/ingest/replay.ts), which is the whole point: it answers "what
 * would today's code have concluded from that day's bytes".
 *
 * Awaited rather than fired into the background, unlike triggerRescan: a replay
 * does no fetching, so it is bounded by database work and returns in about as
 * long as a page render.
 */
export async function triggerIngestReplay(runId: string) {
  return replayRun(runId);
}

/** Re-fetches only the providers that FAILED in a run, merges them into it, and replays. This one does touch the network. */
export async function triggerIngestRetry(runId: string) {
  return retryRun(runId);
}

export async function triggerFreshnessAlarmPass() {
  return runProviderFreshnessAlarmPass();
}

// ---------------------------------------------------------------------------
// v2 ingest: review queue
// ---------------------------------------------------------------------------

export type ReviewClaim = {
  index: number;
  origin: string;
  tier: string;
  date: SerializedDate;
  consecutiveRuns: number;
  seenInCurrentRun: boolean;
  lastSeenAt: string;
  url?: string;
};

export type ReviewQueueItem = {
  id: string;
  reason: string;
  /**
   * The plain-language explanation a future automated reviewer would write.
   * Null today, for every row. The UI renders the claim comparison instead
   * when it is null and does not synthesize prose -- an invented summary of a
   * date conflict is precisely the sort of confident-sounding wrong thing a
   * human would act on without re-checking.
   */
  summary: string | null;
  createdAt: Date;
  eventId: string;
  eventType: string;
  eventRegion: string;
  eventStatus: string;
  isManualOverride: boolean;
  gameName: string;
  productSetName: string | null;
  productSetCode: string | null;
  /** What the calendar shows right now, read from the event row rather than from the stored detail. */
  currentDate: CandidateDate | null;
  publishedDate: SerializedDate | null;
  proposedDate: SerializedDate | null;
  gapDays: number | null;
  claims: ReviewClaim[];
};

/**
 * Narrows ReviewItem.detail (a Json column, so `unknown` as far as the type
 * system is concerned) to the shape the gate writes. Anything that does not
 * match degrades to "no claims" rather than throwing: a review queue that 500s
 * because one historical row has an older detail shape is worse than one that
 * shows that row with its claims missing.
 */
function toReviewDetail(detail: unknown): ReviewDetail {
  const empty: ReviewDetail = { publishedDate: null, proposedDate: null, gapDays: null, claims: [] };
  if (!detail || typeof detail !== "object") return empty;
  const candidate = detail as Partial<ReviewDetail>;
  return {
    publishedDate: candidate.publishedDate ?? null,
    proposedDate: candidate.proposedDate ?? null,
    gapDays: typeof candidate.gapDays === "number" ? candidate.gapDays : null,
    claims: Array.isArray(candidate.claims) ? candidate.claims : [],
  };
}

export async function listReviewQueue(): Promise<ReviewQueueItem[]> {
  const items = await ingestRepo.listOpenReviewItems();

  return items.map((item) => {
    const detail = toReviewDetail(item.detail);
    const currentDate = fromEventDateColumns(item.releaseEvent);
    return {
      id: item.id,
      reason: item.reason,
      summary: item.summary,
      createdAt: item.createdAt,
      eventId: item.releaseEvent.id,
      eventType: item.releaseEvent.type,
      eventRegion: item.releaseEvent.region,
      eventStatus: item.releaseEvent.status,
      isManualOverride: item.releaseEvent.isManualOverride,
      gameName: item.releaseEvent.productSet.install.package.name,
      productSetName: item.releaseEvent.productSet.name,
      productSetCode: item.releaseEvent.productSet.code,
      currentDate: currentDate.kind === "TBD" ? null : currentDate,
      publishedDate: detail.publishedDate,
      proposedDate: detail.proposedDate,
      gapDays: detail.gapDays,
      claims: detail.claims.map((claim, index) => ({
        index,
        origin: claim.origin,
        tier: claim.tier,
        date: claim.date,
        consecutiveRuns: claim.consecutiveRuns,
        seenInCurrentRun: claim.seenInCurrentRun,
        lastSeenAt: claim.lastSeenAt,
        url: claim.url,
      })),
    };
  });
}

export async function countOpenReviewItems(): Promise<number> {
  return ingestRepo.countOpenReviewItems();
}

/** Inverse of lib/ingest/types.ts's serializeDate, for turning a stored claim back into a writable date. */
function deserializeDate(date: SerializedDate): CandidateDate {
  switch (date.kind) {
    case "EXACT":
      return { kind: "EXACT", date: new Date(date.date) };
    case "RANGE":
      return { kind: "RANGE", start: new Date(date.start), end: new Date(date.end) };
    case "WINDOW":
      return { kind: "WINDOW", granularity: date.granularity, start: new Date(date.start), end: new Date(date.end) };
    case "TBD":
      return { kind: "TBD" };
  }
}

export type ReviewResolution =
  /** Take this claim's date, and pin it so no later scan silently undoes the decision. */
  | { kind: "accept"; claimIndex: number; note?: string }
  /** The published value is right as it stands; the item closes without touching the event. */
  | { kind: "keep"; note?: string }
  /** Neither -- the item was noise. Closed, event untouched. */
  | { kind: "dismiss"; note?: string };

/**
 * Applies a human's decision to a review item.
 *
 * Only "accept" writes to the event, and it always sets isManualOverride --
 * see ingestRepo.resolveReviewItem for why that flag is the point of the
 * action rather than an extra.
 */
export async function resolveReviewItem(id: string, resolution: ReviewResolution, now: Date = new Date()) {
  const item = await ingestRepo.getReviewItem(id);
  if (!item) throw new Error("No such review item.");

  let acceptedDate: CandidateDate | null = null;
  let note: string;

  if (resolution.kind === "accept") {
    const detail = toReviewDetail(item.detail);
    const claim = detail.claims[resolution.claimIndex];
    if (!claim) throw new Error("That claim is no longer part of this review item.");
    acceptedDate = deserializeDate(claim.date);
    note = resolution.note?.trim() || `Accepted ${claim.origin} (${claim.tier})`;
  } else if (resolution.kind === "keep") {
    note = resolution.note?.trim() || "Kept the currently published date";
  } else {
    note = resolution.note?.trim() || "Dismissed";
  }

  const resolved = await ingestRepo.resolveReviewItem({ id, note, acceptedDate, now });

  logEvent({
    action: "admin.resolveReviewItem",
    reviewItemId: id,
    releaseEventId: item.releaseEventId,
    resolution: resolution.kind,
    outcome: "success",
  });

  return resolved;
}

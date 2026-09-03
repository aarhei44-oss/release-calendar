import type { Prisma, ScanScopeType, ScanTrigger, TcgProfileInstall, TcgProfilePackage } from "@/app/generated/prisma/client";
import * as crawlerRepo from "@/data/crawler/crawlerRepo";
import { logEvent } from "@/lib/logger";
import { dispatchScanChangeNotifications } from "@/lib/notifications/dispatch";
import type { ScanChange } from "@/lib/notifications/types";
import { runDedupPass } from "./dedupPass";
import { runReleaseLifecyclePass } from "./lifecycle";
import { runRetentionCleanupPass } from "./retention";
import { getAdapter } from "./adapters/registry";
import type { ParsedCandidate, SourceConfig } from "./adapters/types";
import { computeConfidenceAndStatus } from "./confidence";
import { dispositionFor, findMatchingEvent, type EventDateInfo } from "./dedup";

const LOCK_TTL_MS = 10 * 60 * 1000;
const JOB_NAME = "crawler";

export type ScanTotals = {
  installsScanned: number;
  sourcesFetched: number;
  claimsCreated: number;
  eventsCreated: number;
  eventsUpdated: number;
  errors: number;
  eventsMerged: number;
  productSetsMerged: number;
  eventsReleased: number;
  eventsDeleted: number;
  productSetsPurged: number;
};

export type ScanResult =
  | { skipped: true; reason: string }
  | { skipped: false; scanRunId: string; totals: ScanTotals };

export async function runScan(params: {
  scopeType: ScanScopeType;
  scopeId?: string;
  trigger: ScanTrigger;
}): Promise<ScanResult> {
  const start = Date.now();
  const lockScopeKey = params.scopeType === "INSTALL" && params.scopeId ? params.scopeId : "global";
  const lock = await crawlerRepo.acquireJobLock(JOB_NAME, lockScopeKey, LOCK_TTL_MS);
  if (!lock) {
    logEvent({
      action: "crawler.runScan",
      scopeType: params.scopeType,
      scopeId: params.scopeId,
      trigger: params.trigger,
      durationMs: Date.now() - start,
      outcome: "skipped",
    });
    return { skipped: true, reason: "a scan is already running for this scope" };
  }

  const scanRun = await crawlerRepo.createScanRun({
    scopeType: params.scopeType,
    scopeId: params.scopeId,
    trigger: params.trigger,
  });

  const totals: ScanTotals = {
    installsScanned: 0,
    sourcesFetched: 0,
    claimsCreated: 0,
    eventsCreated: 0,
    eventsUpdated: 0,
    errors: 0,
    eventsMerged: 0,
    productSetsMerged: 0,
    eventsReleased: 0,
    eventsDeleted: 0,
    productSetsPurged: 0,
  };

  const changes: ScanChange[] = [];

  try {
    const installs = await crawlerRepo.getInstallsForScan(params.scopeType, params.scopeId);

    for (const install of installs) {
      totals.installsScanned += 1;
      const sourceConfigs = parseSourceConfigs(install.package.sourceConfigs);

      for (const sourceConfig of sourceConfigs) {
        const adapter = getAdapter(sourceConfig.parser);
        if (!adapter) {
          totals.errors += 1;
          continue;
        }

        try {
          const raw = await adapter.fetch(sourceConfig);
          await crawlerRepo.recordDiscoveryHit({
            tcgProfileInstallId: install.id,
            url: sourceConfig.url,
            raw: { status: raw.status } as Prisma.InputJsonValue,
          });
          totals.sourcesFetched += 1;

          const candidates = adapter.parse(raw, sourceConfig);
          for (const candidate of candidates) {
            const { created, change } = await applyCandidate(install, sourceConfig, candidate);
            totals.claimsCreated += 1;
            if (created) totals.eventsCreated += 1;
            else totals.eventsUpdated += 1;
            if (change) changes.push(change);
          }
        } catch (error) {
          totals.errors += 1;
          logEvent({
            action: "crawler.fetchSource",
            scanRunId: scanRun.id,
            url: sourceConfig.url,
            outcome: "error",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    try {
      const dedupResult = await runDedupPass({ installIds: installs.map((install) => install.id) });
      totals.eventsMerged = dedupResult.eventsMerged;
      totals.productSetsMerged = dedupResult.productSetsMerged;
    } catch (error) {
      totals.errors += 1;
      logEvent({
        action: "crawler.postScanDedup",
        scanRunId: scanRun.id,
        outcome: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      const lifecycleResult = await runReleaseLifecyclePass({ installIds: installs.map((install) => install.id) });
      totals.eventsReleased = lifecycleResult.eventsReleased;
      if (lifecycleResult.releasedEventIds.length > 0) {
        const context = await crawlerRepo.getChangeContextForEvents(lifecycleResult.releasedEventIds);
        for (const c of context) {
          changes.push({
            installId: c.installId,
            eventId: c.eventId,
            gameName: c.gameName,
            productSetName: c.productSetName,
            status: "RELEASED",
            kind: "released",
          });
        }
      }
    } catch (error) {
      totals.errors += 1;
      logEvent({
        action: "crawler.postScanReleaseLifecycle",
        scanRunId: scanRun.id,
        outcome: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      const retentionResult = await runRetentionCleanupPass({ installIds: installs.map((install) => install.id) });
      totals.eventsDeleted = retentionResult.eventsDeleted;
      totals.productSetsPurged = retentionResult.productSetsPurged;
    } catch (error) {
      totals.errors += 1;
      logEvent({
        action: "crawler.postScanRetention",
        scanRunId: scanRun.id,
        outcome: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      await dispatchScanChangeNotifications(changes);
    } catch (error) {
      totals.errors += 1;
      logEvent({
        action: "crawler.postScanNotifications",
        scanRunId: scanRun.id,
        outcome: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }

    await crawlerRepo.finalizeScanRun(scanRun.id, {
      status: "SUCCEEDED",
      totals: totals as unknown as Prisma.InputJsonValue,
    });
    logEvent({
      action: "crawler.runScan",
      scanRunId: scanRun.id,
      scopeType: params.scopeType,
      scopeId: params.scopeId,
      trigger: params.trigger,
      durationMs: Date.now() - start,
      outcome: "success",
      ...totals,
    });
    return { skipped: false, scanRunId: scanRun.id, totals };
  } catch (error) {
    await crawlerRepo.finalizeScanRun(scanRun.id, {
      status: "FAILED",
      totals: totals as unknown as Prisma.InputJsonValue,
    });
    logEvent({
      action: "crawler.runScan",
      scanRunId: scanRun.id,
      scopeType: params.scopeType,
      scopeId: params.scopeId,
      trigger: params.trigger,
      durationMs: Date.now() - start,
      outcome: "error",
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    await crawlerRepo.releaseJobLock(JOB_NAME, lockScopeKey);
  }
}

async function applyCandidate(
  install: TcgProfileInstall & { package: TcgProfilePackage },
  sourceConfig: SourceConfig,
  candidate: ParsedCandidate,
): Promise<{ created: boolean; change: ScanChange | null }> {
  const productSet = await crawlerRepo.findOrCreateProductSet({
    tcgProfileInstallId: install.id,
    code: candidate.productSetCode,
    name: candidate.productSetName,
  });

  const candidateDateInfo = toDateInfo(candidate);
  const existingEvents = await crawlerRepo.findEventsForProductSetType(productSet.id, candidate.eventType);
  const matchedExisting = findMatchingEvent(candidateDateInfo, existingEvents);

  const event =
    matchedExisting ??
    (await crawlerRepo.createReleaseEventFromCandidate({
      productSetId: productSet.id,
      type: candidate.eventType,
      region: candidate.region,
      ...candidateDateInfo,
    }));
  const created = !matchedExisting;

  const disposition = dispositionFor(candidateDateInfo, created ? null : matchedExisting);

  await crawlerRepo.recordSourceClaim({
    releaseEventId: event.id,
    tier: sourceConfig.tier,
    disposition,
    confidenceWeight: 0.8,
    url: sourceConfig.url,
    host: safeHostname(sourceConfig.url),
    ...dateFieldsForClaim(candidateDateInfo),
  });

  const claims = await crawlerRepo.getClaimsForEvent(event.id);
  const { confidence, status } = computeConfidenceAndStatus(claims);
  const previousStatus = created ? null : matchedExisting.status;
  const updated = await crawlerRepo.updateEventFromClaims(event.id, { confidence, status, dateInfo: candidateDateInfo });

  const productSetName = productSet.name ?? productSet.code ?? "Untitled release";
  let change: ScanChange | null = null;
  if (created) {
    change = {
      installId: install.id,
      eventId: updated.id,
      gameName: install.package.name,
      productSetName,
      status: updated.status,
      kind: "created",
    };
  } else if (previousStatus !== updated.status) {
    change = {
      installId: install.id,
      eventId: updated.id,
      gameName: install.package.name,
      productSetName,
      status: updated.status,
      kind: "status_changed",
      previousStatus: previousStatus ?? undefined,
    };
  }

  return { created, change };
}

function toDateInfo(candidate: ParsedCandidate): EventDateInfo {
  switch (candidate.dateType) {
    case "EXACT":
      return { dateType: "EXACT", dateExact: candidate.dateExact };
    case "WINDOW":
      return {
        dateType: "WINDOW",
        windowGranularity: candidate.windowGranularity,
        windowStart: candidate.windowStart,
        windowEnd: candidate.windowEnd,
      };
    case "TBD":
      return { dateType: "TBD" };
  }
}

function dateFieldsForClaim(dateInfo: EventDateInfo): { dateExact?: Date; dateStart?: Date; dateEnd?: Date } {
  if (dateInfo.dateType === "EXACT" && dateInfo.dateExact) {
    return { dateExact: dateInfo.dateExact };
  }
  if (dateInfo.dateType === "WINDOW" && dateInfo.windowStart && dateInfo.windowEnd) {
    return { dateStart: dateInfo.windowStart, dateEnd: dateInfo.windowEnd };
  }
  return {};
}

function safeHostname(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function parseSourceConfigs(json: Prisma.JsonValue): SourceConfig[] {
  if (!Array.isArray(json)) return [];
  const configs: SourceConfig[] = [];
  for (const entry of json) {
    if (
      entry &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      typeof (entry as Record<string, unknown>).url === "string" &&
      typeof (entry as Record<string, unknown>).tier === "string" &&
      typeof (entry as Record<string, unknown>).parser === "string"
    ) {
      configs.push(entry as unknown as SourceConfig);
    }
  }
  return configs;
}

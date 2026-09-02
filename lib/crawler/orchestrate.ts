import type { Prisma, ScanScopeType, ScanTrigger } from "@/app/generated/prisma/client";
import * as crawlerRepo from "@/data/crawler/crawlerRepo";
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
};

export type ScanResult =
  | { skipped: true; reason: string }
  | { skipped: false; scanRunId: string; totals: ScanTotals };

export async function runScan(params: {
  scopeType: ScanScopeType;
  scopeId?: string;
  trigger: ScanTrigger;
}): Promise<ScanResult> {
  const lockScopeKey = params.scopeType === "INSTALL" && params.scopeId ? params.scopeId : "global";
  const lock = await crawlerRepo.acquireJobLock(JOB_NAME, lockScopeKey, LOCK_TTL_MS);
  if (!lock) {
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
  };

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
            const { created } = await applyCandidate(install.id, sourceConfig, candidate);
            totals.claimsCreated += 1;
            if (created) totals.eventsCreated += 1;
            else totals.eventsUpdated += 1;
          }
        } catch (error) {
          totals.errors += 1;
          console.error(`[crawler] source failed url=${sourceConfig.url}`, error);
        }
      }
    }

    await crawlerRepo.finalizeScanRun(scanRun.id, {
      status: "SUCCEEDED",
      totals: totals as unknown as Prisma.InputJsonValue,
    });
    return { skipped: false, scanRunId: scanRun.id, totals };
  } catch (error) {
    await crawlerRepo.finalizeScanRun(scanRun.id, {
      status: "FAILED",
      totals: totals as unknown as Prisma.InputJsonValue,
    });
    throw error;
  } finally {
    await crawlerRepo.releaseJobLock(JOB_NAME, lockScopeKey);
  }
}

async function applyCandidate(installId: string, sourceConfig: SourceConfig, candidate: ParsedCandidate) {
  const productSet = await crawlerRepo.findOrCreateProductSet({
    tcgProfileInstallId: installId,
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
  await crawlerRepo.updateEventFromClaims(event.id, { confidence, status, dateInfo: candidateDateInfo });

  return { created };
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

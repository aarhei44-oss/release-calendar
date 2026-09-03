import type { Prisma, ScanScopeType, ScanTrigger, TcgProfileInstall, TcgProfilePackage } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import * as crawlerRepo from "@/data/crawler/crawlerRepo";
import { logEvent } from "@/lib/logger";
import { dispatchScanChangeNotifications } from "@/lib/notifications/dispatch";
import type { ScanChange } from "@/lib/notifications/types";
import { runDedupPass } from "./dedupPass";
import { runReleaseLifecyclePass } from "./lifecycle";
import { runImageEnrichmentPass } from "./imageEnrichment";
import { runRetentionCleanupPass } from "./retention";
import { getAdapter } from "./adapters/registry";
import type { ParsedCandidate, SourceConfig } from "./adapters/types";
import { computeConfidenceAndStatus } from "./confidence";
import { dispositionFor, findMatchingEvent, type EventDateInfo } from "./dedup";

const LOCK_TTL_MS = 10 * 60 * 1000;
const JOB_NAME = "crawler";

// Source fetches are independent network I/O (each with its own 15s
// timeout in the adapter), so running several at once cuts total scan wall
// time substantially. Capped rather than unbounded so a scan across many
// installs doesn't open dozens of sockets to external sites at once.
const SOURCE_FETCH_CONCURRENCY = 4;

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
  imagesFetched: number;
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
    imagesFetched: 0,
  };

  const changes: ScanChange[] = [];

  try {
    const installs = await crawlerRepo.getInstallsForScan(params.scopeType, params.scopeId);

    type ScanTask = { install: (typeof installs)[number]; sourceConfig: SourceConfig };
    const tasks: ScanTask[] = [];
    for (const install of installs) {
      totals.installsScanned += 1;
      const sourceConfigs = parseSourceConfigs(install.package.sourceConfigs, install.id, scanRun.id);
      for (const sourceConfig of sourceConfigs) {
        tasks.push({ install, sourceConfig });
      }
    }

    await mapWithConcurrency(tasks, SOURCE_FETCH_CONCURRENCY, ({ install, sourceConfig }) =>
      scanSource(install, sourceConfig, scanRun.id, totals, changes),
    );

    await runPassSafely("crawler.postScanDedup", scanRun.id, totals, async () => {
      const dedupResult = await runDedupPass({ installIds: installs.map((install) => install.id) });
      totals.eventsMerged = dedupResult.eventsMerged;
      totals.productSetsMerged = dedupResult.productSetsMerged;
    });

    await runPassSafely("crawler.postScanReleaseLifecycle", scanRun.id, totals, async () => {
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
    });

    await runPassSafely("crawler.postScanImageEnrichment", scanRun.id, totals, async () => {
      const imageResult = await runImageEnrichmentPass({ installIds: installs.map((install) => install.id) });
      totals.imagesFetched = imageResult.imagesFetched;
      totals.errors += imageResult.errors;
    });

    await runPassSafely("crawler.postScanRetention", scanRun.id, totals, async () => {
      const retentionResult = await runRetentionCleanupPass({ installIds: installs.map((install) => install.id) });
      totals.eventsDeleted = retentionResult.eventsDeleted;
      totals.productSetsPurged = retentionResult.productSetsPurged;
    });

    await runPassSafely("crawler.postScanNotifications", scanRun.id, totals, () =>
      dispatchScanChangeNotifications(changes),
    );

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

/**
 * Runs one post-scan pass, converting a thrown error into a counted,
 * logged failure instead of aborting the rest of the scan -- every pass
 * after the main fetch loop (dedup, lifecycle, image enrichment, retention,
 * notifications) is independent of the others, so one failing shouldn't
 * skip the rest. `fn` is expected to mutate `totals`/`changes` itself
 * (mirroring what it did before this was split out) rather than return a
 * value, so a pass's own internal ordering -- e.g. lifecycle sets
 * `totals.eventsReleased` before it builds notification context, so that
 * count survives even if the context lookup itself throws -- is unchanged.
 */
async function runPassSafely(
  action: string,
  scanRunId: string,
  totals: ScanTotals,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    totals.errors += 1;
    logEvent({
      action,
      scanRunId,
      outcome: "error",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Runs `fn` over `items` with at most `limit` in flight at once, order-independent (results are side effects on shared state, not collected). */
async function mapWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

async function scanSource(
  install: TcgProfileInstall & { package: TcgProfilePackage },
  sourceConfig: SourceConfig,
  scanRunId: string,
  totals: ScanTotals,
  changes: ScanChange[],
): Promise<void> {
  const adapter = getAdapter(sourceConfig.parser);
  if (!adapter) {
    totals.errors += 1;
    logEvent({
      action: "crawler.unknownParser",
      scanRunId,
      tcgProfileInstallId: install.id,
      url: sourceConfig.url,
      parser: sourceConfig.parser,
      outcome: "error",
    });
    return;
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
      // Isolated per candidate -- a single bad row (e.g. a DB constraint
      // hiccup) shouldn't silently drop every candidate after it in what
      // can be a source with 1000+ rows (business rule: partial progress
      // beats an all-or-nothing batch here, since each candidate is an
      // independent claim).
      try {
        const { created, change } = await applyCandidate(install, sourceConfig, candidate);
        totals.claimsCreated += 1;
        if (created) totals.eventsCreated += 1;
        else totals.eventsUpdated += 1;
        if (change) changes.push(change);
      } catch (error) {
        totals.errors += 1;
        logEvent({
          action: "crawler.applyCandidate",
          scanRunId,
          url: sourceConfig.url,
          productSetCode: candidate.productSetCode,
          outcome: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } catch (error) {
    totals.errors += 1;
    logEvent({
      action: "crawler.fetchSource",
      scanRunId,
      url: sourceConfig.url,
      outcome: "error",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Applies one parsed candidate: finds/creates its ProductSet, matches or
 * creates its ReleaseEvent, records the source claim, and recomputes
 * confidence/status. Wrapped in a single transaction (passed through to
 * crawlerRepo as `tx`) so this whole read-modify-write sequence commits
 * once instead of once per statement -- this runs once per candidate, and
 * a large source (yugioh-tcg's yugiohcardlist.com alone yields 1000+) turns
 * that per-statement commit overhead into the dominant cost of a scan.
 */
async function applyCandidate(
  install: TcgProfileInstall & { package: TcgProfilePackage },
  sourceConfig: SourceConfig,
  candidate: ParsedCandidate,
): Promise<{ created: boolean; change: ScanChange | null }> {
  return prisma.$transaction(async (tx) => {
    const productSet = await crawlerRepo.findOrCreateProductSet(
      {
        tcgProfileInstallId: install.id,
        code: candidate.productSetCode,
        name: candidate.productSetName,
      },
      tx,
    );

    const candidateDateInfo = toDateInfo(candidate);
    const existingEvents = await crawlerRepo.findEventsForProductSetType(productSet.id, candidate.eventType, tx);
    const matchedExisting = findMatchingEvent(candidateDateInfo, existingEvents);

    const event =
      matchedExisting ??
      (await crawlerRepo.createReleaseEventFromCandidate(
        {
          productSetId: productSet.id,
          type: candidate.eventType,
          region: candidate.region,
          ...candidateDateInfo,
        },
        tx,
      ));
    const created = !matchedExisting;

    const disposition = dispositionFor(candidateDateInfo, created ? null : matchedExisting);

    await crawlerRepo.recordSourceClaim(
      {
        releaseEventId: event.id,
        tier: sourceConfig.tier,
        disposition,
        confidenceWeight: 0.8,
        url: sourceConfig.url,
        host: safeHostname(sourceConfig.url),
        ...dateFieldsForClaim(candidateDateInfo),
      },
      tx,
    );

    const claims = await crawlerRepo.getClaimsForEvent(event.id, tx);
    const { confidence, status } = computeConfidenceAndStatus(claims);
    const previousStatus = created ? null : matchedExisting.status;
    const updated = await crawlerRepo.updateEventFromClaims(
      event.id,
      {
        confidence,
        status,
        dateInfo: candidateDateInfo,
        isManualOverride: created ? false : matchedExisting.isManualOverride,
      },
      tx,
    );

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
  });
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

function parseSourceConfigs(json: Prisma.JsonValue, installId: string, scanRunId: string): SourceConfig[] {
  if (!Array.isArray(json)) return [];
  const configs: SourceConfig[] = [];
  for (const [index, entry] of json.entries()) {
    if (
      entry &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      typeof (entry as Record<string, unknown>).url === "string" &&
      typeof (entry as Record<string, unknown>).tier === "string" &&
      typeof (entry as Record<string, unknown>).parser === "string"
    ) {
      configs.push(entry as unknown as SourceConfig);
    } else {
      logEvent({
        action: "crawler.invalidSourceConfig",
        scanRunId,
        tcgProfileInstallId: installId,
        index,
        outcome: "error",
      });
    }
  }
  return configs;
}

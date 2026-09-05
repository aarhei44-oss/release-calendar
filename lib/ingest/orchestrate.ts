import type { Prisma, ScanScopeType, ScanTrigger } from "@/app/generated/prisma/client";
import * as crawlerRepo from "@/data/crawler/crawlerRepo";
import * as ingestRepo from "@/data/ingest/ingestRepo";
import { logEvent } from "@/lib/logger";
import { applyVerdicts, type ApplyItem, type ClaimWrite } from "./apply";
import { buildClaimRecords } from "./claims";
import { runProviderFreshnessAlarmPass } from "./freshness";
import { evaluateGate } from "./gate";
import { collectAmbiguousCodes, resolveSetIdentity } from "./identity";
import { normalizeRun } from "./normalize";
import { getProvider, providersForGames } from "./providers/registry";
import type { FetchContext, Provider } from "./providers/types";
import {
  ORIGINS,
  type Candidate,
  type ClaimRecord,
  type Origin,
  type RawPayloadRecord,
  type ResolvedCandidate,
} from "./types";

/**
 * Wires the six stages: Fetch -> Normalize -> Identity -> Gate -> Apply -> Diff.
 *
 * Only the Fetch loop below touches the network, and it does nothing with what
 * it fetches except hash it, gzip it and write it down. Everything after
 * `runStagesFromPayloads` is a pure-ish function of stored bytes plus the
 * database's current state, which is what lets lib/ingest/replay.ts re-run the
 * back five stages over an old run with the network unplugged.
 */

const LOCK_TTL_MS = 10 * 60 * 1000;

/**
 * Deliberately the *same* job name the v1 crawler uses
 * (lib/crawler/orchestrate.ts's JOB_NAME), so v1 and v2 contend for one lock
 * per scope and can never run against the same install at once. They write
 * overlapping rows -- ProductSet, ReleaseEvent, SourceClaim -- and a
 * concurrent v1 scan recomputing confidence from a half-written v2 claim set
 * would produce a state neither pipeline's rules describe. A shared lock is
 * the cheapest way to make that unrepresentable while both exist.
 */
const JOB_NAME = "crawler";

const FETCH_CONCURRENCY = 4;

export type IngestTotals = {
  providersFetched: number;
  providersFailed: number;
  candidates: number;
  parseErrors: number;
  eventsPublished: number;
  eventsHeld: number;
  eventsFlagged: number;
  eventsStale: number;
  claimsWritten: number;
  reviewItemsOpened: number;
  productSetsCreated: number;
  errors: number;
};

export type IngestResult =
  | { skipped: true; reason: string }
  | { skipped: false; scanRunId: string; totals: IngestTotals };

export function emptyTotals(): IngestTotals {
  return {
    providersFetched: 0,
    providersFailed: 0,
    candidates: 0,
    parseErrors: 0,
    eventsPublished: 0,
    eventsHeld: 0,
    eventsFlagged: 0,
    eventsStale: 0,
    claimsWritten: 0,
    reviewItemsOpened: 0,
    productSetsCreated: 0,
    errors: 0,
  };
}

export type RunIngestParams = {
  scope: { scopeType: ScanScopeType; scopeId?: string };
  trigger: ScanTrigger;
  /** Injected for determinism and testability; nothing downstream reads the clock itself. */
  now?: Date;
  /** Injected so the Fetch stage's network access is a parameter rather than an ambient capability. */
  fetchImpl?: typeof globalThis.fetch;
};

/**
 * What `startIngest` hands back: either the run refused to start (the lock is
 * held) or it has started, and the caller may either await `completed` or walk
 * away with the id.
 *
 * The split exists for the cron trigger in app/api/ingest/run/route.ts. A full
 * run takes tens of seconds, which is longer than a cron client (or a reverse
 * proxy) is willing to hold a connection open, so the handler needs the
 * ScanRun id *before* the pipeline finishes -- and the id only exists after the
 * lock has been taken and the row written. Splitting there, rather than
 * polling for the row the way tests have to, keeps "did it start" and "is
 * something else already running" exact answers instead of guesses.
 */
export type StartIngestResult =
  | { started: false; reason: string }
  | { started: true; scanRunId: string; completed: Promise<IngestResult> };

/**
 * Takes the lock, writes the ScanRun row, and returns as soon as both are
 * done -- the remaining stages run on the returned promise.
 *
 * The caller owns that promise: nothing here attaches a handler to it, so a
 * fire-and-forget caller must `.catch()` it or Node will report an unhandled
 * rejection. `runIngest` below awaits it, which is why its behaviour is
 * unchanged.
 */
export async function startIngest(params: RunIngestParams): Promise<StartIngestResult> {
  const start = Date.now();
  const { scopeType, scopeId } = params.scope;
  const lockScopeKey = scopeType === "INSTALL" && scopeId ? scopeId : "global";

  const lock = await crawlerRepo.acquireJobLock(JOB_NAME, lockScopeKey, LOCK_TTL_MS);
  if (!lock) {
    logEvent({
      action: "ingest.runIngest",
      scopeType,
      scopeId,
      trigger: params.trigger,
      durationMs: Date.now() - start,
      outcome: "skipped",
    });
    return { started: false, reason: "a scan is already running for this scope" };
  }

  const scanRun = await ingestRepo.createIngestRun({ scopeType, scopeId, trigger: params.trigger });
  return {
    started: true,
    scanRunId: scanRun.id,
    completed: executeIngest(params, scanRun.id, lockScopeKey, start),
  };
}

export async function runIngest(params: RunIngestParams): Promise<IngestResult> {
  const started = await startIngest(params);
  if (!started.started) return { skipped: true, reason: started.reason };
  return started.completed;
}

/** Stages 1-6 for a run whose lock is already held and whose ScanRun row already exists. Always releases the lock. */
async function executeIngest(
  params: RunIngestParams,
  scanRunId: string,
  lockScopeKey: string,
  start: number,
): Promise<IngestResult> {
  const now = params.now ?? new Date();
  const { scopeType, scopeId } = params.scope;
  const totals = emptyTotals();

  try {
    const installs = await crawlerRepo.getInstallsForScan(scopeType, scopeId);
    const games = installs.map((install) => install.package.slug);
    const providers = providersForGames(games);

    // ---- Stage 1: Fetch. The only network I/O in the pipeline. ----
    await mapWithConcurrency(providers, FETCH_CONCURRENCY, async (provider) => {
      const outcome = await fetchProvider(provider, scanRunId, now, params.fetchImpl ?? globalThis.fetch);
      if (outcome === "failed") totals.providersFailed += 1;
      else totals.providersFetched += 1;
    });

    // ---- Stages 2-6, from what Fetch wrote down. ----
    const stageTotals = await runStagesFromPayloads({ scanRunId, now, installs });
    Object.assign(totals, stageTotals, {
      providersFetched: totals.providersFetched,
      providersFailed: totals.providersFailed,
    });

    // A run where some providers failed is a *partial*, not a failure: the
    // successes have already been applied, and marking the whole run FAILED
    // would both discard that fact and invite an operator to re-run the
    // providers that worked. retryRun exists precisely to repair the rest.
    await ingestRepo.finalizeIngestRun(scanRunId, {
      status: "SUCCEEDED",
      totals: totals as unknown as Prisma.InputJsonValue,
    });

    // ---- Freshness alarms. ----
    // Runs after finalize, and swallows its own errors, because it is
    // observability rather than pipeline work: a calendar that has quietly
    // stopped updating is the failure this checks for, and a notification
    // transport failing must never turn a run that produced good data into a
    // FAILED one. See lib/ingest/freshness.ts.
    await runProviderFreshnessAlarmPass({ now }).catch((error) => {
      logEvent({
        action: "ingest.freshnessAlarmPass",
        scanRunId,
        outcome: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    });

    logEvent({
      action: "ingest.runIngest",
      scanRunId,
      scopeType,
      scopeId,
      trigger: params.trigger,
      durationMs: Date.now() - start,
      outcome: "success",
      ...totals,
    });
    return { skipped: false, scanRunId, totals };
  } catch (error) {
    await ingestRepo.finalizeIngestRun(scanRunId, {
      status: "FAILED",
      totals: totals as unknown as Prisma.InputJsonValue,
    });
    logEvent({
      action: "ingest.runIngest",
      scanRunId,
      scopeType,
      scopeId,
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

// ---------------------------------------------------------------------------
// Stage 1: Fetch
// ---------------------------------------------------------------------------

/**
 * Fetches one provider and writes its payload and ProviderRun row *before*
 * anything tries to interpret the bytes. That ordering is the replay
 * substrate's entire contract: a response that crashes the parser is still on
 * disk afterwards, which is the difference between "fix the parser and replay"
 * and "wait a day and hope the site sends the same thing".
 */
async function fetchProvider(
  provider: Provider,
  scanRunId: string,
  now: Date,
  fetchImpl: typeof globalThis.fetch,
): Promise<"ok" | "failed"> {
  const startedAt = new Date();
  const stored = await ingestRepo.getProviderEtag(provider.key);
  const ctx: FetchContext = {
    scanRunId,
    etag: stored?.etag ?? null,
    contentHash: stored?.contentHash ?? null,
    fetch: fetchImpl,
    now,
  };

  try {
    const payload = await provider.fetch(ctx);
    await ingestRepo.saveRawPayload(payload);
    await ingestRepo.recordProviderRun({
      scanRunId,
      providerKey: provider.key,
      status: payload.status,
      etag: payload.etag,
      error: payload.error,
      startedAt,
      finishedAt: new Date(),
    });
    // Only advance the conditional-GET state on a fetch that actually
    // produced something. Storing an ETag for a failed request would make the
    // next run send If-None-Match for a body we never received and treat the
    // resulting 304 as "nothing changed".
    if (payload.status === "OK" || payload.status === "DEGRADED") {
      await ingestRepo.upsertProviderEtag({
        providerKey: provider.key,
        etag: payload.etag ?? null,
        contentHash: payload.contentHash,
        lastFetchedAt: payload.fetchedAt,
      });
    }
    return payload.status === "FAILED" ? "failed" : "ok";
  } catch (error) {
    await ingestRepo.recordProviderRun({
      scanRunId,
      providerKey: provider.key,
      status: "FAILED",
      error: error instanceof Error ? error.message : String(error),
      startedAt,
      finishedAt: new Date(),
    });
    logEvent({
      action: "ingest.fetchProvider",
      scanRunId,
      providerKey: provider.key,
      outcome: "error",
      error: error instanceof Error ? error.message : String(error),
    });
    return "failed";
  }
}

/**
 * Re-exported from lib/ingest/fetch.ts, where it now lives beside the rest of
 * the Fetch stage's framing. Kept exported here because it was part of this
 * module's surface first, and because a provider importing it from the
 * orchestrator would close an import cycle (orchestrate -> registry ->
 * provider -> orchestrate).
 */
export { packPayloadBody } from "./fetch";

// ---------------------------------------------------------------------------
// Stages 2-6
// ---------------------------------------------------------------------------

type InstallForScan = { id: string; package: { slug: string } };

export type StageTotals = Omit<IngestTotals, "providersFetched" | "providersFailed">;

/**
 * Runs Normalize -> Identity -> Gate -> Apply -> Diff over a run's stored
 * payloads.
 *
 * Shared verbatim between a live run and a replay, which is the point: if the
 * replay path were a separate implementation, "replaying a run reproduces it"
 * would be a claim about two code paths staying in sync rather than a fact
 * about one.
 */
export async function runStagesFromPayloads(params: {
  scanRunId: string;
  now: Date;
  installs: InstallForScan[];
  /** Narrows which providers' payloads are read (replayRun's `providers` option). */
  providerKeys?: string[];
}): Promise<StageTotals> {
  const { scanRunId, now, installs } = params;
  const totals: StageTotals = {
    candidates: 0,
    parseErrors: 0,
    eventsPublished: 0,
    eventsHeld: 0,
    eventsFlagged: 0,
    eventsStale: 0,
    claimsWritten: 0,
    reviewItemsOpened: 0,
    productSetsCreated: 0,
    errors: 0,
  };

  const stored = await ingestRepo.getRawPayloads(scanRunId, params.providerKeys);
  const payloads: RawPayloadRecord[] = stored.map((row) => ({
    scanRunId: row.scanRunId,
    providerKey: row.providerKey,
    contentHash: row.contentHash,
    body: row.body,
    fetchedAt: row.fetchedAt,
    // Payload rows are only written for fetches that produced a body; the
    // ProviderRun row carries the real status, and Normalize only needs to
    // know "there is something here to parse".
    status: "OK",
  }));

  // ---- Stage 2: Normalize ----
  const { candidates, errors } = normalizeRun(payloads, getProvider);
  totals.candidates = candidates.length;
  totals.parseErrors = errors.length;
  for (const error of errors) {
    logEvent({ action: "ingest.normalize", scanRunId, providerKey: error.providerKey, path: error.path, outcome: "error", error: error.message });
    // A provider whose payload would not parse is degraded, not failed: its
    // bytes are on disk, so a fixed parser can replay them.
    await ingestRepo
      .recordProviderRun({
        scanRunId,
        providerKey: error.providerKey,
        status: "DEGRADED",
        error: error.message,
        startedAt: now,
        finishedAt: now,
      })
      .catch(() => {
        totals.errors += 1;
      });
  }

  const items: ApplyItem[] = [];
  const touchedEventIds = new Set<string>();

  // ---- Stages 3 & 4, per install: Identity then Gate ----
  for (const install of installs) {
    const forInstall = candidates.filter((candidate) => candidate.game === install.package.slug);
    if (forInstall.length === 0) continue;

    const resolved = await resolveInstallCandidates(install.id, forInstall, totals);

    for (const group of groupResolvedCandidates(resolved).values()) {
      try {
        const item = await gateGroup(group, now);
        touchedEventIds.add(item.releaseEventId);
        items.push(item);
      } catch (error) {
        totals.errors += 1;
        logEvent({
          action: "ingest.gateGroup",
          scanRunId,
          productSetId: group.productSetId,
          outcome: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  // ---- Stage 4b: the absence sweep, so rule G7 can actually fire. ----
  // Events this run said nothing about are not simply skipped: silence is the
  // input G7 reasons over, and an event nobody mentions is exactly the case
  // the rule exists for.
  const trackedEvents = await ingestRepo.getIngestTrackedEvents(installs.map((install) => install.id));
  for (const event of trackedEvents) {
    if (touchedEventIds.has(event.id)) continue;
    try {
      items.push(await gateAbsentEvent(event.id, event.productSetId, now));
    } catch (error) {
      totals.errors += 1;
      logEvent({
        action: "ingest.gateAbsent",
        scanRunId,
        releaseEventId: event.id,
        outcome: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ---- Stages 5 & 6: Apply and Diff ----
  const applied = await applyVerdicts({ scanRunId, now, items });
  totals.eventsPublished = applied.published;
  totals.eventsHeld = applied.held;
  totals.eventsFlagged = applied.flagged;
  totals.eventsStale = applied.stale;
  totals.claimsWritten = applied.claimsWritten;
  totals.reviewItemsOpened = applied.reviewItemsOpened;
  totals.errors += applied.errors;

  return totals;
}

/** Stage 3 for one install: resolve every candidate, creating and pinning sets that are genuinely new. */
async function resolveInstallCandidates(
  installId: string,
  candidates: Candidate[],
  totals: StageTotals,
): Promise<ResolvedCandidate[]> {
  const stored = await ingestRepo.getIdentityContext(installId);
  // Which codes this run must not use as identity keys, computed from the run's
  // own candidates rather than from the database. The distinction matters most
  // on a first run against an empty catalogue: tcgcsv hands the code "POP" to
  // all nine POP Series sets in one payload, and without this the first of them
  // would create a set that the other eight then merged into. The database-side
  // guard in buildCodeIndex only sees duplicates that have already been stored.
  const context = { ...stored, ambiguousCodes: collectAmbiguousCodes(candidates) };
  const resolved: ResolvedCandidate[] = [];

  for (const candidate of candidates) {
    let resolution = resolveSetIdentity(candidate, context);

    if (!resolution.productSetId) {
      const created = await ingestRepo.createProductSet({
        tcgProfileInstallId: installId,
        code: candidate.code,
        name: candidate.name,
        description: candidate.description,
      });
      totals.productSetsCreated += 1;
      // Extend the in-memory context so a second candidate for the same new
      // product, later in this same batch, matches the set we just made
      // instead of creating a twin the dedup pass would have to clean up.
      // The code goes in too, so the very next candidate can resolve by code
      // rather than falling back to the name heuristics.
      context.sets.push({ id: created.id, name: created.name, code: created.code });
      resolution = { productSetId: created.id, matchedBy: "new" };
    }

    // Non-null past this point: either identity resolved it or the branch
    // above just created the set.
    const productSetId = resolution.productSetId as string;

    // Pin every id this candidate carries, so the next run resolves by id
    // rather than re-running the name heuristics -- including ids matched by
    // name this time, which is how a fuzzy match becomes a permanent fact.
    for (const [origin, externalId] of Object.entries(candidate.externalIds)) {
      await ingestRepo.recordSetIdentity({ productSetId, origin, externalId });
      context.identities.push({ origin, externalId, productSetId });
    }

    resolved.push({ ...candidate, resolution, tier: tierFor(candidate.origin) });
  }

  return resolved;
}

/** One release event's worth of this run's candidates, as the gate wants to see them. */
export type EventGroup = {
  productSetId: string;
  type: Candidate["type"];
  region: Candidate["region"];
  entries: ResolvedCandidate[];
};

/**
 * The key that says which candidates are talking about the same release event.
 *
 * NUL-separated so no component can forge a collision by containing the
 * separator, the same reasoning as identity.ts's identityKey.
 */
export function eventGroupKey(productSetId: string, type: Candidate["type"], region: Candidate["region"]): string {
  return `${productSetId}\0${type}\0${region}`;
}

/**
 * Groups this run's resolved candidates into one bucket per release event.
 *
 * (productSet, type, region) -- and the third component is the whole of phase 4.
 * Grouping on (productSet, type) alone made a Japanese street date and a global
 * one for the same expansion two claims about a single event, three months
 * apart, which the gate reads (correctly, given what it was told) as a G5
 * conflict. That is not a gate bug: the gate was handed a question with no right
 * answer. Two dates for two regions are two facts, and they belong on two
 * events, so the split happens here -- before the gate ever sees them -- and the
 * gate's conflict rule goes on meaning exactly what it always meant, within one
 * region.
 *
 * Exported so the property that matters ("claims from different regions never
 * meet") is testable without a database; lib/ingest/gate.ts stays pure and
 * region-agnostic.
 */
export function groupResolvedCandidates(resolved: ResolvedCandidate[]): Map<string, EventGroup> {
  const groups = new Map<string, EventGroup>();
  for (const entry of resolved) {
    const productSetId = entry.resolution.productSetId;
    if (!productSetId) continue;
    const key = eventGroupKey(productSetId, entry.type, entry.region);
    const group = groups.get(key) ?? { productSetId, type: entry.type, region: entry.region, entries: [] };
    group.entries.push(entry);
    groups.set(key, group);
  }
  return groups;
}

/** Stage 4 for one (productSet, type, region): assemble claims, run the gate, package the result for Apply. */
async function gateGroup(group: EventGroup, now: Date): Promise<ApplyItem> {
  const event = await ingestRepo.findOrCreateReleaseEvent({
    productSetId: group.productSetId,
    type: group.type,
    region: group.region,
    date: group.entries[0].date,
  });

  const before = await ingestRepo.getPublishedState(event.id);
  const history = await ingestRepo.getClaimHistoryForEvent(event.id);

  const observed = group.entries.map((entry) => ({
    origin: entry.origin,
    tier: entry.tier,
    date: entry.date,
    url: entry.url ?? "",
  }));

  const claims: ClaimRecord[] = buildClaimRecords({ history, observed, now });
  const verdict = evaluateGate({ now, claims, published: before });

  const claimWrites: ClaimWrite[] = group.entries.map((entry) => ({
    origin: entry.origin,
    tier: entry.tier,
    date: entry.date,
    url: entry.url ?? "",
  }));

  return { releaseEventId: event.id, productSetId: group.productSetId, before, verdict, claims: claimWrites };
}

/** Stage 4 for an event nobody mentioned this run -- the G7 path. No claims are written, by definition. */
async function gateAbsentEvent(releaseEventId: string, productSetId: string, now: Date): Promise<ApplyItem> {
  const before = await ingestRepo.getPublishedState(releaseEventId);
  const history = await ingestRepo.getClaimHistoryForEvent(releaseEventId);
  const claims = buildClaimRecords({ history, observed: [], now });
  const verdict = evaluateGate({ now, claims, published: before });
  return { releaseEventId, productSetId, before, verdict, claims: [] };
}

function tierFor(origin: Origin) {
  return ORIGINS[origin as keyof typeof ORIGINS]?.tier ?? "COMMUNITY";
}

/** Same bounded-concurrency helper as v1's scan loop: parallel enough to matter, never dozens of open sockets. */
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

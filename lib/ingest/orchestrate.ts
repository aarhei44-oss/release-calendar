import { randomUUID } from "node:crypto";
import type {
  Prisma,
  ProductImageKind,
  ReleaseStatus,
  ScanScopeType,
  ScanTrigger,
} from "@/app/generated/prisma/client";
import * as ingestRepo from "@/data/ingest/ingestRepo";
import { logEvent } from "@/lib/logger";
import { dispatchScanChangeNotifications } from "@/lib/notifications/dispatch";
import { applyVerdicts, type ApplyItem, type ClaimWrite } from "./apply";
import { buildClaimRecords } from "./claims";
import { derivePrereleaseEvents } from "./derivePrereleases";
import { runProviderFreshnessAlarmPass } from "./freshness";
import { evaluateGate } from "./gate";
import { collectAmbiguousCodes, normalizeSetCode, resolveSetIdentity } from "./identity";
import { normalizeRun } from "./normalize";
import { toScanChanges } from "./notifications";
import { expectedPrereleaseDates } from "./prerelease";
import { getProvider, providersForGames } from "./providers/registry";
import type { FetchContext, Provider } from "./providers/types";
import {
  ORIGINS,
  type Candidate,
  type CandidateDate,
  type ClaimRecord,
  type Origin,
  type RawPayloadRecord,
  type ResolvedCandidate,
  type RunDiffChange,
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
 * Historically the *same* job name the now-retired v1 crawler used, so the
 * two pipelines contended for one lock per scope and could never run against
 * the same install at once while both existed -- they wrote overlapping rows
 * (ProductSet, ReleaseEvent, SourceClaim), and a concurrent v1 scan
 * recomputing confidence from a half-written v2 claim set would have produced
 * a state neither pipeline's rules describe. Kept as "crawler" rather than
 * renamed post-cutover: it's just a string key into JobLock, and renaming it
 * would only risk a stale lock row under the old name outliving a deploy.
 */
const JOB_NAME = "crawler";

const FETCH_CONCURRENCY = 4;

/**
 * Invents a code for a ProductSet whose only candidate so far has none, so
 * `create` can satisfy the NOT NULL/unique column. Not a guess at the
 * product's real code -- codeIsSynthetic marks it so identity.ts's code tier
 * never treats it as one -- so a random suffix is fine; readability would
 * buy nothing since no source is ever expected to agree with it.
 */
function synthesizeProductSetCode(name: string): string {
  const slug = name
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "")
    .slice(0, 24);
  return `SYN-${slug || "SET"}-${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
}

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
  /**
   * Sets whose image/description was filled in this run (see enrichProductSet).
   * Expected to spike once on the first run after a new origin starts supplying
   * one and sit at zero afterwards -- a number that stays high run after run
   * means something is overwriting rather than filling.
   */
  productSetsEnriched: number;
  /**
   * Prerelease events written from a game's schedule rather than a source
   * (lib/ingest/derivePrereleases.ts), and events retracted because their
   * anchor shelf date stopped being confirmed. Unlike productSetsEnriched
   * these are *restated* every run, so `prereleasesDerived` sits at roughly the
   * number of confirmed upcoming sets in scheduled games rather than falling to
   * zero -- it is a level, not a delta. `prereleasesRetracted` is the one to
   * watch: a spike means shelf dates lost their CONFIRMED status en masse,
   * which is far more likely to be an ingest problem than a wave of delays.
   */
  prereleasesDerived: number;
  prereleasesRetracted: number;
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
    productSetsEnriched: 0,
    prereleasesDerived: 0,
    prereleasesRetracted: 0,
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

  const lock = await ingestRepo.acquireJobLock(JOB_NAME, lockScopeKey, LOCK_TTL_MS);
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
    const installs = await ingestRepo.getInstallsForScan(scopeType, scopeId);
    const games = installs.map((install) => install.package.slug);
    const providers = providersForGames(games);

    // ---- Stage 1: Fetch. The only network I/O in the pipeline. ----
    await mapWithConcurrency(providers, FETCH_CONCURRENCY, async (provider) => {
      const outcome = await fetchProvider(provider, scanRunId, now, params.fetchImpl ?? globalThis.fetch);
      if (outcome === "failed") totals.providersFailed += 1;
      else totals.providersFetched += 1;
    });

    // ---- Stages 2-6, from what Fetch wrote down. ----
    const { diffChanges, ...stageTotals } = await runStagesFromPayloads({ scanRunId, now, installs });
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

    // ---- Subscriber/follower change notifications. ----
    // Same placement and reasoning as the freshness pass above: runs after
    // finalize, swallows its own errors, and must never turn a run that
    // produced good data into a FAILED one just because a mail transport
    // hiccupped. Deliberately *not* inside runStagesFromPayloads (shared with
    // replay.ts's replayRun/retryRun) -- replaying a past run must never
    // re-fire "new release" emails for something that already happened.
    await notifyOfIngestChanges(scanRunId, diffChanges).catch((error) => {
      logEvent({
        action: "ingest.dispatchNotifications",
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
    await ingestRepo.releaseJobLock(JOB_NAME, lockScopeKey);
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
}): Promise<StageTotals & { diffChanges: RunDiffChange[] }> {
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
    productSetsEnriched: 0,
    prereleasesDerived: 0,
    prereleasesRetracted: 0,
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
  const { candidates, errors, candidatesByProvider } = normalizeRun(payloads, getProvider);
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
  // The Fetch stage's recordProviderRun necessarily wrote 0 -- parsing hadn't
  // happened yet -- so backfill the real count for every provider that
  // actually parsed this run. A provider absent here was NOT_MODIFIED, sent an
  // empty body, or errored (handled above via DEGRADED's own 0), so its row is
  // correctly left alone rather than overwritten with a stale zero.
  for (const [providerKey, count] of candidatesByProvider) {
    await ingestRepo.updateProviderRunCandidateCount({ scanRunId, providerKey, candidates: count }).catch(() => {
      totals.errors += 1;
    });
  }

  const items: ApplyItem[] = [];
  const touchedEventIds = new Set<string>();
  const installIds = installs.map((install) => install.id);

  // Shelf dates as they stand going into this run, so gate rule G8 has an
  // anchor even for a product whose shelf date nothing reported this time.
  // Overlaid below with this run's own shelf verdicts, which is why the groups
  // are gated shelf-first.
  const shelfAnchors = await loadShelfAnchors(installIds);

  // ---- Stages 3 & 4, per install: Identity then Gate ----
  for (const install of installs) {
    const forInstall = candidates.filter((candidate) => candidate.game === install.package.slug);
    if (forInstall.length === 0) continue;

    const resolved = await resolveInstallCandidates(install.id, forInstall, totals);

    for (const group of orderGroupsShelfFirst(groupResolvedCandidates(resolved))) {
      try {
        // Only PRERELEASE groups get expected dates, and only where the game
        // publishes a schedule; everywhere else this is empty and G8 is inert.
        const expectedDates =
          group.type === "PRERELEASE"
            ? expectedDatesForAnchor(install.package.slug, shelfAnchors.get(anchorKey(group.productSetId, group.region)))
            : [];

        const item = await gateGroup(group, now, expectedDates);
        touchedEventIds.add(item.releaseEventId);
        items.push(item);

        // A shelf verdict reached this run supersedes the stored anchor for any
        // prerelease group still to come. Without this, a set whose street date
        // is confirmed for the first time today would not get its prerelease
        // until tomorrow's run, purely because the two were read in the wrong
        // order. (A manually overridden event is the one case this can be ahead
        // of the database, since Apply declines to move its date -- the
        // derivation pass re-reads the real rows afterwards and settles it.)
        if (group.type === "SHELF") {
          shelfAnchors.set(anchorKey(group.productSetId, group.region), {
            status: item.verdict.status,
            date: item.verdict.date,
          });
        }
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
  const trackedEvents = await ingestRepo.getIngestTrackedEvents(installIds);
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

  // ---- Stage 5b: derived prereleases. ----
  // After Apply, deliberately: it restates dates the gate has just settled, so
  // it has to read them settled. See lib/ingest/derivePrereleases.ts.
  //
  // Its changes stay out of `diffChanges`, which is what drives subscriber
  // email (notifyOfIngestChanges). A derived prerelease is arithmetic on a
  // shelf date the follower was already told about, so mailing it as separate
  // news would double every announcement.
  const derived = await derivePrereleaseEvents({ installIds, now, scanRunId });
  totals.prereleasesDerived = derived.written;
  totals.prereleasesRetracted = derived.retracted;
  totals.errors += derived.errors;

  return { ...totals, diffChanges: applied.diff.changes };
}

// ---------------------------------------------------------------------------
// Shelf anchors, for gate rule G8
// ---------------------------------------------------------------------------

/** What a prerelease group needs to know about its product's shelf date. */
type ShelfAnchor = { status: ReleaseStatus; date: CandidateDate | null };

/** Same (productSet, region) scoping the event key uses -- a JP shelf date must not anchor a global prerelease. */
function anchorKey(productSetId: string, region: Candidate["region"]): string {
  return `${productSetId}\0${region}`;
}

async function loadShelfAnchors(installIds: string[]): Promise<Map<string, ShelfAnchor>> {
  const anchors = new Map<string, ShelfAnchor>();
  for (const anchor of await ingestRepo.getShelfAnchors(installIds)) {
    anchors.set(anchorKey(anchor.productSetId, anchor.region), { status: anchor.status, date: anchor.date });
  }
  return anchors;
}

/**
 * The dates the game's schedule predicts, or none.
 *
 * The CONFIRMED bar is the same one the derivation pass uses: a schedule
 * computed from a date still under argument is not a check on anything, it just
 * launders the argument into a second event.
 */
function expectedDatesForAnchor(game: string, anchor: ShelfAnchor | undefined): CandidateDate[] {
  if (!anchor || anchor.status !== "CONFIRMED") return [];
  return expectedPrereleaseDates(game, anchor.date);
}

/**
 * Groups in gate order: SHELF first, everything else after.
 *
 * Only the relative order of SHELF against the rest matters (a prerelease group
 * is checked against its product's shelf verdict), so this is a stable
 * partition rather than a sort -- two prerelease groups keep whatever order
 * grouping gave them, which keeps a replay deterministic.
 */
function orderGroupsShelfFirst(groups: Map<string, EventGroup>): EventGroup[] {
  const shelf: EventGroup[] = [];
  const rest: EventGroup[] = [];
  for (const group of groups.values()) {
    (group.type === "SHELF" ? shelf : rest).push(group);
  }
  return [...shelf, ...rest];
}

/**
 * Resolves this run's diff into the subscriber/follower alert shape and
 * dispatches it. A thin wrapper around ./notifications' toScanChanges purely
 * so the DB lookup (which event belongs to which install/game) and the pure
 * mapping stay separately testable.
 */
async function notifyOfIngestChanges(scanRunId: string, diffChanges: RunDiffChange[]): Promise<void> {
  if (diffChanges.length === 0) return;
  const context = await ingestRepo.getChangeContextForEvents(diffChanges.map((c) => c.releaseEventId));
  const scanChanges = toScanChanges(diffChanges, new Map(context.map((c) => [c.eventId, c])));
  await dispatchScanChangeNotifications(scanChanges);
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
      // `code` is NOT NULL: most origins print one, but a code-less origin
      // (a wiki) can be the first to see a brand new product. Rather than
      // block on a real code that hasn't been published anywhere yet, invent
      // one that only has to satisfy the column's uniqueness -- codeIsSynthetic
      // keeps it out of identity.ts's code tier, so it can never masquerade as
      // a fact a source actually printed.
      //
      // Two more cases need the same fallback, both discovered by tcgcsv's own
      // real "POP" abbreviation (all nine Pokemon POP Series sets) and "PR"
      // (four unrelated promo sets): resolveSetIdentity above refuses to code-
      // match an ambiguousCodes member -- correctly, since matching would fuse
      // nine different products into one -- so every candidate carrying it
      // resolves "new", and every one of them would otherwise try to write the
      // identical literal string into a column unique on (install, code). The
      // second check is a plain safety net for any collision the ambiguity
      // heuristic doesn't recognize (this batch didn't see the sibling that
      // already claimed the code, say): a create is never allowed to find out
      // about a duplicate by throwing.
      const normalizedCode = candidate.code ? normalizeSetCode(candidate.code) : null;
      const codeIsAmbiguous = normalizedCode !== null && context.ambiguousCodes?.has(normalizedCode) === true;
      const codeAlreadyTaken = candidate.code !== null && context.sets.some((set) => set.code === candidate.code);
      const codeIsSynthetic = candidate.code == null || codeIsAmbiguous || codeAlreadyTaken;
      const code = codeIsSynthetic ? synthesizeProductSetCode(candidate.name) : candidate.code!;
      const created = await ingestRepo.createProductSet({
        tcgProfileInstallId: installId,
        code,
        codeIsSynthetic,
        name: candidate.name,
        description: candidate.description,
        imageUrl: candidate.imageUrl,
        imageKind: candidate.imageKind,
      });
      totals.productSetsCreated += 1;
      // Extend the in-memory context so a second candidate for the same new
      // product, later in this same batch, matches the set we just made
      // instead of creating a twin the dedup pass would have to clean up.
      // The code goes in too, so the very next candidate can resolve by code
      // rather than falling back to the name heuristics -- unless it's
      // synthetic, in which case buildCodeIndex ignores it for the same
      // reason the database copy will on the next run.
      context.sets.push({
        id: created.id,
        name: created.name,
        code: created.code,
        codeIsSynthetic: created.codeIsSynthetic,
        imageUrl: created.imageUrl,
        imageKind: created.imageKind,
        description: created.description,
      });
      resolution = { productSetId: created.id, matchedBy: "new" };
    }

    // Non-null past this point: either identity resolved it or the branch
    // above just created the set.
    const productSetId = resolution.productSetId as string;

    await enrichProductSet(productSetId, candidate, context, totals);

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

/**
 * Fills in a set's presentational fields from a candidate that happens to
 * carry them.
 *
 * One rule: write only what the stored row is missing. Nothing here goes
 * through the gate, because none of it is a claim about a release -- there is
 * nothing for two origins to *disagree* about, only one to be first.
 * Refreshing on every run instead would make the stored value depend on
 * provider ordering within the run, and would rewrite all 86 image-bearing
 * rows nightly to no effect.
 *
 * The reason this is a separate step rather than an argument to
 * createProductSet: creation only ever reaches sets discovered after the
 * change. `description` was wired into createProductSet when it shipped and
 * has been null on every row ever since, because every set in the catalogue
 * predates any origin that could supply one. A create-time-only field in a
 * pipeline that resolves far more often than it creates is a field that never
 * gets populated.
 *
 * `imageKind` is the one field that can be written to an already-populated
 * row, and only from null. It was added after `imageUrl`, so a row can carry
 * a URL classified by nothing; the migration backfilled every such row it
 * could see, and this covers whatever it could not (a set enriched between
 * the migration and this deploy). The URL has to still match for that, or a
 * second origin's kind could end up describing the first origin's image.
 */
async function enrichProductSet(
  productSetId: string,
  candidate: Candidate,
  context: {
    sets: {
      id: string;
      imageUrl?: string | null;
      imageKind?: ProductImageKind | null;
      description?: string | null;
    }[];
  },
  totals: StageTotals,
): Promise<void> {
  const stored = context.sets.find((set) => set.id === productSetId);
  if (!stored) return;

  const fields: { imageUrl?: string; imageKind?: ProductImageKind; description?: string } = {};
  if (candidate.imageUrl && !stored.imageUrl) {
    fields.imageUrl = candidate.imageUrl;
    fields.imageKind = candidate.imageKind;
  } else if (candidate.imageKind && !stored.imageKind && candidate.imageUrl === stored.imageUrl) {
    fields.imageKind = candidate.imageKind;
  }
  if (candidate.description && !stored.description) fields.description = candidate.description;
  if (fields.imageUrl === undefined && fields.imageKind === undefined && fields.description === undefined) {
    return;
  }

  await ingestRepo.updateProductSetEnrichment(productSetId, fields);
  totals.productSetsEnriched += 1;

  // Keep the in-memory context in step with the row just written, so a second
  // candidate naming the same set later in this run reads it as populated
  // instead of issuing an identical update.
  if (fields.imageUrl !== undefined) stored.imageUrl = fields.imageUrl;
  if (fields.imageKind !== undefined) stored.imageKind = fields.imageKind;
  if (fields.description !== undefined) stored.description = fields.description;
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

/**
 * Stage 4 for one (productSet, type, region): assemble claims, run the gate,
 * package the result for Apply.
 *
 * `expectedDates` is the schedule check gate rule G8 weighs (empty for
 * everything but a prerelease group in a game that has one).
 */
async function gateGroup(group: EventGroup, now: Date, expectedDates: CandidateDate[] = []): Promise<ApplyItem> {
  const { event, created } = await ingestRepo.findOrCreateReleaseEvent({
    productSetId: group.productSetId,
    type: group.type,
    region: group.region,
  });

  // A row created moments ago has published nothing, so it must reach the gate
  // as `null` rather than as its own freshly written state. Reading it back
  // instead is what let a single unqualified claim publish a date on sight:
  // the row was seeded from that claim, getPublishedState handed the seed back
  // as "what this event already shows", and a HOLD dutifully restated it.
  const before = created ? null : await ingestRepo.getPublishedState(event.id);
  const history = await ingestRepo.getClaimHistoryForEvent(event.id);

  const observed = group.entries.map((entry) => ({
    origin: entry.origin,
    tier: entry.tier,
    date: entry.date,
    url: entry.url ?? "",
  }));

  const claims: ClaimRecord[] = buildClaimRecords({ history, observed, now });
  const verdict = evaluateGate({ now, claims, published: before, expectedDates });

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

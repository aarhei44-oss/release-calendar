import type { Prisma } from "@/app/generated/prisma/client";
import * as crawlerRepo from "@/data/crawler/crawlerRepo";
import * as ingestRepo from "@/data/ingest/ingestRepo";
import { logEvent } from "@/lib/logger";
import { emptyTotals, runStagesFromPayloads, type IngestTotals } from "./orchestrate";
import { getProvider } from "./providers/registry";
import type { FetchContext } from "./providers/types";

/**
 * Replay: re-derive a run's conclusions from the bytes it stored, and repair a
 * run whose providers partly failed.
 *
 * The two operations look similar and are deliberately different in one
 * respect. `replayRun` performs **no network I/O at all** -- not a conditional
 * GET, not a HEAD, nothing. That is the property that makes it useful: a
 * parser fix or a gate-rule change can be tried against a real historical run
 * and the only thing that varies is our code. `retryRun` is the one that is
 * allowed to talk to the network, and only to the providers that produced
 * nothing at all last time.
 */

const LOCK_TTL_MS = 10 * 60 * 1000;
/** Shared with v1 and with runIngest -- see orchestrate.ts's JOB_NAME for why. */
const JOB_NAME = "crawler";

/**
 * Stages the pipeline can be resumed from. Only Fetch is excluded: replay's
 * whole premise is that Fetch already happened.
 */
export type ReplayStage = "normalize" | "identity" | "gate" | "apply";

export type ReplayOptions = {
  /** Replay only these providers' payloads; all of the run's payloads when omitted. */
  providers?: string[];
  /**
   * Which stage to resume from.
   *
   * Only RawPayload is persisted between stages -- the intermediate
   * Candidate/ResolvedCandidate/Verdict sets are not, on purpose: storing them
   * would create a second source of truth that could disagree with the bytes.
   * Because stages 2-6 are pure and cheap, resuming "from the gate" is
   * implemented by re-deriving Normalize and Identity first, which is free and
   * gives the same answer by construction. So this option is recorded and
   * logged but does not currently change what runs; it exists so a caller can
   * state intent, and so a later phase that does memoize a stage has a
   * parameter to honour.
   */
  fromStage?: ReplayStage;
  now?: Date;
};

export type ReplayResult = { scanRunId: string; totals: IngestTotals };

/**
 * Re-runs Normalize -> Apply over a stored run.
 *
 * Convergent by construction: claims are keyed (scanRunId, origin,
 * releaseEventId), so a replay overwrites its own previous claims rather than
 * stacking new ones, and every verdict is a pure function of that claim set.
 * Replaying the same run any number of times therefore lands in the same
 * database state as replaying it once.
 */
export async function replayRun(runId: string, options: ReplayOptions = {}): Promise<ReplayResult> {
  const start = Date.now();
  const now = options.now ?? new Date();
  const run = await ingestRepo.getIngestRun(runId);
  if (!run) throw new Error(`No such run: ${runId}`);

  const lockScopeKey = run.scopeType === "INSTALL" && run.scopeId ? run.scopeId : "global";
  const lock = await crawlerRepo.acquireJobLock(JOB_NAME, lockScopeKey, LOCK_TTL_MS);
  if (!lock) throw new Error("a scan is already running for this scope");

  try {
    // Scoped to the run's own scope, not to "everything enabled now" -- a
    // replay must reproduce the run, and widening its scope after the fact
    // would let it pass judgement (in particular G7's absence sweep) over
    // installs the original run never looked at.
    const installs = await crawlerRepo.getInstallsForScan(run.scopeType, run.scopeId ?? undefined);

    const stageTotals = await runStagesFromPayloads({
      scanRunId: runId,
      now,
      installs,
      providerKeys: options.providers,
    });
    const totals: IngestTotals = { ...emptyTotals(), ...stageTotals };

    logEvent({
      action: "ingest.replayRun",
      scanRunId: runId,
      fromStage: options.fromStage ?? "normalize",
      providers: options.providers?.join(",") ?? "all",
      durationMs: Date.now() - start,
      outcome: "success",
      ...totals,
    });
    return { scanRunId: runId, totals };
  } finally {
    await crawlerRepo.releaseJobLock(JOB_NAME, lockScopeKey);
  }
}

export type RetryResult = ReplayResult & {
  refetched: string[];
  stillFailing: string[];
};

/**
 * Re-fetches exactly the providers that FAILED in a run, merges the fresh
 * payloads into that same run, and replays it.
 *
 * Providers that succeeded are never re-requested. That is a courtesy to the
 * upstreams, but mostly it is correctness: their stored bytes are what the
 * run's existing claims were derived from, and re-fetching them would quietly
 * turn a repair into a different run whose diff no longer explains what
 * changed.
 *
 * The retry writes into the original run rather than creating a sibling, and
 * records its own ScanRun row stamped with `retryOfRunId` purely as
 * provenance, so the run history shows that a repair happened without the
 * repaired data living somewhere else.
 */
export async function retryRun(
  runId: string,
  options: { now?: Date; fetchImpl?: typeof globalThis.fetch } = {},
): Promise<RetryResult> {
  const now = options.now ?? new Date();
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  const run = await ingestRepo.getIngestRun(runId);
  if (!run) throw new Error(`No such run: ${runId}`);

  const failedKeys = await ingestRepo.getFailedProviderKeys(runId);
  const refetched: string[] = [];
  const stillFailing: string[] = [];

  for (const key of failedKeys) {
    const provider = getProvider(key);
    if (!provider) {
      stillFailing.push(key);
      continue;
    }
    const startedAt = new Date();
    const stored = await ingestRepo.getProviderEtag(provider.key);
    const ctx: FetchContext = {
      scanRunId: runId,
      // Deliberately *not* sending the stored ETag on a retry: the previous
      // attempt produced no body, so a 304 here would leave the run with the
      // same hole it started with while looking like a success.
      etag: null,
      contentHash: stored?.contentHash ?? null,
      fetch: fetchImpl,
      now,
    };

    try {
      const payload = await provider.fetch(ctx);
      await ingestRepo.saveRawPayload({ ...payload, scanRunId: runId });
      await ingestRepo.recordProviderRun({
        scanRunId: runId,
        providerKey: provider.key,
        status: payload.status,
        etag: payload.etag,
        error: payload.error,
        startedAt,
        finishedAt: new Date(),
      });
      if (payload.status === "FAILED") stillFailing.push(key);
      else refetched.push(key);
    } catch (error) {
      stillFailing.push(key);
      await ingestRepo.recordProviderRun({
        scanRunId: runId,
        providerKey: provider.key,
        status: "FAILED",
        error: error instanceof Error ? error.message : String(error),
        startedAt,
        finishedAt: new Date(),
      });
    }
  }

  const replayed = await replayRun(runId, { now });

  // Provenance row: what was repaired, and from which run.
  await ingestRepo.createIngestRun({
    scopeType: run.scopeType,
    scopeId: run.scopeId ?? undefined,
    trigger: "MANUAL",
    retryOfRunId: runId,
  }).then((retryRow) =>
    ingestRepo.finalizeIngestRun(retryRow.id, {
      status: stillFailing.length === 0 ? "SUCCEEDED" : "FAILED",
      totals: { refetched, stillFailing } as unknown as Prisma.InputJsonValue,
    }),
  );

  logEvent({
    action: "ingest.retryRun",
    scanRunId: runId,
    refetched: refetched.join(",") || "none",
    stillFailing: stillFailing.join(",") || "none",
    outcome: stillFailing.length === 0 ? "success" : "partial",
  });

  return { ...replayed, refetched, stillFailing };
}

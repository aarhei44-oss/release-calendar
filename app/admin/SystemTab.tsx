"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  triggerRescan,
  triggerRetentionCleanup,
  replayIngestRun,
  retryIngestRun,
  triggerFreshnessCheck,
  toggleNewsSourceEnabled,
  type listIngestRunHealth,
  type listProviderHealth,
  type getLastScheduledRun,
  type listNewsSourceHealth,
} from "./actions";

type InstallOption = { id: string; label: string };
type IngestRuns = Awaited<ReturnType<typeof listIngestRunHealth>>;
type ProviderHealth = Awaited<ReturnType<typeof listProviderHealth>>;
type LastScheduledRun = Awaited<ReturnType<typeof getLastScheduledRun>>;
type NewsSourceHealth = Awaited<ReturnType<typeof listNewsSourceHealth>>;

const STATUS_STYLES: Record<string, string> = {
  RUNNING: "bg-blue-100 text-blue-700",
  SUCCEEDED: "bg-green-100 text-green-700",
  FAILED: "bg-red-100 text-red-700",
};

/**
 * Per-provider outcome styling. Every pill carries its state as text --
 * "DEGRADED", "FAILED" -- rather than relying on colour alone: red and amber
 * are the pair most commonly indistinguishable to a colour-blind reader, and
 * they are exactly the two states here whose difference matters.
 */
const PROVIDER_STATUS_STYLES: Record<string, string> = {
  OK: "bg-green-100 text-green-800",
  NOT_MODIFIED: "bg-gray-100 text-gray-700",
  DEGRADED: "bg-amber-100 text-amber-900",
  FAILED: "bg-red-100 text-red-800",
};

const RUN_HEALTH_LABELS: Record<string, { label: string; className: string; hint: string }> = {
  OK: { label: "All providers OK", className: "bg-green-100 text-green-800", hint: "Every provider returned data or a 304." },
  PARTIAL: {
    label: "Partial",
    className: "bg-amber-100 text-amber-900",
    hint: "Some providers succeeded and at least one failed. The successes were applied; use Retry failed for the rest.",
  },
  FAILED: { label: "All providers failed", className: "bg-red-100 text-red-800", hint: "No provider returned anything this run." },
  NO_PROVIDERS: {
    label: "No provider detail",
    className: "bg-gray-100 text-gray-600",
    hint: "An older run from before provider-level tracking existed, or one that otherwise recorded no ProviderRun rows.",
  },
};

const DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

function formatWhen(date: Date | string | null): string {
  if (!date) return "—";
  return DATE_FORMATTER.format(typeof date === "string" ? new Date(date) : date);
}

function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function hoursSince(date: Date | string): number {
  return (Date.now() - new Date(date).getTime()) / (60 * 60 * 1000);
}

/** A run's totals rendered as the handful of counts an operator actually scans for: what got created or confirmed, and what needs a look. */
function TotalsSummary({ totals }: { totals: { eventsPublished: number; productSetsCreated: number; reviewItemsOpened: number; eventsStale: number } }) {
  const parts: string[] = [];
  if (totals.productSetsCreated > 0) parts.push(`${totals.productSetsCreated} new product set(s)`);
  if (totals.eventsPublished > 0) parts.push(`${totals.eventsPublished} event(s) published`);
  if (totals.reviewItemsOpened > 0) parts.push(`${totals.reviewItemsOpened} flagged for review`);
  if (totals.eventsStale > 0) parts.push(`${totals.eventsStale} gone stale`);
  if (parts.length === 0) return <span className="text-gray-500">No changes</span>;
  return <>{parts.join(" · ")}</>;
}

export function SystemTab({
  installs,
  ingestRuns,
  providerHealth,
  providerStaleHours,
  lastScheduledRun,
  scheduledRunStaleHours,
  newsSourceHealth,
}: {
  installs: InstallOption[];
  ingestRuns: IngestRuns;
  providerHealth: ProviderHealth;
  providerStaleHours: number;
  lastScheduledRun: LastScheduledRun;
  scheduledRunStaleHours: number;
  newsSourceHealth: NewsSourceHealth;
}) {
  const router = useRouter();
  const [selectedInstall, setSelectedInstall] = useState(installs[0]?.id ?? "");
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  // Rescans (manual and the daily scheduled one) now run in the background
  // rather than blocking a request on them, so the only way this page
  // reflects a finished run is a fresh server render. Poll while a run is
  // still in progress instead of requiring a manual refresh; stops itself
  // once the table's most recent RUNNING row is gone.
  const hasRunningScan = ingestRuns.some((run) => run.status === "RUNNING");
  useEffect(() => {
    if (!hasRunningScan) return;
    const interval = setInterval(() => router.refresh(), 3000);
    return () => clearInterval(interval);
  }, [hasRunningScan, router]);

  function run(label: string, fn: () => Promise<string>) {
    setMessage(null);
    startTransition(async () => {
      try {
        setMessage(await fn());
        router.refresh();
      } catch (e) {
        setMessage(e instanceof Error ? e.message : `${label} failed.`);
      }
    });
  }

  function runRescan() {
    if (!selectedInstall) return;
    // A full rescan can take a while for a large install, so this only starts
    // it in the background rather than waiting for it to finish -- the runs
    // table below polls while a run is in progress (see the effect above) and
    // shows the final totals once it lands. triggerRescan reports whether it
    // actually acquired the lock (startIngest's return, not a guess), so a
    // double-click or a scan already running for this install surfaces here
    // rather than silently claiming success.
    run("Rescan", async () => {
      const result = await triggerRescan(selectedInstall);
      if (!result.started) {
        return `Rescan not started: ${result.reason ?? "already running for this install"}.`;
      }
      return "Rescan started -- see the ingest runs table below for progress.";
    });
  }

  const alarmedProviders = providerHealth.filter((provider) => provider.stale);

  function toggleNewsSource(sourceId: string, label: string, enabled: boolean) {
    run("Toggle news source", async () => {
      await toggleNewsSourceEnabled(sourceId, enabled);
      return `${label} ${enabled ? "enabled" : "disabled"}.`;
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <select
          value={selectedInstall}
          onChange={(e) => setSelectedInstall(e.target.value)}
          className="rounded-md border border-gray-300 px-2 py-1 text-sm"
          aria-label="Install to rescan"
        >
          {installs.map((install) => (
            <option key={install.id} value={install.id}>
              {install.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={isPending || !selectedInstall}
          onClick={runRescan}
          className="rounded-md border border-gray-300 px-3 py-1 text-sm hover:bg-gray-100 disabled:opacity-50"
        >
          Trigger manual rescan
        </button>
        <button
          type="button"
          disabled={isPending}
          onClick={() =>
            run("Retention cleanup", async () => {
              const result = await triggerRetentionCleanup();
              return `Retention cleanup complete: ${result.eventsDeleted} event(s) deleted, ${result.productSetsPurged} product set(s) purged.`;
            })
          }
          className="rounded-md border border-gray-300 px-3 py-1 text-sm hover:bg-gray-100 disabled:opacity-50"
        >
          Trigger retention cleanup (deletes events 30+ days old)
        </button>
        <button
          type="button"
          disabled={isPending}
          onClick={() =>
            run("Freshness check", async () => {
              const result = await triggerFreshnessCheck();
              return `Freshness check complete: ${result.checked} provider(s) checked, ${result.stale.length} stale, ${result.alarmed.length} alarmed, ${result.suppressed.length} already alarmed, ${result.recovered.length} recovered.`;
            })
          }
          className="rounded-md border border-gray-300 px-3 py-1 text-sm hover:bg-gray-100 disabled:opacity-50"
        >
          Run freshness check now
        </button>
      </div>

      {message && (
        <p className="text-sm text-gray-600" role="status">
          {message}
        </p>
      )}

      {/* ---- Cron heartbeat ------------------------------------------------
          Answers "is the droplet's cron actually firing" directly, rather
          than leaving it to be inferred from scanning the runs table below
          for a SCHEDULED row -- ops/trigger-ingest.sh's cron entry lives only
          on the host, so this is the only place that confirms it fired. */}
      {(() => {
        const hoursAgo = lastScheduledRun ? hoursSince(lastScheduledRun.createdAt) : null;
        const stale = hoursAgo === null || hoursAgo > scheduledRunStaleHours;
        if (!stale && lastScheduledRun) {
          return (
            <div className="rounded-md border border-green-200 bg-green-50 p-3 text-sm text-green-900">
              <span className="font-semibold">Cron is running.</span> Last scheduled run {formatWhen(lastScheduledRun.createdAt)}
              {hoursAgo !== null && <> ({Math.floor(hoursAgo)}h ago)</>} —{" "}
              <span
                className={`rounded px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[lastScheduledRun.status] ?? "bg-gray-100 text-gray-700"}`}
              >
                {lastScheduledRun.status}
              </span>
              {lastScheduledRun.totals && (
                <span className="ml-2">
                  <TotalsSummary totals={lastScheduledRun.totals} />
                </span>
              )}
            </div>
          );
        }
        return (
          <div role="alert" className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
            <span className="font-semibold">
              {lastScheduledRun
                ? `No scheduled run in over ${scheduledRunStaleHours}h.`
                : "No scheduled run has ever completed."}
            </span>{" "}
            {lastScheduledRun ? (
              <>
                Last one was {formatWhen(lastScheduledRun.createdAt)}
                {hoursAgo !== null && <> ({Math.floor(hoursAgo)}h ago)</>} — check the droplet&apos;s crontab and{" "}
                <code className="rounded bg-amber-100 px-1">ops/trigger-ingest.sh</code>&apos;s own log line.
              </>
            ) : (
              <>
                Every run below is manual. If the cron entry exists, check it&apos;s pointed at{" "}
                <code className="rounded bg-amber-100 px-1">/api/ingest/run</code> with a valid{" "}
                <code className="rounded bg-amber-100 px-1">INGEST_TRIGGER_TOKEN</code>.
              </>
            )}
          </div>
        );
      })()}

      {/* ---- Freshness alarms ------------------------------------------- */}
      {alarmedProviders.length > 0 && (
        <div role="alert" className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-900">
          <h3 className="font-semibold">
            Freshness alarm: {alarmedProviders.length} provider(s) have not returned data in {providerStaleHours}h
          </h3>
          <ul className="mt-1 list-inside list-disc">
            {alarmedProviders.map((provider) => (
              <li key={provider.providerKey}>
                <span className="font-medium">{provider.providerKey}</span> — last OK {formatWhen(provider.lastOkAt)}
                {provider.hoursSinceOk !== null && <> ({Math.floor(provider.hoursSinceOk)}h ago)</>}
                {provider.alarm ? (
                  <> · admins notified {formatWhen(provider.alarm.notifiedAt)}</>
                ) : (
                  <> · not yet notified (the alarm pass runs at the end of each ingest run)</>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ---- Provider freshness ------------------------------------------ */}
      <div>
        <h3 className="mb-1 text-sm font-medium text-gray-700">Provider freshness (v2 ingest)</h3>
        <p className="mb-2 text-xs text-gray-500">
          When each provider last returned usable data. <strong>NOT_MODIFIED counts as fresh</strong> — a 304 means the
          upstream answered and confirmed nothing changed. A provider silent for {providerStaleHours}h raises an alarm and
          notifies admins on their enabled channels.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-xs uppercase text-gray-500">
                <th className="py-2">Provider</th>
                <th>Freshness</th>
                <th>Last OK / 304</th>
                <th>Most recent attempt</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {providerHealth.map((provider) => (
                <tr key={provider.providerKey} className="border-b border-gray-100 align-top">
                  <td className="py-2 font-medium">{provider.providerKey}</td>
                  <td>
                    <span
                      className={`rounded px-2 py-0.5 text-xs font-medium ${
                        provider.stale ? "bg-red-100 text-red-800" : "bg-green-100 text-green-800"
                      }`}
                    >
                      {provider.stale ? "STALE" : "FRESH"}
                    </span>
                    {provider.hoursSinceOk !== null && (
                      <span className="ml-2 text-xs text-gray-500">{Math.floor(provider.hoursSinceOk)}h</span>
                    )}
                  </td>
                  <td>{formatWhen(provider.lastOkAt)}</td>
                  <td>
                    {provider.latestStatus && (
                      <span
                        className={`rounded px-2 py-0.5 text-xs font-medium ${
                          PROVIDER_STATUS_STYLES[provider.latestStatus] ?? "bg-gray-100 text-gray-700"
                        }`}
                      >
                        {provider.latestStatus}
                      </span>
                    )}{" "}
                    <span className="text-xs text-gray-500">{formatWhen(provider.latestAt)}</span>
                  </td>
                  <td className="max-w-xs break-words text-xs text-red-700">{provider.latestError ?? "—"}</td>
                </tr>
              ))}
              {providerHealth.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-4 text-center text-gray-500">
                    No provider runs recorded yet — the v2 pipeline has not run on this install.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ---- News sources (backlog item 26) ------------------------------- */}
      <div>
        <h3 className="mb-1 text-sm font-medium text-gray-700">News sources</h3>
        <p className="mb-2 text-xs text-gray-500">
          Per-source enable/disable for the news-feed pipeline (<code className="rounded bg-gray-100 px-1">ops/trigger-news.sh</code>,
          cron&apos;d every 6h). Auto-publish, no approval queue -- disabling a source stops future fetches but leaves its
          already-fetched items in place.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-xs uppercase text-gray-500">
                <th className="py-2">Source</th>
                <th>Tier</th>
                <th>Enabled</th>
                <th>Last fetched</th>
                <th>Items</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {newsSourceHealth.map((source) => (
                <tr key={source.id} className="border-b border-gray-100 align-top">
                  <td className="py-2 font-medium">{source.label}</td>
                  <td>
                    <span className="rounded bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700">{source.tier}</span>
                  </td>
                  <td>
                    <label className="flex items-center gap-1">
                      <input
                        type="checkbox"
                        checked={source.enabled}
                        disabled={isPending}
                        onChange={(e) => toggleNewsSource(source.id, source.label, e.target.checked)}
                      />
                      <span className="sr-only">{source.label} enabled</span>
                    </label>
                  </td>
                  <td>{formatWhen(source.lastFetchedAt)}</td>
                  <td>{source.itemCount}</td>
                  <td className="max-w-xs break-words text-xs text-red-700">{source.lastError ?? "—"}</td>
                </tr>
              ))}
              {newsSourceHealth.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-4 text-center text-gray-500">
                    No news sources seeded yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ---- Runs, with per-provider detail ------------------------------ */}
      <div>
        <h3 className="mb-1 text-sm font-medium text-gray-700">Recent runs</h3>
        <p className="mb-2 text-xs text-gray-500">
          <strong>Replay</strong> re-runs Normalize → Apply over the bytes this run already stored — <em>no network I/O
          at all</em>, so it answers &ldquo;what would today&rsquo;s code conclude from that day&rsquo;s data&rdquo;.{" "}
          <strong>Retry failed</strong> re-fetches <em>only</em> the providers that FAILED, merges them into the same run,
          and replays; providers that succeeded are never re-requested.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-xs uppercase text-gray-500">
                <th className="py-2">Status</th>
                <th>Providers</th>
                <th>Results</th>
                <th>Scope</th>
                <th>Trigger</th>
                <th>Started</th>
                <th>Finished</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {ingestRuns.map((runRow) => {
                const health = RUN_HEALTH_LABELS[runRow.providerHealth] ?? RUN_HEALTH_LABELS.NO_PROVIDERS;
                return (
                  <tr key={runRow.id} className="border-b border-gray-100 align-top">
                    <td className="py-2">
                      <span
                        className={`rounded px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[runRow.status] ?? "bg-gray-100 text-gray-700"}`}
                      >
                        {runRow.status}
                      </span>
                      {runRow.retryOfRunId && <div className="mt-1 text-xs text-gray-500">retry of an earlier run</div>}
                    </td>
                    <td className="py-2">
                      <span className={`rounded px-2 py-0.5 text-xs font-medium ${health.className}`} title={health.hint}>
                        {health.label}
                      </span>
                      {runRow.providerRuns.length > 0 && (
                        <ul className="mt-1 flex flex-col gap-0.5">
                          {runRow.providerRuns.map((provider) => (
                            <li key={provider.providerKey} className="text-xs">
                              <span
                                className={`mr-1 rounded px-1.5 py-0.5 font-medium ${
                                  PROVIDER_STATUS_STYLES[provider.status] ?? "bg-gray-100 text-gray-700"
                                }`}
                              >
                                {provider.status}
                              </span>
                              <span className="font-medium">{provider.providerKey}</span>{" "}
                              <span className="text-gray-500">
                                · {provider.candidates} candidate(s) · {formatDuration(provider.durationMs)}
                              </span>
                              {provider.error && <div className="ml-1 break-words text-red-700">{provider.error}</div>}
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                    <td className="py-2 text-xs">
                      {runRow.diffSummary ? (
                        <div className="flex flex-col gap-0.5">
                          <span className="font-medium text-gray-800">
                            {runRow.diffSummary.newEvents} new · {runRow.diffSummary.newlyConfirmed} confirmed
                          </span>
                          <span className="text-gray-500">{runRow.diffSummary.totalChanges} change(s) total</span>
                        </div>
                      ) : (
                        <span className="text-gray-400">No diff recorded</span>
                      )}
                    </td>
                    <td>{runRow.scopeType}</td>
                    <td>{runRow.trigger}</td>
                    <td>{formatWhen(runRow.createdAt)}</td>
                    <td>{formatWhen(runRow.finishedAt)}</td>
                    <td>
                      <div className="flex flex-col gap-1">
                        <button
                          type="button"
                          disabled={isPending || runRow.providerRuns.length === 0}
                          onClick={() =>
                            run("Replay", async () => {
                              const result = await replayIngestRun(runRow.id);
                              return `Replayed (no network): ${result.totals.candidates} candidate(s), ${result.totals.eventsPublished} published, ${result.totals.eventsFlagged} flagged.`;
                            })
                          }
                          title="Re-runs the pipeline over this run's stored payloads. Performs no network requests."
                          className="rounded-md border border-gray-300 px-2 py-1 text-xs hover:bg-gray-100 disabled:opacity-50"
                        >
                          Replay (no network)
                        </button>
                        <button
                          type="button"
                          disabled={isPending || !runRow.hasFailedProviders}
                          onClick={() =>
                            run("Retry", async () => {
                              const result = await retryIngestRun(runRow.id);
                              return `Retried: re-fetched ${result.refetched.join(", ") || "nothing"}; still failing: ${
                                result.stillFailing.join(", ") || "none"
                              }.`;
                            })
                          }
                          title="Re-fetches only the providers that FAILED in this run, then replays it."
                          className="rounded-md border border-gray-300 px-2 py-1 text-xs hover:bg-gray-100 disabled:opacity-50"
                        >
                          Retry failed{runRow.hasFailedProviders ? "" : " (none)"}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {ingestRuns.length === 0 && (
                <tr>
                  <td colSpan={8} className="py-4 text-center text-gray-500">
                    No runs yet — trigger a manual rescan above, or wait for the next scheduled scan.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

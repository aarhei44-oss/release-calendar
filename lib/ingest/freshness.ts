import * as ingestRepo from "@/data/ingest/ingestRepo";
import { logEvent } from "@/lib/logger";
import { dispatchAdminAlarm } from "@/lib/notifications/dispatch";

/**
 * Freshness alarms: notice when a provider has quietly stopped returning data.
 *
 * This is the failure mode most likely to hurt this product, and it is the one
 * that is hardest to see. A calendar that stopped updating three days ago
 * renders exactly like a calendar that is up to date -- same events, same
 * dates, same confidence badges -- and every automated check we have would
 * still pass: the process is up, the database answers, the runs "succeed".
 * The only observable difference is a timestamp nobody looks at. So the
 * timestamp gets looked at here, on a schedule, and says so out loud.
 *
 * The alarm is deliberately about *providers*, not about runs. A run that
 * fetches four of five providers is recorded as SUCCEEDED (see
 * orchestrate.ts's finalize call, and the reasoning there), which is correct
 * for the run and useless as a health signal. "Nobody has heard from
 * Bulbapedia since Tuesday" is the sentence an operator actually needs.
 */

/**
 * The freshness tunables, in the same spirit as lib/ingest/gate.ts's
 * GATE_THRESHOLDS -- one named block so the numbers are arguable in one place
 * rather than scattered as literals.
 *
 *  - staleAfterHours: the pipeline runs daily, so a single missed run is
 *    normal-ish (an upstream 500, a network blip; retryRun exists for it).
 *    Two consecutive missed days is not: it means the failure survived a
 *    retry window and is structural -- a changed URL, a changed page shape, a
 *    block. 48 hours is the smallest threshold that does not fire on one bad
 *    night.
 *  - repeatAfterHours: an outage stays true on every subsequent run, so
 *    without a repeat window an ongoing problem mails an admin daily until
 *    they filter the sender. One reminder a day after the first is enough to
 *    stay visible without becoming noise.
 */
export const FRESHNESS_THRESHOLDS = {
  /** Hours since a provider last returned OK or NOT_MODIFIED before it alarms. */
  staleAfterHours: 48,
  /** Hours before a still-unrecovered provider alarms again. */
  repeatAfterHours: 24,
} as const;

/** Convenience alias for the single number most callers (and the System tab) care about. */
export const PROVIDER_STALE_AFTER_HOURS = FRESHNESS_THRESHOLDS.staleAfterHours;

const MS_PER_HOUR = 60 * 60 * 1000;

/** One provider's freshness, as both the alarm pass and the admin UI read it. */
export type ProviderFreshness = {
  providerKey: string;
  /** Last run in which this provider returned OK or NOT_MODIFIED, or null if it never has. */
  lastOkAt: Date | null;
  /**
   * The moment the current silence started: the last success, or -- for a
   * provider that has never once succeeded -- the first time we tried it. A
   * provider that has been failing since the day it was added is stale, and
   * treating "never succeeded" as "not yet stale" would make exactly the
   * newest, least-proven provider the one nobody is told about.
   */
  silentSince: Date | null;
  hoursSinceOk: number | null;
  stale: boolean;
};

export type ProviderRunTimestamps = {
  providerKey: string;
  lastOkAt: Date | null;
  firstSeenAt: Date | null;
};

/**
 * Pure: turns per-provider timestamps into freshness verdicts.
 *
 * Split out from the pass below so the 48-hour boundary is testable at the
 * hour without a database, a clock, or a notification transport.
 */
export function evaluateFreshness(
  rows: ProviderRunTimestamps[],
  now: Date,
  staleAfterHours: number = FRESHNESS_THRESHOLDS.staleAfterHours,
): ProviderFreshness[] {
  return rows.map((row) => {
    const silentSince = row.lastOkAt ?? row.firstSeenAt;
    const hoursSinceOk = silentSince ? (now.getTime() - silentSince.getTime()) / MS_PER_HOUR : null;
    return {
      providerKey: row.providerKey,
      lastOkAt: row.lastOkAt,
      silentSince,
      hoursSinceOk,
      // A provider with no history at all is not stale: it has never been
      // asked for anything (its game may not be installed), so there is
      // nothing to be silent about.
      stale: hoursSinceOk !== null && hoursSinceOk >= staleAfterHours,
    };
  });
}

export type FreshnessAlarmResult = {
  checked: number;
  /** Providers currently over the threshold, alarmed or not. */
  stale: string[];
  /** Providers a notification actually went out for this pass. */
  alarmed: string[];
  /** Stale providers whose alarm was suppressed because one is already standing. */
  suppressed: string[];
  /** Providers whose standing alarm was cleared because they came back. */
  recovered: string[];
};

function describeStale(freshness: ProviderFreshness): string {
  const hours = freshness.hoursSinceOk === null ? "?" : Math.floor(freshness.hoursSinceOk).toString();
  const last = freshness.lastOkAt ? freshness.lastOkAt.toISOString() : "never";
  return `${freshness.providerKey}: no successful fetch for ${hours}h (last OK: ${last})`;
}

/**
 * Checks every provider's freshness, alarms on the newly-stale ones, and
 * clears the alarms of any that recovered.
 *
 * Idempotent by design. The *condition* (>= 48h silent) is recomputed from
 * ProviderRun history every pass and is therefore true on every run for the
 * whole length of an outage; the ProviderAlarm row is what remembers that
 * somebody has already been told. So calling this ten times in a row sends one
 * notification, not ten -- which is the difference between an alarm and a
 * nuisance an operator learns to filter.
 *
 * Best-effort throughout: this is observability, and it must never be able to
 * fail an ingest run that otherwise worked.
 */
export async function runProviderFreshnessAlarmPass(
  options: { now?: Date } = {},
): Promise<FreshnessAlarmResult> {
  const now = options.now ?? new Date();
  const result: FreshnessAlarmResult = { checked: 0, stale: [], alarmed: [], suppressed: [], recovered: [] };

  const timestamps = await ingestRepo.getProviderRunTimestamps();
  const freshness = evaluateFreshness(timestamps, now);
  const alarms = new Map((await ingestRepo.listProviderAlarms()).map((row) => [row.providerKey, row]));
  result.checked = freshness.length;

  const newlyAlarmed: ProviderFreshness[] = [];

  for (const provider of freshness) {
    const existing = alarms.get(provider.providerKey);
    const standing = existing && existing.clearedAt === null ? existing : null;

    if (!provider.stale) {
      if (standing) {
        await ingestRepo.clearProviderAlarm(provider.providerKey, now);
        result.recovered.push(provider.providerKey);
      }
      continue;
    }

    result.stale.push(provider.providerKey);

    if (standing) {
      const hoursSinceNotified = (now.getTime() - standing.notifiedAt.getTime()) / MS_PER_HOUR;
      if (hoursSinceNotified < FRESHNESS_THRESHOLDS.repeatAfterHours) {
        result.suppressed.push(provider.providerKey);
        continue;
      }
    }

    await ingestRepo.raiseProviderAlarm({
      providerKey: provider.providerKey,
      // Keep the original opening time across a repeat notification: "stale
      // since Tuesday" is the useful fact, and resetting it every reminder
      // would make a week-long outage look like it started an hour ago.
      openedAt: standing?.openedAt ?? now,
      notifiedAt: now,
      lastOkAt: provider.lastOkAt,
    });
    result.alarmed.push(provider.providerKey);
    newlyAlarmed.push(provider);
  }

  if (newlyAlarmed.length > 0) {
    await dispatchAdminAlarm({
      subject:
        newlyAlarmed.length === 1
          ? `Release Watcher: provider ${newlyAlarmed[0].providerKey} has gone quiet`
          : `Release Watcher: ${newlyAlarmed.length} providers have gone quiet`,
      body: [
        `No successful fetch in ${FRESHNESS_THRESHOLDS.staleAfterHours}h from:`,
        ...newlyAlarmed.map((provider) => `- ${describeStale(provider)}`),
        "",
        "Check the admin System tab for per-run provider status, and use Retry failed to re-fetch.",
      ].join("\n"),
    });
  }

  if (result.recovered.length > 0) {
    // A recovery is worth saying out loud too: an operator who was told about
    // an outage has no other way to learn it ended, and silence reads the same
    // as "still broken".
    await dispatchAdminAlarm({
      subject: `Release Watcher: ${result.recovered.length} provider(s) recovered`,
      body: `Back to returning data: ${result.recovered.join(", ")}`,
    });
  }

  logEvent({
    action: "ingest.freshnessAlarmPass",
    outcome: "success",
    checked: result.checked,
    stale: result.stale.join(",") || "none",
    alarmed: result.alarmed.join(",") || "none",
    suppressed: result.suppressed.join(",") || "none",
    recovered: result.recovered.join(",") || "none",
  });

  return result;
}

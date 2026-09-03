import { runScan } from "./orchestrate";
import { logEvent } from "@/lib/logger";

let started = false;

const SCHEDULE_TIMEZONE = "America/Los_Angeles";
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Milliseconds from `now` until the next local midnight in `timeZone`. Only
 * needs that zone's current wall-clock time-of-day, not a full zone-aware
 * Date (the platform Date API can't construct one directly) --
 * Intl.DateTimeFormat's timeZone option already does the DST-aware
 * conversion. Exported so the scheduling math can be unit-tested without
 * mocking timers.
 */
export function msUntilNextMidnight(timeZone: string, now: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(now);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const msSinceMidnight = ((get("hour") * 60 + get("minute")) * 60 + get("second")) * 1000 + now.getMilliseconds();
  return DAY_MS - msSinceMidnight;
}

/**
 * Recomputes the delay to the next local midnight on every pass (instead of
 * a fixed setInterval) so the daily cadence stays anchored to actual local
 * midnight across a DST transition, where the gap to "tomorrow midnight" is
 * 23h or 25h rather than a flat 24h.
 */
function scheduleNextRun() {
  const delay = msUntilNextMidnight(SCHEDULE_TIMEZONE);
  setTimeout(() => {
    // runScan logs its own outcome; this catch only guards against something
    // failing outside that try/catch (lock acquisition, ScanRun creation).
    runScan({ scopeType: "ALL", trigger: "SCHEDULED" }).catch((error) => {
      logEvent({
        action: "crawler.scheduledScan",
        outcome: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    });
    scheduleNextRun();
  }, delay);
}

/**
 * In-process scheduler, invoked once from instrumentation.ts at server
 * boot. Runs a full scan once a day at midnight America/Los_Angeles.
 * CRAWLER_SCHEDULE just gates whether the schedule is on at all (any
 * positive number enables it; unset or <= 0 disables it, and an admin can
 * still trigger a scan manually from the System tab) -- kept as the same
 * env var name for backward compatibility with existing deployment config,
 * even though its value is no longer read as "minutes between scans."
 * Deliberately does not run an immediate scan on boot -- only the recurring
 * daily one -- so `next dev` restarts don't repeatedly hit live external
 * sites while iterating.
 */
export function startCrawlerScheduler() {
  if (started) return;
  started = true;

  const enabled = Number(process.env.CRAWLER_SCHEDULE ?? "0");
  if (!Number.isFinite(enabled) || enabled <= 0) {
    console.log("[crawler] CRAWLER_SCHEDULE not set (or <= 0); scheduled scans disabled");
    return;
  }

  console.log(`[crawler] scheduled scans daily at midnight ${SCHEDULE_TIMEZONE}`);
  scheduleNextRun();
}

import { runScan } from "./orchestrate";
import { logEvent } from "@/lib/logger";

let started = false;

/**
 * In-process scheduler, invoked once from instrumentation.ts at server
 * boot. CRAWLER_SCHEDULE is the interval in minutes; unset or <= 0 disables
 * scheduled scans entirely (an admin can still trigger one manually from
 * the System tab). Deliberately does not run an immediate scan on boot --
 * only the recurring interval -- so `next dev` restarts don't repeatedly
 * hit live external sites while iterating.
 */
export function startCrawlerScheduler() {
  if (started) return;
  started = true;

  const minutes = Number(process.env.CRAWLER_SCHEDULE ?? "0");
  if (!Number.isFinite(minutes) || minutes <= 0) {
    console.log("[crawler] CRAWLER_SCHEDULE not set (or <= 0); scheduled scans disabled");
    return;
  }

  console.log(`[crawler] scheduled scans every ${minutes} minute(s)`);

  setInterval(() => {
    // runScan logs its own outcome; this catch only guards against something
    // failing outside that try/catch (lock acquisition, ScanRun creation).
    runScan({ scopeType: "ALL", trigger: "SCHEDULED" }).catch((error) => {
      logEvent({
        action: "crawler.scheduledScan",
        outcome: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, minutes * 60 * 1000);
}

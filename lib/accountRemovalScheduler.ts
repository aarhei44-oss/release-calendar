import { msUntilNextLocalHour } from "@/lib/notifications/digestScheduler";
import { runAccountRemovalPass } from "@/lib/accountRemoval";
import { logEvent } from "@/lib/logger";

const SCHEDULE_TIMEZONE = "America/Los_Angeles";
const RUN_HOUR = 3; // 03:00 local -- quiet hours, well clear of the 08:00 digest tick.

let started = false;

function scheduleNextRun() {
  setTimeout(() => {
    runAccountRemovalPass()
      .then((result) => logEvent({ action: "accountRemoval.scheduledPass", outcome: "success", ...result }))
      .catch((error) => {
        logEvent({
          action: "accountRemoval.scheduledPass",
          outcome: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      });
    scheduleNextRun();
  }, msUntilNextLocalHour(SCHEDULE_TIMEZONE, RUN_HOUR));
}

/**
 * In-process nightly scheduler, invoked once from instrumentation.ts at server
 * boot -- same self-rescheduling pattern as digestScheduler.ts. Lives in the
 * app (not a droplet cron) so it ships with every deploy and needs no extra
 * secret or ops step.
 */
export function startAccountRemovalScheduler() {
  if (started) return;
  started = true;
  scheduleNextRun();
}

import { getDigestSubscribers } from "@/data/notifications/notificationsRepo";
import { getUpcomingForSubscriptions } from "@/data/subscriptions/subscriptionsRepo";
import { sendDigestEmail } from "./email";
import { logEvent } from "@/lib/logger";

const SCHEDULE_TIMEZONE = "America/Los_Angeles";
const SEND_HOUR = 8; // 08:00 local -- arbitrary, chosen to land in most US timezones' morning.
const DAY_MS = 24 * 60 * 60 * 1000;
const UPCOMING_WINDOW_DAYS = 14;
// Which day WEEKLY digests go out. Anchored to SCHEDULE_TIMEZONE, not each
// recipient's own profile timezone -- a per-user weekly anchor would need a
// per-user schedule, not one shared daily tick; a known simplification, not
// an oversight.
const WEEKLY_SEND_WEEKDAY = "Mon";

let started = false;

/** Milliseconds from `now` until the next local `hour`:00 in `timeZone`. */
export function msUntilNextLocalHour(timeZone: string, hour: number, now: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(now);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const msSinceMidnight = ((get("hour") * 60 + get("minute")) * 60 + get("second")) * 1000 + now.getMilliseconds();
  const targetMsFromMidnight = hour * 60 * 60 * 1000;
  const delay = targetMsFromMidnight - msSinceMidnight;
  return delay > 0 ? delay : delay + DAY_MS;
}

function localWeekday(timeZone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(now);
}

export type DigestPassResult = { sent: number; skipped: number; errors: number };

/**
 * Sends today's digest to every eligible subscriber: DAILY subscribers
 * every run, WEEKLY subscribers only on WEEKLY_SEND_WEEKDAY. Each send is
 * isolated in its own try/catch, same reasoning as
 * lib/notifications/dispatch.ts -- one bad address or transport hiccup
 * shouldn't cost every other subscriber their digest.
 */
export async function runDigestPass(now: Date = new Date()): Promise<DigestPassResult> {
  const result: DigestPassResult = { sent: 0, skipped: 0, errors: 0 };
  const isWeeklySendDay = localWeekday(SCHEDULE_TIMEZONE, now) === WEEKLY_SEND_WEEKDAY;

  const subscribers = await getDigestSubscribers();
  for (const subscriber of subscribers) {
    if (subscriber.frequency === "WEEKLY" && !isWeeklySendDay) {
      result.skipped += 1;
      continue;
    }

    try {
      const events = await getUpcomingForSubscriptions(subscriber.userId, UPCOMING_WINDOW_DAYS);
      await sendDigestEmail(subscriber.email, subscriber.frequency, events, subscriber.timezone ?? undefined);
      result.sent += 1;
    } catch (error) {
      result.errors += 1;
      logEvent({
        action: "notifications.runDigestPass",
        outcome: "error",
        userId: subscriber.userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}

function scheduleNextRun() {
  const delay = msUntilNextLocalHour(SCHEDULE_TIMEZONE, SEND_HOUR);
  setTimeout(() => {
    runDigestPass().catch((error) => {
      logEvent({
        action: "notifications.scheduledDigestPass",
        outcome: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    });
    scheduleNextRun();
  }, delay);
}

/**
 * In-process scheduler, invoked once from instrumentation.ts at server
 * boot alongside the crawler scheduler. Runs once a day at 08:00 America/
 * Los_Angeles; runDigestPass itself decides per-subscriber whether today
 * is a send day. No env-var gate like CRAWLER_SCHEDULE -- this only ever
 * does anything once a premium user has actually opted in, so there's no
 * equivalent "don't hit live external sites while iterating" risk.
 */
export function startDigestScheduler() {
  if (started) return;
  started = true;
  scheduleNextRun();
}

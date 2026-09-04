import { getLeadTimeReminderSubscribers } from "@/data/notifications/notificationsRepo";
import { getSubscribedInstallIds } from "@/data/subscriptions/subscriptionsRepo";
import { getEventsStartingOn } from "@/data/calendar/calendarRepo";
import { sendLeadTimeReminderEmail } from "./email";
import { msUntilNextLocalHour } from "./digestScheduler";
import { logEvent } from "@/lib/logger";

const SCHEDULE_TIMEZONE = "America/Los_Angeles";
const SEND_HOUR = 8; // same daily tick as the digest scheduler -- one wake-up per subscriber concern is enough.

let started = false;

export type LeadTimeReminderPassResult = { sent: number; skipped: number; errors: number };

/**
 * For each subscriber, finds events across their subscribed installs that
 * *start* exactly `days` days from `now` (see calendarRepo.getEventsStartingOn
 * for why "starts on" and not "overlaps") and sends one reminder if any
 * exist. Naturally fires once per event, the day it crosses the N-day
 * threshold -- no separate "already reminded" bookkeeping needed, since a
 * date only equals today+N on one calendar day.
 */
export async function runLeadTimeReminderPass(now: Date = new Date()): Promise<LeadTimeReminderPassResult> {
  const result: LeadTimeReminderPassResult = { sent: 0, skipped: 0, errors: 0 };
  const subscribers = await getLeadTimeReminderSubscribers();

  for (const subscriber of subscribers) {
    try {
      const installIds = await getSubscribedInstallIds(subscriber.userId);
      if (installIds.length === 0) {
        result.skipped += 1;
        continue;
      }

      const targetDay = new Date(now.getTime() + subscriber.days * 24 * 60 * 60 * 1000);
      const events = await getEventsStartingOn({ installIds, day: targetDay });
      if (events.length === 0) {
        result.skipped += 1;
        continue;
      }

      await sendLeadTimeReminderEmail(subscriber.email, subscriber.days, events);
      result.sent += 1;
    } catch (error) {
      result.errors += 1;
      logEvent({
        action: "notifications.runLeadTimeReminderPass",
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
    runLeadTimeReminderPass().catch((error) => {
      logEvent({
        action: "notifications.scheduledLeadTimeReminderPass",
        outcome: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    });
    scheduleNextRun();
  }, delay);
}

/** In-process scheduler, invoked once from instrumentation.ts alongside the crawler and digest schedulers. */
export function startLeadTimeReminderScheduler() {
  if (started) return;
  started = true;
  scheduleNextRun();
}

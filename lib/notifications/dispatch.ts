import { getSubscribersForInstalls } from "@/data/notifications/notificationsRepo";
import { logEvent } from "@/lib/logger";
import { sendEmailAlert } from "./email";
import type { ScanChange } from "./types";

/**
 * Fans a scan's collected changes out to every subscriber's enabled alert
 * channels, one message per user (not per change) so a user subscribed to
 * several affected games in the same scan gets a single email rather than a
 * flood. Each recipient's send is isolated in its own try/catch -- one bad
 * address or transport hiccup shouldn't drop alerts for everyone else, and
 * this whole pass is itself best-effort from orchestrate.ts's point of view
 * (a notification failure must never fail the scan that produced the data).
 */
export async function dispatchScanChangeNotifications(changes: ScanChange[]): Promise<void> {
  if (changes.length === 0) return;

  const installIds = [...new Set(changes.map((change) => change.installId))];
  const subscribers = await getSubscribersForInstalls(installIds);
  if (subscribers.length === 0) return;

  const changesByInstall = new Map<string, ScanChange[]>();
  for (const change of changes) {
    const list = changesByInstall.get(change.installId);
    if (list) list.push(change);
    else changesByInstall.set(change.installId, [change]);
  }

  const emailChangesByUser = new Map<string, { email: string; changes: ScanChange[] }>();
  for (const subscriber of subscribers) {
    const installChanges = changesByInstall.get(subscriber.installId);
    if (!installChanges) continue;

    if (subscriber.emailAlertsEnabled) {
      const entry = emailChangesByUser.get(subscriber.userId) ?? { email: subscriber.email, changes: [] };
      entry.changes.push(...installChanges);
      emailChangesByUser.set(subscriber.userId, entry);
    }
  }

  for (const [userId, entry] of emailChangesByUser) {
    try {
      await sendEmailAlert(entry.email, entry.changes);
    } catch (error) {
      logEvent({
        action: "notifications.sendEmailAlert",
        outcome: "error",
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

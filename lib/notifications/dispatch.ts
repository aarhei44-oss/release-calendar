import { getSubscribersForInstalls, getFollowersForEvents } from "@/data/notifications/notificationsRepo";
import { logEvent } from "@/lib/logger";
import { sendEmailAlert } from "./email";
import { sendDiscordAlert } from "./discord";
import type { ScanChange } from "./types";

type RecipientAccumulator = {
  emailChangesByUser: Map<string, { email: string; changes: Set<ScanChange> }>;
  discordChangesByUser: Map<string, { webhookUrl: string; changes: Set<ScanChange> }>;
};

function accumulate(
  acc: RecipientAccumulator,
  recipient: {
    userId: string;
    email: string;
    emailAlertsEnabled: boolean;
    discordWebhookUrl: string | null;
    discordAlertsEnabled: boolean;
  },
  relevantChanges: ScanChange[],
) {
  if (recipient.emailAlertsEnabled) {
    const entry = acc.emailChangesByUser.get(recipient.userId) ?? { email: recipient.email, changes: new Set<ScanChange>() };
    for (const change of relevantChanges) entry.changes.add(change);
    acc.emailChangesByUser.set(recipient.userId, entry);
  }

  if (recipient.discordAlertsEnabled && recipient.discordWebhookUrl) {
    const entry = acc.discordChangesByUser.get(recipient.userId) ?? {
      webhookUrl: recipient.discordWebhookUrl,
      changes: new Set<ScanChange>(),
    };
    for (const change of relevantChanges) entry.changes.add(change);
    acc.discordChangesByUser.set(recipient.userId, entry);
  }
}

/**
 * Fans a scan's collected changes out to every relevant recipient's enabled
 * alert channels, one message per user (not per change or per recipient
 * type) so a user subscribed to several affected games -- or subscribed to
 * one and separately following a specific event in another -- gets a
 * single email rather than a flood. There are two independent ways to be a
 * recipient for the same change: subscribed to the whole game
 * (getSubscribersForInstalls, free) or following that one event
 * specifically (getFollowersForEvents, premium); a user who is both is
 * still only sent once, since both paths add into the same per-user Set
 * keyed by change object identity (both paths reference the same original
 * ScanChange objects, so the Set's reference-equality dedup just works).
 * Each recipient's send is isolated in its own try/catch -- one bad
 * address or transport hiccup shouldn't drop alerts for everyone else, and
 * this whole pass is itself best-effort from orchestrate.ts's point of view
 * (a notification failure must never fail the scan that produced the data).
 */
export async function dispatchScanChangeNotifications(changes: ScanChange[]): Promise<void> {
  if (changes.length === 0) return;

  const installIds = [...new Set(changes.map((change) => change.installId))];
  const eventIds = [...new Set(changes.map((change) => change.eventId))];
  const [installSubscribers, eventFollowers] = await Promise.all([
    getSubscribersForInstalls(installIds),
    getFollowersForEvents(eventIds),
  ]);
  if (installSubscribers.length === 0 && eventFollowers.length === 0) return;

  const changesByInstall = new Map<string, ScanChange[]>();
  const changesByEvent = new Map<string, ScanChange[]>();
  for (const change of changes) {
    const installList = changesByInstall.get(change.installId);
    if (installList) installList.push(change);
    else changesByInstall.set(change.installId, [change]);

    const eventList = changesByEvent.get(change.eventId);
    if (eventList) eventList.push(change);
    else changesByEvent.set(change.eventId, [change]);
  }

  const acc: RecipientAccumulator = { emailChangesByUser: new Map(), discordChangesByUser: new Map() };

  for (const subscriber of installSubscribers) {
    const installChanges = changesByInstall.get(subscriber.installId);
    if (installChanges) accumulate(acc, subscriber, installChanges);
  }

  for (const follower of eventFollowers) {
    const eventChanges = changesByEvent.get(follower.eventId);
    if (eventChanges) accumulate(acc, follower, eventChanges);
  }

  for (const [userId, entry] of acc.emailChangesByUser) {
    try {
      await sendEmailAlert(entry.email, [...entry.changes]);
    } catch (error) {
      logEvent({
        action: "notifications.sendEmailAlert",
        outcome: "error",
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  for (const [userId, entry] of acc.discordChangesByUser) {
    try {
      await sendDiscordAlert(entry.webhookUrl, [...entry.changes]);
    } catch (error) {
      logEvent({
        action: "notifications.sendDiscordAlert",
        outcome: "error",
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

import { prisma } from "@/lib/prisma";
import type { DigestFrequency } from "@/app/generated/prisma/client";

export type InstallSubscriber = {
  userId: string;
  installId: string;
  email: string;
  emailAlertsEnabled: boolean;
  discordWebhookUrl: string | null;
  discordAlertsEnabled: boolean;
};

/** Every subscriber (with their alert preferences) across a set of installs, one row per (user, install) subscription. */
export async function getSubscribersForInstalls(installIds: string[]): Promise<InstallSubscriber[]> {
  if (installIds.length === 0) return [];

  const subscriptions = await prisma.subscription.findMany({
    where: { tcgProfileInstallId: { in: installIds } },
    select: {
      tcgProfileInstallId: true,
      user: {
        select: {
          id: true,
          email: true,
          emailAlertsEnabled: true,
          discordWebhookUrl: true,
          discordAlertsEnabled: true,
        },
      },
    },
  });

  return subscriptions.map((s) => ({
    userId: s.user.id,
    installId: s.tcgProfileInstallId,
    email: s.user.email,
    emailAlertsEnabled: s.user.emailAlertsEnabled,
    discordWebhookUrl: s.user.discordWebhookUrl,
    discordAlertsEnabled: s.user.discordAlertsEnabled,
  }));
}

export type DigestSubscriber = {
  userId: string;
  email: string;
  frequency: DigestFrequency;
  timezone: string | null;
};

/** Premium users with the digest opted in -- non-premium users are excluded even if the flag is set (e.g. a lapsed premium period), same rule as the dashboard-cards gate. */
export async function getDigestSubscribers(): Promise<DigestSubscriber[]> {
  const users = await prisma.user.findMany({
    where: { isPremium: true, digestEmailEnabled: true },
    select: { id: true, email: true, digestFrequency: true, timezone: true },
  });

  return users.map((u) => ({
    userId: u.id,
    email: u.email,
    frequency: u.digestFrequency,
    timezone: u.timezone,
  }));
}

export type LeadTimeReminderSubscriber = {
  userId: string;
  email: string;
  days: number;
  timezone: string | null;
};

/** Premium users with a lead-time reminder configured (leadTimeReminderDays not null). Same non-premium exclusion rule as getDigestSubscribers. */
export async function getLeadTimeReminderSubscribers(): Promise<LeadTimeReminderSubscriber[]> {
  const users = await prisma.user.findMany({
    where: { isPremium: true, leadTimeReminderDays: { not: null } },
    select: { id: true, email: true, leadTimeReminderDays: true, timezone: true },
  });

  return users.map((u) => ({
    userId: u.id,
    email: u.email,
    days: u.leadTimeReminderDays!,
    timezone: u.timezone,
  }));
}

export type EventFollower = {
  userId: string;
  eventId: string;
  email: string;
  emailAlertsEnabled: boolean;
  discordWebhookUrl: string | null;
  discordAlertsEnabled: boolean;
};

/**
 * Every premium follower (with their alert preferences) across a set of
 * events -- the event-level counterpart to getSubscribersForInstalls, for
 * "follow individual events, not just whole games." Non-premium excluded:
 * unlike the install-subscription channel (free), following a specific
 * event to get notified about only it is itself the premium feature.
 */
export async function getFollowersForEvents(eventIds: string[]): Promise<EventFollower[]> {
  if (eventIds.length === 0) return [];

  const follows = await prisma.eventFollow.findMany({
    where: { releaseEventId: { in: eventIds } },
    select: {
      releaseEventId: true,
      user: {
        select: {
          id: true,
          email: true,
          isPremium: true,
          emailAlertsEnabled: true,
          discordWebhookUrl: true,
          discordAlertsEnabled: true,
        },
      },
    },
  });

  return follows
    .filter((f) => f.user.isPremium)
    .map((f) => ({
      userId: f.user.id,
      eventId: f.releaseEventId,
      email: f.user.email,
      emailAlertsEnabled: f.user.emailAlertsEnabled,
      discordWebhookUrl: f.user.discordWebhookUrl,
      discordAlertsEnabled: f.user.discordAlertsEnabled,
    }));
}

export type AdminAlertRecipient = {
  userId: string;
  email: string;
  emailAlertsEnabled: boolean;
  discordWebhookUrl: string | null;
  discordAlertsEnabled: boolean;
};

/**
 * Active admins, with the same alert-channel preferences every other
 * notification path reads.
 *
 * Operational alarms (lib/ingest/freshness.ts) are admin-facing: a user does
 * not need to know that Bulbapedia stopped answering, and telling them would
 * be alarming without being actionable. Recipients are resolved by role rather
 * than by a separate "ops contact" setting, so there is exactly one place
 * (/admin's Users tab) where "who gets told" is decided.
 *
 * The per-channel opt-ins are still honoured. An admin who turned email alerts
 * off asked not to be emailed, and quietly overriding that for a class of
 * message we happen to consider important is how an app teaches people to
 * distrust its preferences.
 */
export async function getAdminAlertRecipients(): Promise<AdminAlertRecipient[]> {
  const users = await prisma.user.findMany({
    where: { role: "ADMIN", active: true },
    select: {
      id: true,
      email: true,
      emailAlertsEnabled: true,
      discordWebhookUrl: true,
      discordAlertsEnabled: true,
    },
  });

  return users.map((u) => ({
    userId: u.id,
    email: u.email,
    emailAlertsEnabled: u.emailAlertsEnabled,
    discordWebhookUrl: u.discordWebhookUrl,
    discordAlertsEnabled: u.discordAlertsEnabled,
  }));
}

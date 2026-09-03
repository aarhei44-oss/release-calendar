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

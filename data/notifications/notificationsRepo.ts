import { prisma } from "@/lib/prisma";

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

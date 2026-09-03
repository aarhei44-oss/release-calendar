import { prisma } from "@/lib/prisma";

export async function getProfile(userId: string) {
  return prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: {
      timezone: true,
      emailAlertsEnabled: true,
      discordWebhookUrl: true,
      discordAlertsEnabled: true,
    },
  });
}

export async function updateTimezone(userId: string, timezone: string | null) {
  return prisma.user.update({
    where: { id: userId },
    data: { timezone },
    select: { timezone: true },
  });
}

export async function updateEmailAlertsEnabled(userId: string, enabled: boolean) {
  return prisma.user.update({
    where: { id: userId },
    data: { emailAlertsEnabled: enabled },
    select: { emailAlertsEnabled: true },
  });
}

export async function updateDiscordWebhookUrl(userId: string, webhookUrl: string | null) {
  return prisma.user.update({
    where: { id: userId },
    data: { discordWebhookUrl: webhookUrl },
    select: { discordWebhookUrl: true },
  });
}

export async function updateDiscordAlertsEnabled(userId: string, enabled: boolean) {
  return prisma.user.update({
    where: { id: userId },
    data: { discordAlertsEnabled: enabled },
    select: { discordAlertsEnabled: true },
  });
}

import { prisma } from "@/lib/prisma";
import { Prisma, type DigestFrequency } from "@/app/generated/prisma/client";

export async function getProfile(userId: string) {
  return prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: {
      timezone: true,
      emailAlertsEnabled: true,
      discordWebhookUrl: true,
      discordAlertsEnabled: true,
      isPremium: true,
      dashboardCardIds: true,
      digestEmailEnabled: true,
      digestFrequency: true,
      leadTimeReminderDays: true,
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

export async function updateDashboardCardIds(userId: string, cardIds: string[] | null) {
  return prisma.user.update({
    where: { id: userId },
    data: { dashboardCardIds: cardIds ?? Prisma.JsonNull },
    select: { dashboardCardIds: true },
  });
}

export async function updateDigestEmailEnabled(userId: string, enabled: boolean) {
  return prisma.user.update({
    where: { id: userId },
    data: { digestEmailEnabled: enabled },
    select: { digestEmailEnabled: true },
  });
}

export async function updateDigestFrequency(userId: string, frequency: DigestFrequency) {
  return prisma.user.update({
    where: { id: userId },
    data: { digestFrequency: frequency },
    select: { digestFrequency: true },
  });
}

export async function updateLeadTimeReminderDays(userId: string, days: number | null) {
  return prisma.user.update({
    where: { id: userId },
    data: { leadTimeReminderDays: days },
    select: { leadTimeReminderDays: true },
  });
}

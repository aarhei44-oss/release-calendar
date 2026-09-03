import { randomBytes } from "node:crypto";
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
      icalToken: true,
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

/**
 * (Re)generates the opaque token that authenticates the personal iCal feed
 * (app/api/ical/[token]/feed.ics/route.ts) -- that route has no session to
 * check, since external calendar clients don't send cookies, so this
 * random value *is* the entire access control. 24 random bytes (192 bits)
 * as hex, not a UUID: astronomically infeasible to guess/brute-force, and
 * deliberately shaped differently from the cuid()-based entity ids used
 * everywhere else so it doesn't read as "just another id."
 * Regenerating overwrites the old value, which -- since it's a unique
 * lookup key, not a list -- implicitly and immediately invalidates any
 * previously issued feed URL.
 */
export async function regenerateIcalToken(userId: string): Promise<string> {
  const token = randomBytes(24).toString("hex");
  await prisma.user.update({ where: { id: userId }, data: { icalToken: token } });
  return token;
}

/** Used only by the unauthenticated iCal feed route -- looks a user up by their feed token instead of a session. */
export async function getUserByIcalToken(token: string) {
  return prisma.user.findUnique({
    where: { icalToken: token },
    select: { id: true, isPremium: true, timezone: true },
  });
}

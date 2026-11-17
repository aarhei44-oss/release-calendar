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

/** The one billing fact account deletion needs: is there a Stripe subscription that must be cancelled first. */
export async function getStripeSubscriptionId(userId: string): Promise<string | null> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { stripeSubscriptionId: true },
  });
  return user.stripeSubscriptionId;
}

// Everything that could still reach a user, switched off: alerts, digest,
// reminders, the Discord webhook, the iCal feed token, and Premium. The
// notification and feed code paths gate on exactly these fields, so clearing
// them is what makes an account inert there. Shared by deletion and ban.
const INERT_ACCOUNT_DATA = {
  active: false,
  emailAlertsEnabled: false,
  discordAlertsEnabled: false,
  discordWebhookUrl: null,
  digestEmailEnabled: false,
  leadTimeReminderDays: null,
  icalToken: null,
  isPremium: false,
  premiumOverride: false,
  stripeSubscriptionId: null,
  stripeSubscriptionStatus: "canceled",
} as const;

/**
 * First half of account deletion: makes the account completely inert and
 * stamps the date the nightly removal pass will erase it (see
 * lib/accountRemoval.ts). Everything that could still reach the user is shut
 * off in the same transaction -- sessions (signs them out everywhere), every
 * alert/digest/reminder setting and Discord webhook, the iCal feed token, and
 * premium -- so the notification and feed code paths, which gate on exactly
 * those fields, can't act on a deleted account during the grace period.
 * `active: false` is belt and braces: requireUser already refuses it.
 *
 * The Account rows (the Google link) are deliberately kept: sign-in finds the
 * user through them, which is how the signIn callback in app/auth.ts can
 * recognize a pending-deletion account and refuse it with a clear message
 * instead of a confusing OAuthAccountNotLinked error.
 */
export async function scheduleUserRemoval(userId: string, removalDate: Date) {
  await prisma.$transaction([
    prisma.session.deleteMany({ where: { userId } }),
    prisma.user.update({ where: { id: userId }, data: { ...INERT_ACCOUNT_DATA, removalDate } }),
  ]);
}

/**
 * Admin ban (lib/accountModeration.ts): the same "make the account inert"
 * treatment as deletion, plus the ban marker that sign-in and the nightly
 * removal pass key off.
 */
export async function banUser(userId: string) {
  await prisma.$transaction([
    prisma.session.deleteMany({ where: { userId } }),
    prisma.user.update({ where: { id: userId }, data: { ...INERT_ACCOUNT_DATA, bannedAt: new Date() } }),
  ]);
}

/**
 * Lifts a ban. The account comes back with deletion/ban's cleared settings
 * still cleared. If a deletion is also pending the account stays deactivated
 * (signing in is what cancels that, not an unban).
 */
export async function unbanUser(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { removalDate: true } });
  await prisma.user.update({ where: { id: userId }, data: { bannedAt: null, active: user.removalDate === null } });
}

/**
 * Undoes scheduleUserRemoval's marker: the account is live again. Only the
 * removal date and the `active` flag come back -- the alert settings, feed
 * token, and Premium were cleared when deletion was requested and stay
 * cleared, and the Stripe subscription stays cancelled.
 */
export async function cancelUserRemoval(userId: string) {
  // A banned account stays deactivated: cancelling its deletion must not
  // quietly lift the ban.
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { bannedAt: true } });
  await prisma.user.update({ where: { id: userId }, data: { removalDate: null, active: user.bannedAt === null } });
}

/**
 * Ids of every account whose grace period has ended, for the nightly removal
 * pass. Banned accounts are skipped on purpose: erasing the row would erase
 * the ban, letting the same email register again.
 */
export async function getUserIdsDueForRemoval(now: Date): Promise<string[]> {
  const users = await prisma.user.findMany({
    where: { removalDate: { lte: now }, bannedAt: null },
    select: { id: true },
  });
  return users.map((u) => u.id);
}

/**
 * Second half: permanently deletes the user. Every table that points at User
 * (accounts, sessions, subscriptions, comments, follows, notes, dismissals,
 * reactions) declares onDelete: Cascade, so this one statement removes all of
 * it. Adding a new user-owned table without a cascade would silently leave
 * that data behind, which is the promise this function exists to keep.
 */
export async function deleteUserAccount(userId: string) {
  await prisma.user.delete({ where: { id: userId } });
}

/** Used only by the unauthenticated iCal feed route -- looks a user up by their feed token instead of a session. */
export async function getUserByIcalToken(token: string) {
  return prisma.user.findUnique({
    where: { icalToken: token },
    select: { id: true, isPremium: true, timezone: true },
  });
}

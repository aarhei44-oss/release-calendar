"use server";

import { z } from "zod";
import {
  getProfile,
  updateTimezone as repoUpdateTimezone,
  updateEmailAlertsEnabled as repoUpdateEmailAlertsEnabled,
  updateDiscordWebhookUrl as repoUpdateDiscordWebhookUrl,
  updateDiscordAlertsEnabled as repoUpdateDiscordAlertsEnabled,
  updateDashboardCardIds as repoUpdateDashboardCardIds,
  updateDigestEmailEnabled as repoUpdateDigestEmailEnabled,
  updateDigestFrequency as repoUpdateDigestFrequency,
  updateLeadTimeReminderDays as repoUpdateLeadTimeReminderDays,
  regenerateIcalToken as repoRegenerateIcalToken,
  getStripeSubscriptionId,
  deleteUserAccount as repoDeleteUserAccount,
} from "@/data/profile/profileRepo";
import { cancelStripeSubscription } from "@/lib/stripe";
import { isValidDiscordWebhookUrl } from "@/lib/notifications/discord";
import { isDashboardCardId } from "@/app/dashboard/cards";
import { requireUser, requirePremium } from "@/lib/authGuards";
import { withActionLogging } from "@/lib/logger";

// Intl.supportedValuesOf("timeZone") on the server is the source of truth
// for what's a valid zone (see app/profile/page.tsx, which sends the same
// list to the client) -- this just guards against a tampered request rather
// than re-deriving the full list here.
const timezoneSchema = z
  .string()
  .min(1)
  .refine((value) => Intl.supportedValuesOf("timeZone").includes(value), { message: "Unknown timezone" })
  .nullable();

export async function getMyProfile() {
  return withActionLogging("profile.getMyProfile", async () => {
    const user = await requireUser();
    return getProfile(user.id);
  });
}

export async function updateTimezone(timezone: string | null) {
  return withActionLogging("profile.updateTimezone", async () => {
    const user = await requireUser();
    const parsed = timezoneSchema.parse(timezone);
    return repoUpdateTimezone(user.id, parsed);
  });
}

export async function updateEmailAlertsEnabled(enabled: boolean) {
  return withActionLogging("profile.updateEmailAlertsEnabled", async () => {
    const user = await requireUser();
    return repoUpdateEmailAlertsEnabled(user.id, z.boolean().parse(enabled));
  });
}

// Only Discord's own webhook URLs are accepted -- see
// lib/notifications/discord.ts's isValidDiscordWebhookUrl for why (this is
// a server-side POST target the user controls, not just a display string).
const discordWebhookUrlSchema = z
  .string()
  .min(1)
  .refine(isValidDiscordWebhookUrl, { message: "Must be a Discord webhook URL (https://discord.com/api/webhooks/...)" })
  .nullable();

export async function updateDiscordWebhookUrl(webhookUrl: string | null) {
  return withActionLogging("profile.updateDiscordWebhookUrl", async () => {
    const user = await requireUser();
    const parsed = discordWebhookUrlSchema.parse(webhookUrl);
    return repoUpdateDiscordWebhookUrl(user.id, parsed);
  });
}

export async function updateDiscordAlertsEnabled(enabled: boolean) {
  return withActionLogging("profile.updateDiscordAlertsEnabled", async () => {
    const user = await requireUser();
    return repoUpdateDiscordAlertsEnabled(user.id, z.boolean().parse(enabled));
  });
}

const dashboardCardIdsSchema = z
  .array(z.string().refine(isDashboardCardId, { message: "Unknown dashboard card id" }))
  .refine((ids) => new Set(ids).size === ids.length, { message: "Duplicate card id" })
  .nullable();

/** Premium-only: null resets to the default set/order (see DEFAULT_DASHBOARD_CARD_ORDER). */
export async function updateDashboardCardIds(cardIds: string[] | null) {
  return withActionLogging("profile.updateDashboardCardIds", async () => {
    const user = await requirePremium();
    const parsed = dashboardCardIdsSchema.parse(cardIds);
    return repoUpdateDashboardCardIds(user.id, parsed);
  });
}

export async function updateDigestEmailEnabled(enabled: boolean) {
  return withActionLogging("profile.updateDigestEmailEnabled", async () => {
    const user = await requirePremium();
    return repoUpdateDigestEmailEnabled(user.id, z.boolean().parse(enabled));
  });
}

const digestFrequencySchema = z.enum(["DAILY", "WEEKLY"]);

export async function updateDigestFrequency(frequency: "DAILY" | "WEEKLY") {
  return withActionLogging("profile.updateDigestFrequency", async () => {
    const user = await requirePremium();
    return repoUpdateDigestFrequency(user.id, digestFrequencySchema.parse(frequency));
  });
}

// null disables reminders; otherwise a whole number of days, capped at a
// year out (anything longer isn't a "lead time" reminder in any meaningful
// sense, and this schema stores it as a plain Int with no upper bound
// otherwise).
const leadTimeReminderDaysSchema = z.number().int().min(1).max(365).nullable();

export async function updateLeadTimeReminderDays(days: number | null) {
  return withActionLogging("profile.updateLeadTimeReminderDays", async () => {
    const user = await requirePremium();
    const parsed = leadTimeReminderDaysSchema.parse(days);
    return repoUpdateLeadTimeReminderDays(user.id, parsed);
  });
}

// The client makes the user type this too (DeleteAccountForm); checking it
// again here means a stray or scripted call to this action can't delete an
// account without the same deliberate confirmation.
const DELETE_CONFIRMATION = "DELETE";
const deleteConfirmationSchema = z.literal(DELETE_CONFIRMATION);

/**
 * Deletes the signed-in user's account and all data attached to it. A live
 * Stripe subscription is cancelled FIRST and the deletion aborts if that
 * fails -- the reverse order could leave someone still being billed with no
 * account to manage it from. Stripe's own customer/transaction records are
 * deliberately left alone (we only cancel the subscription): they're Stripe's
 * records, and the account-deletion copy tells users to take those up with
 * Stripe. The caller signs the browser out afterwards (the cascade already
 * removed the server-side session).
 */
export async function deleteMyAccount(confirmation: string): Promise<void> {
  return withActionLogging("profile.deleteMyAccount", async () => {
    const user = await requireUser();
    deleteConfirmationSchema.parse(confirmation);

    const subscriptionId = await getStripeSubscriptionId(user.id);
    if (subscriptionId) {
      await cancelStripeSubscription(subscriptionId);
    }

    await repoDeleteUserAccount(user.id);
  });
}

/** Also used for the first-ever "generate" -- see profileRepo.regenerateIcalToken. */
export async function regenerateIcalToken(): Promise<string> {
  return withActionLogging("profile.regenerateIcalToken", async () => {
    const user = await requirePremium();
    return repoRegenerateIcalToken(user.id);
  });
}

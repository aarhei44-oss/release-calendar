"use server";

import { z } from "zod";
import {
  getProfile,
  updateTimezone as repoUpdateTimezone,
  updateEmailAlertsEnabled as repoUpdateEmailAlertsEnabled,
  updateDiscordWebhookUrl as repoUpdateDiscordWebhookUrl,
  updateDiscordAlertsEnabled as repoUpdateDiscordAlertsEnabled,
  updateDashboardCardIds as repoUpdateDashboardCardIds,
} from "@/data/profile/profileRepo";
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

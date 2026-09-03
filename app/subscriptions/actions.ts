"use server";

import { z } from "zod";
import {
  subscribe as repoSubscribe,
  unsubscribe as repoUnsubscribe,
  listSubscriptions as repoListSubscriptions,
  getUpcomingForSubscriptions as repoGetUpcomingForSubscriptions,
} from "@/data/subscriptions/subscriptionsRepo";
import { stripPremiumImageUrls } from "@/app/calendar/eventDisplay";
import { requireUser } from "@/lib/authGuards";
import { withActionLogging } from "@/lib/logger";

const installIdSchema = z.string().min(1);

export async function subscribe(installId: string) {
  return withActionLogging("subscriptions.subscribe", async () => {
    const user = await requireUser();
    const parsed = installIdSchema.parse(installId);
    return repoSubscribe(user.id, parsed);
  });
}

export async function unsubscribe(installId: string) {
  return withActionLogging("subscriptions.unsubscribe", async () => {
    const user = await requireUser();
    const parsed = installIdSchema.parse(installId);
    return repoUnsubscribe(user.id, parsed);
  });
}

export async function getMySubscriptions() {
  return withActionLogging("subscriptions.getMySubscriptions", async () => {
    const user = await requireUser();
    return repoListSubscriptions(user.id);
  });
}

export async function getMySubscriptionsUpcoming() {
  return withActionLogging("subscriptions.getMySubscriptionsUpcoming", async () => {
    const user = await requireUser();
    const events = await repoGetUpcomingForSubscriptions(user.id, 30);
    return stripPremiumImageUrls(events, user.isPremium);
  });
}

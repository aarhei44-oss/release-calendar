"use server";

import { z } from "zod";
import {
  subscribe as repoSubscribe,
  unsubscribe as repoUnsubscribe,
  listSubscriptions as repoListSubscriptions,
  getUpcomingForSubscriptions as repoGetUpcomingForSubscriptions,
} from "@/data/subscriptions/subscriptionsRepo";
import { requireUser } from "@/lib/authGuards";

const installIdSchema = z.string().min(1);

export async function subscribe(installId: string) {
  const user = await requireUser();
  const parsed = installIdSchema.parse(installId);
  return repoSubscribe(user.id, parsed);
}

export async function unsubscribe(installId: string) {
  const user = await requireUser();
  const parsed = installIdSchema.parse(installId);
  return repoUnsubscribe(user.id, parsed);
}

export async function getMySubscriptions() {
  const user = await requireUser();
  return repoListSubscriptions(user.id);
}

export async function getMySubscriptionsUpcoming() {
  const user = await requireUser();
  return repoGetUpcomingForSubscriptions(user.id, 30);
}

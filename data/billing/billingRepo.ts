import { prisma } from "@/lib/prisma";

export async function findUserIdByStripeCustomerId(customerId: string): Promise<string | null> {
  const user = await prisma.user.findUnique({ where: { stripeCustomerId: customerId }, select: { id: true } });
  return user?.id ?? null;
}

export async function setStripeCustomerId(userId: string, stripeCustomerId: string) {
  return prisma.user.update({ where: { id: userId }, data: { stripeCustomerId } });
}

const ACTIVE_STATUSES = new Set(["active", "trialing"]);

/**
 * Called from the Stripe webhook on checkout completion and subscription
 * updates. isPremium is derived here, not passed in, so the webhook is the
 * single source of truth for what counts as "active" (see ACTIVE_STATUSES)
 * -- callers just report the raw Stripe subscription status.
 */
export async function syncSubscriptionFromStripe(
  userId: string,
  params: { subscriptionId: string; status: string; currentPeriodEnd: Date },
) {
  return prisma.user.update({
    where: { id: userId },
    data: {
      stripeSubscriptionId: params.subscriptionId,
      stripeSubscriptionStatus: params.status,
      premiumCurrentPeriodEnd: params.currentPeriodEnd,
      isPremium: ACTIVE_STATUSES.has(params.status),
    },
  });
}

/**
 * customer.subscription.deleted: revoke premium but keep stripeCustomerId
 * so a future resubscribe reuses the same Stripe customer instead of
 * creating a duplicate.
 */
export async function clearSubscription(userId: string) {
  return prisma.user.update({
    where: { id: userId },
    data: {
      isPremium: false,
      stripeSubscriptionStatus: "canceled",
    },
  });
}

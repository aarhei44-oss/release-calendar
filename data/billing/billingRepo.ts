import { prisma } from "@/lib/prisma";

/**
 * Stripe doesn't guarantee webhook delivery order. Callers use
 * stripeSubscriptionId to check a subscription.updated/deleted event's
 * payload still matches the user's *current* subscription before applying
 * it -- a delayed event for an already-superseded subscription (e.g. a
 * stale cancellation arriving after a resubscribe already recorded a new
 * subscription id) is stale, not authoritative, and would otherwise
 * silently revert a newer state.
 */
export async function findUserForStripeCustomerId(
  customerId: string,
): Promise<{ id: string; stripeSubscriptionId: string | null } | null> {
  return prisma.user.findUnique({
    where: { stripeCustomerId: customerId },
    select: { id: true, stripeSubscriptionId: true },
  });
}

export async function setStripeCustomerId(userId: string, stripeCustomerId: string) {
  return prisma.user.update({ where: { id: userId }, data: { stripeCustomerId } });
}

async function hasPremiumOverride(userId: string): Promise<boolean> {
  return (await prisma.user.findUnique({ where: { id: userId }, select: { premiumOverride: true } }))?.premiumOverride ?? false;
}

const ACTIVE_STATUSES = new Set(["active", "trialing"]);

/**
 * Called from the Stripe webhook on checkout completion and subscription
 * updates. isPremium is derived here, not passed in, so the webhook is the
 * single source of truth for what counts as "active" (see ACTIVE_STATUSES)
 * -- callers just report the raw Stripe subscription status.
 *
 * If the user currently has an admin-set premiumOverride, isPremium is left
 * alone (subscription id/status/period end still get recorded) so a routine
 * renewal or status-change webhook can't silently clobber an admin's manual
 * grant. Pass clearOverride when a fresh real checkout just completed --
 * that's an explicit signal real billing should take back over.
 */
export async function syncSubscriptionFromStripe(
  userId: string,
  params: { subscriptionId: string; status: string; currentPeriodEnd: Date },
  options: { clearOverride?: boolean } = {},
) {
  const overridden = options.clearOverride ? false : await hasPremiumOverride(userId);

  return prisma.user.update({
    where: { id: userId },
    data: {
      stripeSubscriptionId: params.subscriptionId,
      stripeSubscriptionStatus: params.status,
      premiumCurrentPeriodEnd: params.currentPeriodEnd,
      ...(options.clearOverride ? { premiumOverride: false } : {}),
      ...(overridden ? {} : { isPremium: ACTIVE_STATUSES.has(params.status) }),
    },
  });
}

/**
 * customer.subscription.deleted: revoke premium and clear the now-invalid
 * subscription id, but keep stripeCustomerId so a future resubscribe reuses
 * the same Stripe customer instead of creating a duplicate. Respects
 * premiumOverride the same way syncSubscriptionFromStripe does.
 */
export async function clearSubscription(userId: string) {
  const overridden = await hasPremiumOverride(userId);

  return prisma.user.update({
    where: { id: userId },
    data: {
      stripeSubscriptionId: null,
      stripeSubscriptionStatus: "canceled",
      ...(overridden ? {} : { isPremium: false }),
    },
  });
}

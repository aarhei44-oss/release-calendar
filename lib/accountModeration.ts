import { banUser, getStripeSubscriptionId, unbanUser } from "@/data/profile/profileRepo";
import { cancelStripeSubscription } from "@/lib/stripe";

/**
 * Bans an account. A live Stripe subscription is cancelled FIRST and the ban
 * aborts if that fails, for the same reason deletion does (see
 * requestAccountDeletion): the reverse order could leave a banned user still
 * being billed for a service they can no longer reach. No refund is issued
 * here -- that's a manual call in the Stripe Dashboard.
 *
 * The ban itself signs the user out everywhere, shuts off every alert and
 * Premium, hides their public comments, and blocks sign-in (app/auth.ts).
 */
export async function banAccount(userId: string): Promise<void> {
  const subscriptionId = await getStripeSubscriptionId(userId);
  if (subscriptionId) {
    await cancelStripeSubscription(subscriptionId);
  }
  await banUser(userId);
}

export async function unbanAccount(userId: string): Promise<void> {
  await unbanUser(userId);
}

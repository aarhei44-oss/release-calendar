import {
  deleteUserAccount,
  getStripeSubscriptionId,
  getUserIdsDueForRemoval,
  scheduleUserRemoval,
} from "@/data/profile/profileRepo";
import { cancelStripeSubscription } from "@/lib/stripe";
import { logEvent } from "@/lib/logger";

// The "erased within 30 days" in the Privacy Policy, Terms, profile deletion
// card and Premium page. Change those texts if this changes.
export const ACCOUNT_REMOVAL_GRACE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The date an account deleted at `now` gets permanently erased. */
export function removalDateFrom(now: Date = new Date()): Date {
  return new Date(now.getTime() + ACCOUNT_REMOVAL_GRACE_DAYS * DAY_MS);
}

/**
 * Starts the deletion of an account -- the user's own (app/profile/actions.ts)
 * or an admin's (app/admin/actions.ts), which must behave identically. A live
 * Stripe subscription is cancelled FIRST and the whole thing aborts if that
 * fails: the reverse order could leave someone still being billed with no
 * account to manage it from. Stripe's own customer/transaction records are
 * deliberately left alone -- they're Stripe's, and users are told to take
 * those up with Stripe. The account is then deactivated and scheduled for the
 * nightly erasure pass below.
 */
export async function requestAccountDeletion(userId: string): Promise<void> {
  const subscriptionId = await getStripeSubscriptionId(userId);
  if (subscriptionId) {
    await cancelStripeSubscription(subscriptionId);
  }
  await scheduleUserRemoval(userId, removalDateFrom());
}

export type AccountRemovalResult = { deleted: number; errors: number };

/**
 * Permanently deletes every account whose removalDate has passed, along with
 * everything attached to it (the schema cascades). Idempotent and
 * catch-up-safe by construction: it selects on `removalDate <= now`, so a
 * night the server was down is simply handled on the next run. Each user is
 * isolated in its own try/catch -- one failure shouldn't leave everyone else
 * past their promised date.
 */
export async function runAccountRemovalPass(now: Date = new Date()): Promise<AccountRemovalResult> {
  const result: AccountRemovalResult = { deleted: 0, errors: 0 };

  for (const userId of await getUserIdsDueForRemoval(now)) {
    try {
      await deleteUserAccount(userId);
      result.deleted += 1;
      logEvent({ action: "accountRemoval.deleted", outcome: "success", userId });
    } catch (error) {
      result.errors += 1;
      logEvent({
        action: "accountRemoval.deleted",
        outcome: "error",
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}

import Stripe from "stripe";

// Lazily built and cached: undefined = not yet resolved, null = STRIPE_SECRET_KEY
// isn't configured. Mirrors lib/notifications/email.ts's getTransporter -- Premium
// checkout must degrade to a clear "not configured" error rather than throwing on
// module load, since the app should still boot without Stripe set up.
let stripeClient: Stripe | null | undefined;

export function getStripeClient(): Stripe | null {
  if (stripeClient !== undefined) return stripeClient;

  const key = process.env.STRIPE_SECRET_KEY;
  stripeClient = key ? new Stripe(key) : null;
  return stripeClient;
}

export type PremiumPlan = "monthly" | "annual";

export function priceIdForPlan(plan: PremiumPlan): string | undefined {
  return plan === "monthly" ? process.env.STRIPE_PRICE_MONTHLY : process.env.STRIPE_PRICE_ANNUAL;
}

// Opt-in because Managed Payments (Stripe as merchant of record) has to be
// enabled on the Stripe account first -- Checkout rejects the parameter
// otherwise, which would break every Subscribe button. Set
// STRIPE_MANAGED_PAYMENTS=true only after enabling it in the Dashboard and
// giving the Premium product an eligible tax code.
export function isManagedPaymentsEnabled(): boolean {
  return process.env.STRIPE_MANAGED_PAYMENTS === "true";
}

/**
 * Cancels a subscription immediately, with no proration credit and no final
 * invoice -- used when a user deletes their account, so they can never be
 * billed again after their data is gone. A subscription Stripe no longer has,
 * or one that's already canceled, counts as success; anything else throws so
 * the caller can abort the deletion rather than orphan a live subscription.
 */
export async function cancelStripeSubscription(subscriptionId: string): Promise<void> {
  const stripe = getStripeClient();
  if (!stripe) {
    throw new Error("Stripe isn't configured, so the Premium subscription can't be cancelled.");
  }

  try {
    await stripe.subscriptions.cancel(subscriptionId, { prorate: false, invoice_now: false });
  } catch (error) {
    if (!(error instanceof Stripe.errors.StripeInvalidRequestError)) throw error;

    try {
      const existing = await stripe.subscriptions.retrieve(subscriptionId);
      if (existing.status === "canceled") return;
    } catch (retrieveError) {
      if (retrieveError instanceof Stripe.errors.StripeInvalidRequestError && retrieveError.code === "resource_missing") {
        return;
      }
    }
    throw error;
  }
}

// True only when checkout can actually succeed: a Stripe client plus both
// plan prices. Used to gate the /premium page's buttons so a signed-in user
// never sees a live "Subscribe" control that's guaranteed to error.
export function isCheckoutConfigured(): boolean {
  return getStripeClient() !== null && Boolean(process.env.STRIPE_PRICE_MONTHLY) && Boolean(process.env.STRIPE_PRICE_ANNUAL);
}

// Launch switch, separate from configuration on purpose: production already
// has live Stripe keys, so "configured" alone can't keep checkout closed.
// Default closed -- set PREMIUM_CHECKOUT_OPEN=true only once the Stripe-side
// setup (Managed Payments, tax code, prices) is finished. Enforced in the
// createCheckoutSession action itself, not just by hiding the buttons.
export function isCheckoutOpen(): boolean {
  return process.env.PREMIUM_CHECKOUT_OPEN === "true" && isCheckoutConfigured();
}

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

// True only when checkout can actually succeed: a Stripe client plus both
// plan prices. Used to gate the /premium page's buttons so a signed-in user
// never sees a live "Subscribe" control that's guaranteed to error.
export function isCheckoutConfigured(): boolean {
  return getStripeClient() !== null && Boolean(process.env.STRIPE_PRICE_MONTHLY) && Boolean(process.env.STRIPE_PRICE_ANNUAL);
}

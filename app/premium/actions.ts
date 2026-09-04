"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { requireUser } from "@/lib/authGuards";
import { getStripeClient, priceIdForPlan, type PremiumPlan } from "@/lib/stripe";
import { withActionLogging } from "@/lib/logger";

const planSchema = z.enum(["monthly", "annual"]);

function siteUrl(): string {
  return process.env.NEXTAUTH_URL ?? "http://localhost:3000";
}

export async function createCheckoutSession(plan: PremiumPlan) {
  // redirect() throws internally (NEXT_REDIRECT), so it must run outside
  // withActionLogging's try/catch -- otherwise every successful redirect
  // gets caught and logged as outcome:"error".
  const url = await withActionLogging("premium.createCheckoutSession", async () => {
    const user = await requireUser();
    const parsedPlan = planSchema.parse(plan);

    const stripe = getStripeClient();
    if (!stripe) {
      throw new Error("Checkout isn't configured yet -- STRIPE_SECRET_KEY is unset.");
    }

    const priceId = priceIdForPlan(parsedPlan);
    if (!priceId) {
      throw new Error(`Checkout isn't configured yet -- no Stripe price set for the ${parsedPlan} plan.`);
    }

    // No customer pre-creation: Checkout creates the Stripe Customer itself
    // during the session (customer_email) unless we already have one from a
    // prior subscription, in which case reuse it. The resulting customer id
    // is persisted from the webhook (checkout.session.completed), not here.
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      ...(user.stripeCustomerId ? { customer: user.stripeCustomerId } : { customer_email: user.email ?? undefined }),
      client_reference_id: user.id,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${siteUrl()}/premium?checkout=success`,
      cancel_url: `${siteUrl()}/premium?checkout=cancelled`,
    });

    if (!session.url) {
      throw new Error("Stripe did not return a Checkout URL.");
    }

    return session.url;
  });

  redirect(url);
}

export async function createPortalSession() {
  const url = await withActionLogging("premium.createPortalSession", async () => {
    const user = await requireUser();

    const stripe = getStripeClient();
    if (!stripe) {
      throw new Error("Billing isn't configured yet -- STRIPE_SECRET_KEY is unset.");
    }
    if (!user.stripeCustomerId) {
      throw new Error("No Stripe subscription found for this account yet.");
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripeCustomerId,
      return_url: `${siteUrl()}/premium`,
    });

    return session.url;
  });

  redirect(url);
}

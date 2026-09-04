import type Stripe from "stripe";
import { getStripeClient } from "@/lib/stripe";
import { logEvent } from "@/lib/logger";
import {
  findUserIdByStripeCustomerId,
  setStripeCustomerId,
  syncSubscriptionFromStripe,
  clearSubscription,
} from "@/data/billing/billingRepo";

// Route handlers never auto-parse the body, so request.text() below already
// gives us the raw bytes Stripe's signature verification needs -- no config
// opt-out (unlike the Pages Router's bodyParser: false) is required here.
export const runtime = "nodejs";

function toCustomerId(customer: string | Stripe.Customer | Stripe.DeletedCustomer | null): string | null {
  if (!customer) return null;
  return typeof customer === "string" ? customer : customer.id;
}

async function handleCheckoutCompleted(stripe: Stripe, session: Stripe.Checkout.Session) {
  const userId = session.client_reference_id;
  const customerId = toCustomerId(session.customer);
  const subscriptionId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id;

  if (!userId || !customerId || !subscriptionId) {
    logEvent({ action: "stripe.webhook.checkoutCompleted", outcome: "ignored", reason: "missing userId/customer/subscription" });
    return;
  }

  await setStripeCustomerId(userId, customerId);

  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  await syncSubscriptionFromStripe(userId, {
    subscriptionId: subscription.id,
    status: subscription.status,
    currentPeriodEnd: new Date(subscription.items.data[0].current_period_end * 1000),
  });

  logEvent({ action: "stripe.webhook.checkoutCompleted", outcome: "success", userId, subscriptionId });
}

async function handleSubscriptionUpdated(subscription: Stripe.Subscription) {
  const customerId = toCustomerId(subscription.customer);
  const userId = customerId ? await findUserIdByStripeCustomerId(customerId) : null;

  if (!userId) {
    logEvent({ action: "stripe.webhook.subscriptionUpdated", outcome: "ignored", reason: "no matching user", customerId });
    return;
  }

  await syncSubscriptionFromStripe(userId, {
    subscriptionId: subscription.id,
    status: subscription.status,
    currentPeriodEnd: new Date(subscription.items.data[0].current_period_end * 1000),
  });

  logEvent({ action: "stripe.webhook.subscriptionUpdated", outcome: "success", userId, status: subscription.status });
}

async function handleSubscriptionDeleted(subscription: Stripe.Subscription) {
  const customerId = toCustomerId(subscription.customer);
  const userId = customerId ? await findUserIdByStripeCustomerId(customerId) : null;

  if (!userId) {
    logEvent({ action: "stripe.webhook.subscriptionDeleted", outcome: "ignored", reason: "no matching user", customerId });
    return;
  }

  await clearSubscription(userId);
  logEvent({ action: "stripe.webhook.subscriptionDeleted", outcome: "success", userId });
}

export async function POST(request: Request) {
  const stripe = getStripeClient();
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!stripe || !webhookSecret) {
    logEvent({ action: "stripe.webhook", outcome: "skipped", reason: "Stripe not configured" });
    return new Response("ok", { status: 200 });
  }

  const signature = request.headers.get("stripe-signature");
  const rawBody = await request.text();

  let event: Stripe.Event;
  try {
    if (!signature) throw new Error("Missing stripe-signature header");
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (error) {
    logEvent({
      action: "stripe.webhook",
      outcome: "error",
      error: error instanceof Error ? error.message : String(error),
    });
    return new Response("Invalid signature", { status: 400 });
  }

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;
      if (session.mode === "subscription") {
        await handleCheckoutCompleted(stripe, session);
      }
      break;
    }
    case "customer.subscription.updated":
      await handleSubscriptionUpdated(event.data.object);
      break;
    case "customer.subscription.deleted":
      await handleSubscriptionDeleted(event.data.object);
      break;
    default:
      logEvent({ action: "stripe.webhook", outcome: "ignored", eventType: event.type });
  }

  return new Response("ok", { status: 200 });
}

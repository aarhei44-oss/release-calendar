import type Stripe from "stripe";
import { getStripeClient } from "@/lib/stripe";
import { logEvent } from "@/lib/logger";
import {
  findUserForStripeCustomerId,
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

// Stripe API versions moved current_period_end from the subscription itself
// onto its line items; null here means a shape we don't recognize, not a
// value to blindly index into.
function currentPeriodEnd(subscription: Stripe.Subscription): Date | null {
  const item = subscription.items.data[0];
  return item ? new Date(item.current_period_end * 1000) : null;
}

async function handleCheckoutCompleted(stripe: Stripe, session: Stripe.Checkout.Session) {
  const userId = session.client_reference_id;
  const customerId = toCustomerId(session.customer);
  const subscriptionId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id;

  if (!userId || !customerId || !subscriptionId) {
    logEvent({ action: "stripe.webhook.checkoutCompleted", outcome: "ignored", reason: "missing userId/customer/subscription" });
    return;
  }

  const [, subscription] = await Promise.all([
    setStripeCustomerId(userId, customerId),
    stripe.subscriptions.retrieve(subscriptionId),
  ]);
  const periodEnd = currentPeriodEnd(subscription);
  if (!periodEnd) {
    logEvent({ action: "stripe.webhook.checkoutCompleted", outcome: "error", reason: "subscription has no line items", subscriptionId });
    return;
  }

  await syncSubscriptionFromStripe(
    userId,
    {
      subscriptionId: subscription.id,
      status: subscription.status,
      currentPeriodEnd: periodEnd,
    },
    { clearOverride: true },
  );

  logEvent({ action: "stripe.webhook.checkoutCompleted", outcome: "success", userId, subscriptionId });
}

async function handleSubscriptionUpdated(subscription: Stripe.Subscription) {
  const customerId = toCustomerId(subscription.customer);
  const user = customerId ? await findUserForStripeCustomerId(customerId) : null;

  if (!user) {
    logEvent({ action: "stripe.webhook.subscriptionUpdated", outcome: "ignored", reason: "no matching user", customerId });
    return;
  }
  const userId = user.id;

  if (user.stripeSubscriptionId && user.stripeSubscriptionId !== subscription.id) {
    logEvent({
      action: "stripe.webhook.subscriptionUpdated",
      outcome: "ignored",
      reason: "stale event for a superseded subscription",
      userId,
      eventSubscriptionId: subscription.id,
      currentSubscriptionId: user.stripeSubscriptionId,
    });
    return;
  }

  const periodEnd = currentPeriodEnd(subscription);
  if (!periodEnd) {
    logEvent({
      action: "stripe.webhook.subscriptionUpdated",
      outcome: "error",
      reason: "subscription has no line items",
      subscriptionId: subscription.id,
    });
    return;
  }

  await syncSubscriptionFromStripe(userId, {
    subscriptionId: subscription.id,
    status: subscription.status,
    currentPeriodEnd: periodEnd,
  });

  logEvent({ action: "stripe.webhook.subscriptionUpdated", outcome: "success", userId, status: subscription.status });
}

async function handleSubscriptionDeleted(subscription: Stripe.Subscription) {
  const customerId = toCustomerId(subscription.customer);
  const user = customerId ? await findUserForStripeCustomerId(customerId) : null;

  if (!user) {
    logEvent({ action: "stripe.webhook.subscriptionDeleted", outcome: "ignored", reason: "no matching user", customerId });
    return;
  }

  if (user.stripeSubscriptionId && user.stripeSubscriptionId !== subscription.id) {
    logEvent({
      action: "stripe.webhook.subscriptionDeleted",
      outcome: "ignored",
      reason: "stale event for a superseded subscription",
      userId: user.id,
      eventSubscriptionId: subscription.id,
      currentSubscriptionId: user.stripeSubscriptionId,
    });
    return;
  }

  await clearSubscription(user.id);
  logEvent({ action: "stripe.webhook.subscriptionDeleted", outcome: "success", userId: user.id });
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

  try {
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
  } catch (error) {
    // Let Stripe retry: an uncaught throw here (e.g. a DB hiccup) is more
    // likely transient than the "empty line items" case above, which is
    // handled explicitly and returns 200 instead since retrying won't help.
    logEvent({
      action: "stripe.webhook",
      outcome: "error",
      eventType: event.type,
      error: error instanceof Error ? error.message : String(error),
    });
    return new Response("Webhook handler error", { status: 500 });
  }

  return new Response("ok", { status: 200 });
}

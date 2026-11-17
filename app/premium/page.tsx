import type { Metadata } from "next";
import { Check, Minus } from "lucide-react";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/auth";
import { SignInPrompt } from "@/components/SignInPrompt";
import { AdsenseAutoAds } from "@/components/AdsenseAutoAds";
import { isCheckoutOpen, isManagedPaymentsEnabled } from "@/lib/stripe";
import { PREMIUM_ANNUAL_CENTS, PREMIUM_MONTHLY_CENTS, annualSavings, formatUsd } from "@/lib/premiumPricing";
import { SUPPORT_EMAIL } from "@/lib/siteConfig";
import { createCheckoutSession, createPortalSession } from "./actions";

const MONTHLY = formatUsd(PREMIUM_MONTHLY_CENTS);
const ANNUAL = formatUsd(PREMIUM_ANNUAL_CENTS);

export const metadata: Metadata = {
  title: "Premium",
  description: "Compare anonymous, free, and Premium features on Release Watcher.",
};

const ROWS: { label: string; anonymous: boolean; free: boolean; premium: boolean }[] = [
  { label: "Browse the public calendar", anonymous: true, free: true, premium: true },
  { label: "View source-by-source date evidence", anonymous: true, free: true, premium: true },
  { label: "Subscribe to your games", anonymous: false, free: true, premium: true },
  { label: "Personalized dashboard", anonymous: false, free: true, premium: true },
  { label: "Calendar pre-filtered to your subscriptions", anonymous: false, free: true, premium: true },
  { label: "Immediate email alerts on subscribed-game changes", anonymous: false, free: true, premium: true },
  { label: "Discord webhook alerts", anonymous: false, free: true, premium: true },
  { label: "Ad-free browsing", anonymous: false, free: false, premium: true },
  { label: "Daily/weekly digest email", anonymous: false, free: false, premium: true },
  { label: "Configurable lead-time reminders", anonymous: false, free: false, premium: true },
  { label: "Personal calendar export (.ics feed)", anonymous: false, free: false, premium: true },
  {
    label: "One-click add to Google Calendar / Outlook (feed & per-event)",
    anonymous: false,
    free: false,
    premium: true,
  },
  { label: "Event-level follow & personal notes", anonymous: false, free: false, premium: true },
  { label: "Configurable dashboard cards", anonymous: false, free: false, premium: true },
  { label: "Official set marketing images", anonymous: false, free: false, premium: true },
];

function Mark({ on }: { on: boolean }) {
  return on ? (
    <Check className="mx-auto h-4 w-4 text-green-600 dark:text-green-400" aria-label="Included" />
  ) : (
    <Minus className="mx-auto h-4 w-4 text-gray-300 dark:text-gray-700" aria-label="Not included" />
  );
}

function FaqItem({ question, children }: { question: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-sm font-medium text-gray-800 dark:text-gray-200">{question}</dt>
      <dd className="text-sm leading-relaxed text-gray-600 dark:text-gray-400">{children}</dd>
    </div>
  );
}

// Sits directly under the subscribe buttons rather than only in /terms:
// consumer auto-renewal rules (FTC ROSCA and state laws) expect the price,
// the renewal cadence, and how to cancel next to the action that creates the
// obligation. Keep it accurate to what Checkout actually charges.
function RenewalNotice() {
  return (
    <p className="max-w-md text-xs leading-relaxed text-gray-500 dark:text-gray-500">
      Premium renews automatically at {MONTHLY} per month or {ANNUAL} per year until you cancel. Prices are in US
      dollars, before any applicable tax. Cancel anytime online from <strong>Manage subscription</strong> on this page
      &mdash; you keep Premium until the end of the period you&rsquo;ve paid for. By subscribing you agree to our{" "}
      <a href="/terms" className="underline">
        Terms
      </a>{" "}
      and{" "}
      <a href="/privacy" className="underline">
        Privacy Policy
      </a>
      .
    </p>
  );
}

// Shown in place of the subscribe buttons while PREMIUM_CHECKOUT_OPEN is off.
// Pricing stays visible everywhere else on the page on purpose -- showing
// what Premium will cost was the point of the original feedback.
function ComingSoonBanner() {
  return (
    <div
      role="status"
      className="flex max-w-md flex-col gap-1 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200"
    >
      <strong>Premium checkout is coming soon.</strong>
      <span>
        Premium will be {MONTHLY}/month or {ANNUAL}/year, plus applicable tax. You can use Release Watcher free in the
        meantime &mdash; you&rsquo;ll be able to upgrade right here as soon as checkout opens.
      </span>
    </div>
  );
}

export default async function PremiumPage() {
  const session = await getServerSession(authOptions);
  const checkoutOpen = isCheckoutOpen();
  const managedPayments = isManagedPaymentsEnabled();
  const savings = annualSavings();

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-10 px-4 py-16">
      <AdsenseAutoAds />
      <section className="flex flex-col items-center gap-3 text-center">
        <h1 className="text-3xl font-bold sm:text-4xl">Free vs. Premium</h1>
        <p className="max-w-xl text-gray-600 dark:text-gray-400">
          See what you get browsing anonymously, with a free account, and with Premium.
        </p>
      </section>

      <section className="overflow-x-auto">
        <table className="w-full min-w-[560px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-gray-200 dark:border-gray-800">
              <th className="py-3 text-left font-medium text-gray-500 dark:text-gray-400" />
              <th className="py-3 text-center font-medium text-gray-700 dark:text-gray-300">Anonymous</th>
              <th className="py-3 text-center font-medium text-gray-700 dark:text-gray-300">Free</th>
              <th className="py-3 text-center font-medium text-white dark:text-gray-900">
                <span className="rounded-md bg-gray-900 px-3 py-1 dark:bg-gray-100">Premium</span>
                <span className="mt-2 block text-xs font-normal text-gray-700 dark:text-gray-300">
                  {MONTHLY}/month
                  <br />
                  or {ANNUAL}/year
                </span>
                <span className="block text-xs font-normal text-gray-500 dark:text-gray-500">+ applicable tax</span>
                <span className="block text-xs font-normal text-green-700 dark:text-green-400">
                  Save {savings.percent}% annually
                </span>
              </th>
            </tr>
          </thead>
          <tbody>
            {ROWS.map((row) => (
              <tr key={row.label} className="border-b border-gray-100 dark:border-gray-900">
                <td className="py-3 pr-4 text-gray-700 dark:text-gray-300">{row.label}</td>
                <td className="py-3 text-center">
                  <Mark on={row.anonymous} />
                </td>
                <td className="py-3 text-center">
                  <Mark on={row.free} />
                </td>
                <td className="bg-gray-50 py-3 text-center dark:bg-gray-900/60">
                  <Mark on={row.premium} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="flex flex-col items-center gap-4 rounded-lg border border-gray-200 p-6 text-center dark:border-gray-800">
        {session?.user?.isPremium ? (
          <>
            <h2 className="text-lg font-semibold">You&apos;re on Premium</h2>
            <p className="max-w-md text-sm text-gray-600 dark:text-gray-400">
              {session.user.premiumCurrentPeriodEnd
                ? `Renews ${new Date(session.user.premiumCurrentPeriodEnd).toLocaleDateString()}.`
                : "Manage your plan, payment method, or cancel anytime."}
            </p>
            {session.user.stripeCustomerId ? (
              <form action={createPortalSession}>
                <button
                  type="submit"
                  className="rounded-md bg-gray-900 px-5 py-2.5 text-sm font-medium text-white dark:bg-gray-100 dark:text-gray-900"
                >
                  Manage subscription
                </button>
              </form>
            ) : (
              <p className="max-w-md text-sm text-gray-500 dark:text-gray-500">
                Your Premium access doesn&apos;t have a Stripe subscription attached to it -- contact support if you
                need to manage billing.
              </p>
            )}
          </>
        ) : session?.user ? (
          <>
            <h2 className="text-lg font-semibold">Go Premium</h2>
            {checkoutOpen ? (
              <>
                <p className="max-w-md text-sm text-gray-600 dark:text-gray-400">
                  Choose monthly or annual billing &mdash; annual saves {formatUsd(savings.cents)} ({savings.percent}%)
                  over twelve monthly payments.
                </p>
                <div className="flex flex-wrap justify-center gap-3">
                  <form action={createCheckoutSession.bind(null, "monthly")}>
                    <button
                      type="submit"
                      className="rounded-md bg-gray-900 px-5 py-2.5 text-sm font-medium text-white dark:bg-gray-100 dark:text-gray-900"
                    >
                      Subscribe monthly &mdash; {MONTHLY}/mo
                    </button>
                  </form>
                  <form action={createCheckoutSession.bind(null, "annual")}>
                    <button
                      type="submit"
                      className="rounded-md border border-gray-900 px-5 py-2.5 text-sm font-medium text-gray-900 dark:border-gray-100 dark:text-gray-100"
                    >
                      Subscribe annually &mdash; {ANNUAL}/yr
                    </button>
                  </form>
                </div>
                <RenewalNotice />
              </>
            ) : (
              <ComingSoonBanner />
            )}
          </>
        ) : checkoutOpen ? (
          <>
            <h2 className="text-lg font-semibold">Go Premium</h2>
            <p className="max-w-md text-sm text-gray-600 dark:text-gray-400">
              <strong>
                {MONTHLY}/month or {ANNUAL}/year
              </strong>{" "}
              plus applicable tax &mdash; annual saves {formatUsd(savings.cents)} ({savings.percent}%). Sign in with a
              free account to subscribe.
            </p>
            <RenewalNotice />
          </>
        ) : (
          <>
            <h2 className="text-lg font-semibold">Go Premium</h2>
            <ComingSoonBanner />
          </>
        )}
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold">Payments &amp; billing</h2>
        <dl className="flex flex-col gap-4">
          <FaqItem question="Is checkout secure?">
            Yes. Payments are processed by{" "}
            <a href="https://stripe.com" className="underline" target="_blank" rel="noopener noreferrer">
              Stripe
            </a>
            , a PCI DSS Level 1 certified payment provider &mdash; the highest level of payment-security certification.
            You enter your card on Stripe&rsquo;s own secure checkout page. Your card number never touches our servers,
            and we never see or store it.
          </FaqItem>
          {managedPayments && (
            <FaqItem question="Who am I buying from?">
              For new Premium subscriptions, Stripe acts as the merchant of record (through its Link service). Stripe
              calculates and collects any sales tax, VAT, or GST, sends your receipts and invoices, and handles
              payment support. Charges appear on your statement as <strong>LINK.COM* Release Watcher</strong>, and you
              can also view orders and manage your subscription at link.com.
            </FaqItem>
          )}
          <FaqItem question="What does it cost, and what about tax?">
            {MONTHLY} per month or {ANNUAL} per year, in US dollars. <strong>Prices don&rsquo;t include tax.</strong>{" "}
            Any applicable sales tax, VAT, or GST is always added on top of these prices &mdash; it&rsquo;s calculated at
            checkout from your billing address.
            {managedPayments ? " Stripe may show the total in your local currency." : ""}
          </FaqItem>
          <FaqItem question="What do you store about my payment?">
            Only your Stripe customer ID, your subscription ID and status, and your renewal date.
          </FaqItem>
          <FaqItem question="Can I cancel?">
            Yes, anytime, in a couple of clicks from <strong>Manage subscription</strong> on this page. You keep Premium
            through the end of the period you&rsquo;ve paid for and won&rsquo;t be charged again.
          </FaqItem>
          <FaqItem question="Refunds?">
            We don&rsquo;t refund unused time within a billing period, except where the law requires it
            {managedPayments ? " (Stripe may also issue refunds in some cases under its own policies)" : ""}. If you were
            charged in error, email{" "}
            <a href={`mailto:${SUPPORT_EMAIL}`} className="underline">
              {SUPPORT_EMAIL}
            </a>
            .
          </FaqItem>
          <FaqItem question="Will I get a receipt?">
            Yes &mdash; Stripe emails a receipt for every charge.
          </FaqItem>
          <FaqItem question="What if I delete my account?">
            Your subscription is cancelled immediately and you won&rsquo;t be billed again. You can delete your account
            from your{" "}
            <a href="/profile" className="underline">
              profile
            </a>
            .
          </FaqItem>
        </dl>
      </section>

      <section className="flex flex-col gap-4 rounded-lg border border-gray-200 p-6 dark:border-gray-800">
        <h2 className="text-lg font-semibold">Your data, our promises</h2>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          Release Watcher is run by one person, not a data company. Here&rsquo;s what that means for you:
        </p>
        <ul className="flex list-disc flex-col gap-2 pl-5 text-sm leading-relaxed text-gray-600 dark:text-gray-400">
          <li>
            <strong className="text-gray-800 dark:text-gray-200">We never sell your personal information.</strong> Not
            your email, name, subscriptions, notes, or anything else tied to your account.
          </li>
          <li>
            <strong className="text-gray-800 dark:text-gray-200">
              Your account data is never used for advertising.
            </strong>{" "}
            We don&rsquo;t share it with advertisers or data brokers, and we don&rsquo;t send marketing email &mdash; you
            only get the alerts and digests you turn on.
          </li>
          <li>
            <strong className="text-gray-800 dark:text-gray-200">Ads run separately from your account.</strong> Free
            visitors see ads from Google AdSense, which may use its own cookies in your browser; we don&rsquo;t hand
            Google your account data. Manage ad personalization at{" "}
            <a href="https://adssettings.google.com" className="underline" target="_blank" rel="noopener noreferrer">
              adssettings.google.com
            </a>
            . <strong>Premium has no ads</strong>, so no advertising code runs while you browse as a Premium member.
          </li>
          <li>
            <strong className="text-gray-800 dark:text-gray-200">Payments go straight to Stripe.</strong> We never see
            or store your card number.
          </li>
          <li>
            <strong className="text-gray-800 dark:text-gray-200">No password to leak.</strong> You sign in with
            Google, so we never hold a password for you. We receive only your email, name, and profile picture.
          </li>
          <li>
            <strong className="text-gray-800 dark:text-gray-200">Encrypted in transit.</strong> Everything on this
            site is served over HTTPS.
          </li>
          <li>
            <strong className="text-gray-800 dark:text-gray-200">You&rsquo;re in control.</strong> Delete your account
            and its data anytime from your{" "}
            <a href="/profile" className="underline">
              profile
            </a>
            , or email{" "}
            <a href={`mailto:${SUPPORT_EMAIL}`} className="underline">
              {SUPPORT_EMAIL}
            </a>{" "}
            to ask for a copy of your data.
          </li>
          <li>
            <strong className="text-gray-800 dark:text-gray-200">We&rsquo;ll tell you if that changes.</strong> If we
            ever change how we handle your data in a way that matters, we&rsquo;ll email you before it takes effect.
          </li>
        </ul>
        <p className="text-xs text-gray-500 dark:text-gray-500">
          No online service can promise perfect security. If a breach ever affects your data, we&rsquo;ll notify you as
          the law requires. Full details are in our{" "}
          <a href="/privacy" className="underline">
            Privacy Policy
          </a>
          .
        </p>
      </section>

      {!session?.user && (
        <SignInPrompt message="Sign in free to unlock subscriptions, alerts, and your personal dashboard." />
      )}
    </div>
  );
}

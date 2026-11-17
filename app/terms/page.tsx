import type { Metadata } from "next";
import { PREMIUM_ANNUAL_CENTS, PREMIUM_MONTHLY_CENTS, formatUsd } from "@/lib/premiumPricing";
import { SUPPORT_EMAIL } from "@/lib/siteConfig";

// Attorney-review-pending draft, not final legal advice. Section 6 assumes
// Stripe Managed Payments (Stripe as merchant of record) for new
// subscriptions -- see STRIPE_MANAGED_PAYMENTS in lib/stripe.ts -- and takes
// its prices from lib/premiumPricing.ts so they can't drift from the
// Premium page. Review with a licensed attorney before relying on it.

export const metadata: Metadata = {
  title: "Terms of Service",
  description: "The terms that govern your use of Release Watcher.",
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold">{title}</h2>
      <div className="flex flex-col gap-3 text-sm leading-relaxed text-gray-600 dark:text-gray-400">
        {children}
      </div>
    </section>
  );
}

export default function TermsOfServicePage() {
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-10 px-4 py-16">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-bold">Terms of Service</h1>
        <p className="text-sm text-gray-500 dark:text-gray-500">Last updated: November 16, 2026</p>
      </header>

      <Section title="1. Acceptance of Terms">
        <p>
          Release Watcher (&quot;the Service&quot;) is operated by Release Watcher, a sole proprietorship based in
          Washington State, USA (&quot;we,&quot; &quot;us&quot;). By creating an account or using the Service, you agree to these Terms. If you don&apos;t agree,
          please don&apos;t use the Service.
        </p>
      </Section>

      <Section title="2. Description of the Service">
        <p>
          Release Watcher aggregates trading-card-game product release dates from public, third-party sources
          (publisher sites, Wikipedia, and similar). Dates are provided for informational purposes only. They
          may be inaccurate, incomplete, delayed, or changed by the original publisher without notice, and we
          make no guarantee of accuracy. Don&apos;t rely on Release Watcher as your sole source for purchasing,
          pre-order, or other time-sensitive decisions.
        </p>
      </Section>

      <Section title="3. Accounts">
        <p>
          You sign in via Google. You must provide accurate account information and are responsible for
          activity that happens under your account. You must be at least 16 years old, or the age of legal
          digital consent in your jurisdiction if higher, to create an account.
        </p>
      </Section>

      <Section title="4. Acceptable Use">
        <p>You agree not to:</p>
        <ul className="list-disc pl-5">
          <li>Scrape, bulk-download, or programmatically access the Service outside normal browser use, without our written permission</li>
          <li>Interfere with or disrupt the Service or its infrastructure</li>
          <li>Use the Discord webhook or email alert features to send spam or abusive content</li>
          <li>Reverse engineer or attempt to extract the source code of the Service, except as permitted by law</li>
        </ul>
      </Section>

      <Section title="5. Your Content">
        <p>
          Personal notes, dashboard configuration, and similar content you create remain yours. You grant us a
          license to store and display that content back to you as part of operating the Service.
        </p>
      </Section>

      <Section title="6. Premium Subscriptions and Payment">
        <p>
          Premium unlocks the additional features described on our{" "}
          <a href="/premium" className="underline">
            Premium page
          </a>
          . By subscribing, you agree to the following:
        </p>
        <ul className="list-disc pl-5">
          <li>Premium costs {formatUsd(PREMIUM_MONTHLY_CENTS)} per month or {formatUsd(PREMIUM_ANNUAL_CENTS)} per year, in US dollars, plus any applicable sales tax, VAT, or GST, which is calculated at checkout from your billing address. Stripe may display the total in your local currency.</li>
          <li>Payments are processed by Stripe, Inc. and its affiliates (&quot;Stripe&quot;). For new Premium subscriptions, Stripe acts as the merchant of record: it is the seller of record for the payment, collects and remits applicable taxes, issues your receipts and invoices, and provides transaction-level payment support, including through its Link service. We never receive or store your full card details. Your use of Stripe&apos;s checkout and payment services is also subject to Stripe&apos;s own terms and privacy policy.</li>
          <li>Subscriptions automatically renew each billing period (monthly or annual, as selected at signup) until you cancel.</li>
          <li>You may cancel at any time from Manage subscription on the Premium page, or through Stripe&apos;s Link service. Cancellation takes effect at the end of the current paid billing period, and you keep Premium until then. We don&apos;t provide partial refunds for unused time within a period, except where required by applicable law. Stripe may, in certain cases and under its own policies (including any consumer cooling-off periods that apply to you), issue a refund; if it does, your Premium access may end.</li>
          <li>We may change Premium pricing with at least 30 days&apos; notice. Price changes apply to your next billing cycle, not one already in progress.</li>
          <li>Deleting your account cancels any active Premium subscription immediately. We don&apos;t refund the unused part of the current billing period.</li>
          <li>Any free trial terms will be disclosed to you at signup and are subject to these Terms.</li>
        </ul>
      </Section>

      <Section title="7. Disclaimers">
        <p>
          The Service is provided &quot;as is&quot; and &quot;as available,&quot; without warranties of any
          kind, express or implied, including accuracy, completeness, or uninterrupted availability of release
          date information. We are not responsible for losses arising from decisions made in reliance on data
          displayed by the Service.
        </p>
      </Section>

      <Section title="8. Limitation of Liability">
        <p>
          To the maximum extent permitted by law, our total liability arising from your use of the Service is
          limited to the amount you paid us in the 12 months before the claim, or $50 if you have not paid us
          anything.
        </p>
      </Section>

      <Section title="9. Termination">
        <p>
          We may suspend, ban, or terminate your account if you violate these Terms. A banned account cannot sign
          in, any active Premium subscription is cancelled, and we keep the account record (including its email
          address) so the ban can&apos;t be avoided by re-registering. You may delete your account at
          any time from your profile settings, which deactivates your account immediately, cancels any active
          Premium subscription, and permanently erases your account and its data within 30 days.
        </p>
      </Section>

      <Section title="10. Governing Law">
        <p>
          These Terms are governed by the laws of Washington State, USA, without regard to conflict-of-law
          principles. Any dispute will be brought in the state or federal courts located in Washington State.
        </p>
      </Section>

      <Section title="11. Changes to These Terms">
        <p>
          We may update these Terms from time to time. We&apos;ll update the &quot;Last updated&quot; date
          above when we do, and continued use of the Service after changes take effect means you accept them.
        </p>
      </Section>

      <Section title="12. Contact Us">
        <p>
          Questions about these Terms? Email{" "}
          <a href={`mailto:${SUPPORT_EMAIL}`} className="underline">
            {SUPPORT_EMAIL}
          </a>
          .
        </p>
      </Section>
    </div>
  );
}

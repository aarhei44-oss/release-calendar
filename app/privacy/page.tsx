import type { Metadata } from "next";
import { SUPPORT_EMAIL } from "@/lib/siteConfig";

// Attorney-review-pending draft, not final legal advice -- written from the
// actual data practices in prisma/schema.prisma (Google OAuth fields,
// Discord webhook URLs, Stripe billing identifiers) and the account-deletion
// flow in app/profile/actions.ts (deleteMyAccount). Premium billing text
// assumes Stripe Managed Payments (Stripe as merchant of record) for new
// subscriptions; see STRIPE_MANAGED_PAYMENTS in lib/stripe.ts. The 30-day
// backup sentence under "Data Retention" is a commitment that backup
// expiry must actually be built to honor. Review with a licensed attorney
// before relying on this for GDPR/CCPA compliance.

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: "How Release Watcher collects, uses, and protects your data.",
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

export default function PrivacyPolicyPage() {
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-10 px-4 py-16">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-bold">Privacy Policy</h1>
        <p className="text-sm text-gray-500 dark:text-gray-500">Last updated: November 16, 2026</p>
      </header>

      <Section title="Overview">
        <p>
          Release Watcher (&quot;we,&quot; &quot;us&quot;) is a sole proprietorship based in Washington State,
          USA. You can reach us at{" "}
          <a href={`mailto:${SUPPORT_EMAIL}`} className="underline">
            {SUPPORT_EMAIL}
          </a>
          . This policy explains what information we collect when you use
          releasewatcher.com, why we collect it, and the choices and rights you have over it.
        </p>
      </Section>

      <Section title="Information We Collect">
        <p>
          <strong className="text-gray-800 dark:text-gray-200">Account information.</strong> When you sign in
          with Google, we receive and store your email address, name, and profile picture URL.
        </p>
        <p>
          <strong className="text-gray-800 dark:text-gray-200">Preferences and usage data.</strong> Your game
          subscriptions, event follows, personal notes, dismissed events, dashboard layout, timezone, alert
          settings (email/Discord), digest frequency, and calendar-feed (iCal) token.
        </p>
        <p>
          <strong className="text-gray-800 dark:text-gray-200">Discord webhook URL.</strong> If you enable
          Discord alerts, we store the webhook URL you provide so we can send alert messages to it. We do not
          otherwise access your Discord account.
        </p>
        <p>
          <strong className="text-gray-800 dark:text-gray-200">Payment information (Premium).</strong> When you
          subscribe to Premium, payment is handled by Stripe, Inc. and its affiliates (&quot;Stripe&quot;), which
          acts as the merchant of record for new Premium subscriptions. You give your card or other payment
          details, name, billing address, and email directly to Stripe, which uses them under its own{" "}
          <a href="https://stripe.com/privacy" className="underline" target="_blank" rel="noopener noreferrer">
            Privacy Policy
          </a>
          . We never receive or store your card number. We retain only your Stripe customer ID, subscription ID,
          subscription status, and current billing-period end date.
        </p>
        <p>
          <strong className="text-gray-800 dark:text-gray-200">Cookies.</strong> An authentication cookie keeps
          you signed in. If you are shown ads (see &quot;Advertising&quot; below), Google may set advertising
          cookies.
        </p>
      </Section>

      <Section title="How We Use Information">
        <p>
          To provide the service (authenticate you, show your subscriptions and dashboard, send the alerts
          you&apos;ve opted into, and process Premium billing); to maintain and secure the service; and to
          communicate with you about your account when necessary.
        </p>
      </Section>

      <Section title="What We Don't Do">
        <ul className="list-disc pl-5">
          <li>We do not sell your personal information.</li>
          <li>
            We do not use your account data (email, name, subscriptions, notes, or settings) for advertising, and we
            do not share it with advertisers or data brokers.
          </li>
          <li>We do not send marketing email. You receive only the alerts and digests you turn on.</li>
        </ul>
        <p>
          Advertising cookies set by Google AdSense are placed by Google, not derived from your account data; see
          &quot;Advertising&quot; below for how to control them. Premium members see no ads, and no advertising code
          runs for them.
        </p>
      </Section>

      <Section title="Legal Bases for Processing (EEA/UK Users)">
        <p>
          We process account and usage data as necessary to perform our contract with you (providing the
          service you signed up for). We process advertising cookies and Premium payment data based on your
          consent and as necessary to perform the Premium subscription contract, respectively. You may
          withdraw consent at any time as described below.
        </p>
      </Section>

      <Section title="Advertising">
        <p>
          We show ads served by Google AdSense. Google and its partners may use cookies or similar
          technologies to serve ads based on your prior visits to this and other websites. If you are located
          in the EEA, UK, or Switzerland, you will be shown a consent message before any non-essential
          advertising cookies are set, and you can change your choice at any time. You can also opt out of
          personalized advertising generally at{" "}
          <a
            href="https://adssettings.google.com"
            className="underline"
            target="_blank"
            rel="noopener noreferrer"
          >
            adssettings.google.com
          </a>
          . See Google&apos;s own{" "}
          <a
            href="https://policies.google.com/privacy"
            className="underline"
            target="_blank"
            rel="noopener noreferrer"
          >
            Privacy Policy
          </a>{" "}
          for how it handles this data.
        </p>
      </Section>

      <Section title="Third-Party Service Providers">
        <ul className="list-disc pl-5">
          <li>Google — sign-in (authentication) and AdSense (advertising)</li>
          <li>Our email delivery provider — sends alert and digest emails you&apos;ve opted into</li>
          <li>Discord — only if you configure a webhook, to deliver the alerts you request</li>
          <li>Stripe — handles Premium payments and, for new subscriptions, acts as merchant of record; we never see your card details</li>
        </ul>
        <p>
          These providers process data only as needed to perform the functions above and are bound by their
          own privacy terms.
        </p>
      </Section>

      <Section title="Data Retention">
        <p>
          We retain your account and usage data for as long as your account is active. You can delete your
          account at any time from your profile settings. When you do, we immediately delete your account and
          everything attached to it from our live systems (including your subscriptions, notes, comments,
          follows, reactions, alert settings, and Google sign-in link), sign you out, and cancel any active
          Premium subscription. Copies in our backups are deleted or overwritten within 30 days.
        </p>
        <p>
          Payment records are held by Stripe, not by us, and are not removed when you delete your account. Stripe
          keeps them under its own retention practices and legal obligations (for example, tax and accounting
          law). To ask Stripe about or request deletion of that information, contact Stripe directly through its{" "}
          <a href="https://stripe.com/privacy" className="underline" target="_blank" rel="noopener noreferrer">
            Privacy Policy
          </a>
          .
        </p>
      </Section>

      <Section title="Your Rights">
        <p>
          Depending on where you live, you may have the right to access, correct, delete, or export your
          personal data, object to or restrict certain processing, and withdraw consent at any time. EEA/UK
          users also have the right to lodge a complaint with their local data protection authority. To
          exercise any of these rights, email us at{" "}
          <a href={`mailto:${SUPPORT_EMAIL}`} className="underline">
            {SUPPORT_EMAIL}
          </a>
          . You can also delete your account and all of your data directly from your{" "}
          <a href="/profile" className="underline">
            profile settings
          </a>
          .
        </p>
      </Section>

      <Section title="International Data Transfers">
        <p>
          We and our service providers (notably Google) may process data in countries outside your own,
          including the United States. Where required, these transfers rely on the safeguards our providers
          maintain under their own compliance programs (e.g., Standard Contractual Clauses).
        </p>
      </Section>

      <Section title="Children's Privacy">
        <p>
          Release Watcher is not directed to children, and we do not knowingly collect personal data from
          anyone under 16. If you believe a child has provided us data, contact us and we will delete it.
        </p>
      </Section>

      <Section title="Security">
        <p>
          We use reasonable technical and organizational measures to protect your data: all traffic to the site
          is encrypted with HTTPS, you sign in through Google so we never store a password, and card details go
          only to Stripe. No method of transmission or storage is 100% secure, and we cannot guarantee absolute
          security. If a breach affects your personal data, we will notify you and any regulators as required by
          law.
        </p>
      </Section>

      <Section title="Changes to This Policy">
        <p>
          We may update this policy from time to time. We&apos;ll update the &quot;Last updated&quot; date
          above when we do, and post material changes here.
        </p>
      </Section>

      <Section title="Contact Us">
        <p>
          Questions about this policy or your data? Email{" "}
          <a href={`mailto:${SUPPORT_EMAIL}`} className="underline">
            {SUPPORT_EMAIL}
          </a>
          .
        </p>
      </Section>
    </div>
  );
}

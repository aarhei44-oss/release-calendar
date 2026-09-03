import type { Metadata } from "next";

// Attorney-review-pending draft, not final legal advice -- written from the
// actual data practices in prisma/schema.prisma (Google OAuth fields,
// Discord webhook URLs, no payment processor wired up yet) plus the planned
// Stripe-based Premium checkout. Placeholders below (STRIPE_PROCESSOR_NAME)
// mark spots that need a real value once that integration exists. Review
// with a licensed attorney before relying on this for GDPR/CCPA compliance,
// especially once real payments start.

export const metadata: Metadata = {
  title: "Privacy Policy - Release Watcher",
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
        <p className="text-sm text-gray-500 dark:text-gray-500">Last updated: September 3, 2026</p>
      </header>

      <Section title="Overview">
        <p>
          Release Watcher (&quot;we,&quot; &quot;us&quot;) is operated by Aaron Hein, an individual based in
          Washington State, USA. This policy explains what information we collect when you use
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
          subscribe to Premium, billing is handled by our payment processor. We do not receive or store your
          full card number; we retain only your subscription status and a processor-assigned reference ID.
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
          <li>Our payment processor — handles Premium billing; we never see your full card details</li>
        </ul>
        <p>
          These providers process data only as needed to perform the functions above and are bound by their
          own privacy terms.
        </p>
      </Section>

      <Section title="Data Retention">
        <p>
          We retain your account and usage data for as long as your account is active. If you delete your
          account, we delete your personal data within 30 days, except where we must retain limited billing
          records to comply with tax or accounting law.
        </p>
      </Section>

      <Section title="Your Rights">
        <p>
          Depending on where you live, you may have the right to access, correct, delete, or export your
          personal data, object to or restrict certain processing, and withdraw consent at any time. EEA/UK
          users also have the right to lodge a complaint with their local data protection authority. To
          exercise any of these rights, email us at{" "}
          <a href="mailto:Kausemu44@gmail.com" className="underline">
            Kausemu44@gmail.com
          </a>
          . You can also delete most of your own data directly from your{" "}
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
          We use reasonable technical and organizational measures to protect your data, but no method of
          transmission or storage is 100% secure, and we cannot guarantee absolute security.
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
          <a href="mailto:Kausemu44@gmail.com" className="underline">
            Kausemu44@gmail.com
          </a>
          .
        </p>
      </Section>
    </div>
  );
}

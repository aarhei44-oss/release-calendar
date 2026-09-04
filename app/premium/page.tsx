import type { Metadata } from "next";
import { Check, Minus } from "lucide-react";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/auth";
import { SignInPrompt } from "@/components/SignInPrompt";

export const metadata: Metadata = {
  title: "Premium - Release Watcher",
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

export default async function PremiumPage() {
  const session = await getServerSession(authOptions);

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-10 px-4 py-16">
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
        <h2 className="text-lg font-semibold">Premium is coming soon</h2>
        <p className="max-w-md text-sm text-gray-600 dark:text-gray-400">
          Checkout isn&apos;t live yet -- this page shows what Premium will unlock once it launches.
        </p>
        <button
          type="button"
          disabled
          className="cursor-not-allowed rounded-md bg-gray-300 px-5 py-2.5 text-sm font-medium text-gray-500 dark:bg-gray-800 dark:text-gray-500"
        >
          Go Premium -- coming soon
        </button>
      </section>

      {!session?.user && (
        <SignInPrompt message="Sign in free to unlock subscriptions, alerts, and your personal dashboard." />
      )}
    </div>
  );
}

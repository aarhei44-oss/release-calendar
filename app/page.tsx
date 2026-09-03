import Link from "next/link";
import { getLandingStats } from "@/data/calendar/calendarRepo";

const STATUS_PIPELINE = [
  { label: "Rumored", className: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300" },
  { label: "Announced", className: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300" },
  { label: "Confirmed", className: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300" },
  { label: "Released", className: "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300" },
];

const FEATURES = [
  {
    title: "Cross-checked",
    body: "Every claim is weighed by source tier -- an official announcement outranks a forum post -- so contradictions get caught, not buried.",
  },
  {
    title: "Always fresh",
    body: "Sources are re-scanned daily, and releases automatically move from rumored to confirmed to released as new evidence comes in.",
  },
  {
    title: "Yours to filter",
    body: "Subscribe to the games you actually play and see only what matters to you.",
  },
];

export default async function Home() {
  // Degrades gracefully if the database is briefly unreachable -- the pitch
  // and CTAs below don't depend on it, only this one stat line does.
  const stats = await getLandingStats().catch(() => null);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-12 px-4 py-16">
      <section className="flex flex-col items-center gap-4 text-center">
        <h1 className="text-3xl font-bold sm:text-4xl">Never miss a TCG release again.</h1>
        <p className="max-w-xl text-gray-600 dark:text-gray-400">
          Release Watcher cross-checks release dates for Magic: The Gathering, Pokémon, One Piece, Disney
          Lorcana, Gundam, and Riftbound against official sources, retailers, and community trackers --
          so you see one confident answer, not five conflicting rumors.
        </p>
        {stats && (
          <p className="text-sm text-gray-500 dark:text-gray-500">
            Tracking {stats.releasesTracked} upcoming release{stats.releasesTracked === 1 ? "" : "s"} across{" "}
            {stats.gamesTracked} game{stats.gamesTracked === 1 ? "" : "s"}.
          </p>
        )}
        <div className="mt-2 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/calendar"
            className="rounded-md bg-gray-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-gray-700"
          >
            View the calendar
          </Link>
          <Link
            href="/subscriptions"
            className="rounded-md border border-gray-300 px-5 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            Track your games
          </Link>
        </div>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-center text-lg font-semibold">From rumor to shelf date, tracked every step</h2>
        <div className="flex flex-wrap items-center justify-center gap-2">
          {STATUS_PIPELINE.map((status, i) => (
            <div key={status.label} className="flex items-center gap-2">
              <span className={`rounded px-3 py-1 text-sm font-medium ${status.className}`}>{status.label}</span>
              {i < STATUS_PIPELINE.length - 1 && (
                <span className="text-gray-400" aria-hidden>
                  →
                </span>
              )}
            </div>
          ))}
        </div>
        <p className="text-center text-sm text-gray-500 dark:text-gray-400">
          Every date is backed by its sources, so you can see exactly why a status changed.
        </p>
      </section>

      <section className="grid gap-6 sm:grid-cols-3">
        {FEATURES.map((feature) => (
          <div key={feature.title} className="flex flex-col gap-1.5 rounded-lg border border-gray-200 p-4 dark:border-gray-800">
            <h3 className="font-medium">{feature.title}</h3>
            <p className="text-sm text-gray-600 dark:text-gray-400">{feature.body}</p>
          </div>
        ))}
      </section>
    </div>
  );
}

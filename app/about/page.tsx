import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "About - Release Watcher",
  description: "How Release Watcher tracks, weighs, and confirms trading-card-game release dates.",
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

const TIERS: { name: string; body: string }[] = [
  {
    name: "Official",
    body: "The publisher's own announcement -- a press release, a product page, an official social account. Weighted highest, and enough on its own to move an event to Confirmed.",
  },
  {
    name: "Retailer",
    body: "Listings from stores taking pre-orders. Retailers often get shelf dates before publishers confirm them publicly, but they also get them wrong or list placeholder dates -- so a single retailer listing moves the needle less than an official source.",
  },
  {
    name: "Community",
    body: "Established fan trackers and community wikis for each game. Useful for corroboration and for catching a date before it's officially confirmed, but not enough alone to override an official claim.",
  },
  {
    name: "Speculative",
    body: "Forum posts, rumor threads, and similar. Recorded so you can see what's being speculated, but weighted lowest and never enough by itself to confirm a date.",
  },
];

export default function AboutPage() {
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-10 px-4 py-16">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-bold">About Release Watcher</h1>
        <p className="text-sm text-gray-500 dark:text-gray-500">
          What this site does, and how it decides what to show you.
        </p>
      </header>

      <Section title="What this is">
        <p>
          Release Watcher tracks upcoming product releases for Magic: The Gathering, Pokémon, One Piece, Disney
          Lorcana, Gundam, Riftbound, and Yu-Gi-Oh. Release dates for trading card games are notoriously
          inconsistent between sources: a publisher&apos;s own site, retailer pre-order pages, and fan communities
          routinely disagree, and any one of them can be outdated or wrong. Instead of picking one source and
          hoping it&apos;s right, Release Watcher pulls from all of them, weighs each claim by how trustworthy that
          kind of source has historically been, and shows you one reconciled date -- along with the evidence
          behind it.
        </p>
      </Section>

      <Section title="Source tiers">
        <p>
          Every date we display is backed by one or more source claims. Each claim carries a tier reflecting
          how much weight it gets when we compute a release&apos;s confidence and status:
        </p>
        <dl className="flex flex-col gap-3">
          {TIERS.map((tier) => (
            <div key={tier.name}>
              <dt className="font-medium text-gray-800 dark:text-gray-200">{tier.name}</dt>
              <dd>{tier.body}</dd>
            </div>
          ))}
        </dl>
      </Section>

      <Section title="From rumor to shelf date">
        <p>
          Every tracked release moves through the same pipeline: <strong className="text-gray-800 dark:text-gray-200">Rumored</strong> (only
          speculative or single low-tier claims exist), <strong className="text-gray-800 dark:text-gray-200">Announced</strong> (a
          publisher or enough corroborating sources have named a window), <strong className="text-gray-800 dark:text-gray-200">Confirmed</strong> (an
          official source has given a firm date), and <strong className="text-gray-800 dark:text-gray-200">Released</strong> (the
          date has passed). Sources are re-scanned daily, so a release&apos;s status and date update automatically
          as new evidence comes in -- you never have to refresh a stale page to catch a change. Opening any
          event on the calendar shows the individual source claims behind its current date, not just the
          reconciled number.
        </p>
      </Section>

      <Section title="What we don't do">
        <p>
          We don&apos;t sell products, and we&apos;re not affiliated with any of the publishers whose releases we track.
          We don&apos;t guarantee accuracy -- see our{" "}
          <a href="/terms" className="underline">
            Terms of Service
          </a>{" "}
          for the full disclaimer -- and we&apos;d rather show you the disagreement between sources than paper over
          it with false confidence.
        </p>
      </Section>
    </div>
  );
}

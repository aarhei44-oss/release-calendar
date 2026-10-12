import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/auth";
import { getProductSetByGameAndSlug } from "@/data/calendar/calendarRepo";
import {
  formatEventDate,
  gateProductSetForViewer,
  groupSourceClaims,
  productTypeLabel,
  regionBadgeLabel,
  regionBadgeTitle,
  sourceLabel,
  statusBadgeClass,
  typeBadgeLabel,
} from "../../eventDisplay";
import { buildProductSetJsonLd } from "../../eventJsonLd";
import { serializeJsonLd } from "@/lib/jsonLd";
import { SITE_URL } from "@/lib/siteUrl";

type Props = {
  params: Promise<{ gameSlug: string; setSlug: string }>;
};

async function loadProductSet(gameSlug: string, setSlug: string) {
  return getProductSetByGameAndSlug(gameSlug, setSlug);
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { gameSlug, setSlug } = await params;
  const productSet = await loadProductSet(gameSlug, setSlug);
  if (!productSet) return {};

  const setName = productSet.name ?? productSet.code;
  const gameName = productSet.install.package.name;
  const title = `${setName} (${gameName}) Release Date`;
  const soonest = productSet.releaseEvents[0];
  // formatEventDate is typed against the full CalendarEvent shape (it's
  // normally called on a ReleaseEvent that already carries its own
  // productSet), but only ever reads the date columns at runtime --
  // reattaching productSet here (the real one, not a stand-in) satisfies
  // the type without changing any behavior.
  const description = soonest
    ? `${setName} for ${gameName} -- ${formatEventDate({ ...soonest, productSet })}. Status: ${soonest.status.toLowerCase()}. Cross-checked against official sources, retailers, and community trackers.`
    : `${setName} for ${gameName}, tracked by Release Watcher.`;
  const canonical = `/calendar/${gameSlug}/${setSlug}`;

  return {
    title,
    description,
    alternates: { canonical },
    openGraph: { title, description, url: canonical, siteName: "Release Watcher", type: "website" },
  };
}

export default async function ProductSetDetailPage({ params }: Props) {
  const { gameSlug, setSlug } = await params;
  const productSet = await loadProductSet(gameSlug, setSlug);
  if (!productSet) notFound();

  const session = await getServerSession(authOptions);
  const isPremium = session?.user?.isPremium ?? false;
  const isLoggedIn = !!session?.user;
  const gated = gateProductSetForViewer(productSet, { isPremium, isLoggedIn });

  const setName = productSet.name ?? productSet.code;
  const gameName = productSet.install.package.name;
  const productType = productTypeLabel(productSet.code, setName);
  const canonicalPath = `/calendar/${gameSlug}/${setSlug}`;
  // The reactions/comments/personalization/add-to-calendar tools all key on
  // one ReleaseEvent id, not a ProductSet -- the soonest event (events are
  // already date-ordered, see getProductSetByGameAndSlug) is the one worth
  // sending a reader into the interactive drawer for.
  const primaryEvent = productSet.releaseEvents[0];

  const jsonLd = buildProductSetJsonLd({
    setName,
    gameName,
    events: productSet.releaseEvents,
    detailUrl: `${SITE_URL}${canonicalPath}`,
    imageUrl: gated.imageUrl,
  });

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8 px-4 py-16">
      {jsonLd && (
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd(jsonLd) }} />
      )}

      <header className="flex flex-col gap-2">
        <p className="text-sm font-medium text-gray-500 dark:text-gray-500">
          <Link href={`/calendar/${gameSlug}`} className="hover:underline">
            {gameName}
          </Link>
        </p>
        <h1 className="text-3xl font-bold">
          {setName}
          {productType && <span className="text-gray-500 dark:text-gray-500"> ({productType})</span>}
        </h1>
        {gated.hasDescription && gated.description && (
          <p className="text-sm text-gray-600 dark:text-gray-400">{gated.description}</p>
        )}
        {!isLoggedIn && gated.hasDescription && (
          <p className="text-xs text-gray-500 dark:text-gray-500">
            <Link href="/about" className="underline">
              Sign in
            </Link>{" "}
            to read the full description.
          </p>
        )}
      </header>

      <section className="flex flex-col gap-4">
        {productSet.releaseEvents.map((event) => (
          <div key={event.id} className="flex flex-col gap-2 rounded-lg border border-gray-200 p-4 dark:border-gray-800">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                {typeBadgeLabel(event.type) && (
                  <span className="shrink-0 rounded bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600 dark:bg-gray-800 dark:text-gray-300">
                    {typeBadgeLabel(event.type)}
                  </span>
                )}
                {regionBadgeLabel(event.region) && (
                  <span
                    title={regionBadgeTitle(event.region)}
                    className="shrink-0 rounded bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600 dark:bg-gray-800 dark:text-gray-300"
                  >
                    {regionBadgeLabel(event.region)}
                  </span>
                )}
                <span className="font-medium text-gray-900 dark:text-gray-100">
                  {formatEventDate({ ...event, productSet })}
                </span>
              </div>
              <span className={`shrink-0 rounded px-2 py-0.5 text-xs font-medium ${statusBadgeClass(event.status)}`}>
                {event.status}
              </span>
            </div>

            {event.manualNotes && <p className="text-sm text-gray-600 dark:text-gray-400">{event.manualNotes}</p>}

            {event.sourceClaims.length > 0 && (
              <details className="text-sm">
                <summary className="cursor-pointer text-gray-500 dark:text-gray-500">
                  Source evidence ({groupSourceClaims(event.sourceClaims).length})
                </summary>
                <ul className="mt-2 flex flex-col gap-1.5">
                  {groupSourceClaims(event.sourceClaims).map((claim) => (
                    <li key={claim.id} className="text-gray-600 dark:text-gray-400">
                      <a href={claim.url} target="_blank" rel="noopener noreferrer" className="underline">
                        {sourceLabel(claim)}
                      </a>{" "}
                      -- {claim.disposition.toLowerCase()}, seen over {claim.days} day{claim.days === 1 ? "" : "s"}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        ))}
      </section>

      {primaryEvent && (
        <Link
          href={`/calendar?eventId=${primaryEvent.id}`}
          className="self-start rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 dark:bg-gray-100 dark:text-gray-900"
        >
          React, comment, or add this to your calendar
        </Link>
      )}
    </div>
  );
}

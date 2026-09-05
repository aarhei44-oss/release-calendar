import Link from "next/link";
import { ReviewQueue } from "./ReviewQueue";
import type { listContradictedEvents, listReviewQueue } from "./actions";

type Props = {
  events: Awaited<ReturnType<typeof listContradictedEvents>>;
  /** Gate-flagged items from the v2 ingest pipeline (ReviewItem rows), separate from v1's contradiction list below. */
  reviewQueue: Awaited<ReturnType<typeof listReviewQueue>>;
};

const DATE_FORMATTER = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });

function formatDate(date: Date | null): string {
  return date ? DATE_FORMATTER.format(date) : "unknown";
}

function currentBestDate(event: Props["events"][number]): string {
  switch (event.dateType) {
    case "EXACT":
      return formatDate(event.dateExact);
    case "RANGE":
      return `${formatDate(event.dateStart)} – ${formatDate(event.dateEnd)}`;
    case "WINDOW":
      return formatDate(event.windowStart);
    case "TBD":
      return "TBD";
  }
}

export function ReviewTab({ events, reviewQueue }: Props) {
  const highTierContradictions = (claims: Props["events"][number]["sourceClaims"]) =>
    claims.filter((c) => c.disposition === "CONTRADICTS" && (c.tier === "OFFICIAL" || c.tier === "RETAILER"));

  return (
    <div className="flex flex-col gap-6">
      {/*
        Two lists, kept apart on purpose. The queue above is the v2 ingest
        pipeline's own output -- ReviewItem rows the gate opened, each with a
        resolution that writes back. The list below is v1's derived view of
        high-tier contradictions, which has no state of its own. While both
        pipelines are live these answer different questions, and merging them
        would make it impossible to tell which pipeline flagged what.
      */}
      <section className="flex flex-col gap-3">
        <div>
          <h3 className="text-sm font-medium text-gray-700">Ingest review queue (v2)</h3>
          <p className="text-sm text-gray-600">
            Events the publish gate routed to a human: the sources disagree (CONFLICT) or the agreed date moved further
            than a release date plausibly moves unannounced (LARGE_SHIFT). Resolving an item closes it; accepting a
            claim also pins that date against future scans.
          </p>
        </div>
        <ReviewQueue items={reviewQueue} />
      </section>

      <section className="flex flex-col gap-4">
        <h3 className="text-sm font-medium text-gray-700">High-tier contradictions (v1 crawler)</h3>
        <p className="text-sm text-gray-600">
        Events with a high-tier (official or retailer) source claim that contradicts the current
        best-known date. Confidence already discounts for this, but it&apos;s worth a human look --
        it may mean the date changed, or the low-tier claims currently winning are wrong.
      </p>

      {events.length === 0 ? (
        <p className="text-sm text-gray-500">No contradicted events right now.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {events.map((event) => (
            <li key={event.id} className="rounded-md border border-gray-200 p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <span className="font-medium">{event.productSet.name ?? "(unnamed set)"}</span>{" "}
                  <span className="text-gray-500">
                    · {event.productSet.install.package.name} · {event.type}
                  </span>
                </div>
                <Link href={`/calendar?eventId=${event.id}`} className="text-xs text-blue-600 hover:underline">
                  View in calendar
                </Link>
              </div>

              <p className="mt-1 text-gray-700">
                Current: <span className="font-medium">{event.status}</span> ·{" "}
                {Math.round(event.confidence * 100)}% confidence · {currentBestDate(event)}
              </p>

              <ul className="mt-2 flex flex-col gap-1">
                {highTierContradictions(event.sourceClaims).map((claim) => (
                  <li key={claim.id} className="rounded bg-red-50 px-2 py-1 text-xs text-red-800">
                    <span className="font-medium">{claim.tier}</span> contradicts via{" "}
                    <a href={claim.url} target="_blank" rel="noopener noreferrer" className="underline">
                      {claim.host ?? claim.url}
                    </a>
                    {claim.lastVerifiedAt && <> (verified {formatDate(claim.lastVerifiedAt)})</>}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
      </section>
    </div>
  );
}

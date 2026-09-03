import Link from "next/link";
import type { listContradictedEvents } from "./actions";

type Props = {
  events: Awaited<ReturnType<typeof listContradictedEvents>>;
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

export function ReviewTab({ events }: Props) {
  const highTierContradictions = (claims: Props["events"][number]["sourceClaims"]) =>
    claims.filter((c) => c.disposition === "CONTRADICTS" && (c.tier === "OFFICIAL" || c.tier === "RETAILER"));

  return (
    <div className="flex flex-col gap-4">
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
    </div>
  );
}

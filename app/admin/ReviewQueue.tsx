"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { resolveReviewItem, type listReviewQueue } from "./actions";

type ReviewQueue = Awaited<ReturnType<typeof listReviewQueue>>;
type ReviewItem = ReviewQueue[number];
type Claim = ReviewItem["claims"][number];

const DATE_FORMATTER = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
const STAMP_FORMATTER = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

const REASON_COPY: Record<string, string> = {
  CONFLICT: "Two qualifying sources disagree about the date by more than the agreement window (gate rule G5).",
  LARGE_SHIFT: "The agreed date moved further than a release date plausibly moves unannounced (gate rule G6).",
  NEW_UNCORROBORATED: "A new date with nothing corroborating it.",
  ANOMALY: "Something the gate could not classify.",
};

const TIER_STYLES: Record<string, string> = {
  OFFICIAL: "bg-green-100 text-green-800",
  RETAILER: "bg-blue-100 text-blue-800",
  COMMUNITY: "bg-gray-100 text-gray-700",
  SPECULATIVE: "bg-amber-100 text-amber-900",
};

/** Renders a stored SerializedDate. Mirrors lib/ingest/types.ts's shapes exactly -- no interpretation, no rounding. */
function formatSerializedDate(date: Claim["date"] | null): string {
  if (!date) return "no date";
  switch (date.kind) {
    case "EXACT":
      return DATE_FORMATTER.format(new Date(date.date));
    case "RANGE":
      return `${DATE_FORMATTER.format(new Date(date.start))} – ${DATE_FORMATTER.format(new Date(date.end))}`;
    case "WINDOW":
      return `${date.granularity} window from ${DATE_FORMATTER.format(new Date(date.start))}`;
    case "TBD":
      return "TBD";
  }
}

function formatCurrentDate(date: ReviewItem["currentDate"]): string {
  if (!date) return "no date published";
  switch (date.kind) {
    case "EXACT":
      return DATE_FORMATTER.format(new Date(date.date));
    case "RANGE":
      return `${DATE_FORMATTER.format(new Date(date.start))} – ${DATE_FORMATTER.format(new Date(date.end))}`;
    case "WINDOW":
      return `${date.granularity} window from ${DATE_FORMATTER.format(new Date(date.start))}`;
    case "TBD":
      return "TBD";
  }
}

/**
 * The review queue: gate-flagged events waiting on a human.
 *
 * Two deliberate restraints in here.
 *
 * First, `summary` is rendered only when it is non-null, and it is null for
 * every row today (it is reserved for a future automated reviewer). Nothing
 * synthesizes a stand-in sentence -- what gets shown instead is the raw claim
 * comparison the gate actually stored, because a plausible-sounding invented
 * summary of a date conflict is exactly the sort of thing a curator would act
 * on without re-reading the claims.
 *
 * Second, "accept" is the only action that writes to the event, and the UI
 * says out loud that it pins the date (isManualOverride) -- because that is a
 * decision with a consequence beyond this queue: the crawler will stop moving
 * that date, including when the date later turns out to be wrong.
 */
export function ReviewQueue({ items }: { items: ReviewQueue }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});

  function resolve(itemId: string, resolution: Parameters<typeof resolveReviewItem>[1], label: string) {
    setMessage(null);
    startTransition(async () => {
      try {
        await resolveReviewItem(itemId, resolution);
        setMessage(`${label} — review item resolved.`);
        router.refresh();
      } catch (e) {
        setMessage(e instanceof Error ? e.message : "Could not resolve that item.");
      }
    });
  }

  if (items.length === 0) {
    return <p className="text-sm text-gray-500">Nothing in the ingest review queue.</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      {message && (
        <p className="text-sm text-gray-600" role="status">
          {message}
        </p>
      )}

      {items.map((item) => {
        const note = notes[item.id] ?? "";
        return (
          <div key={item.id} className="rounded-md border border-gray-200 p-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <span className="mr-2 rounded bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-900">
                  {item.reason}
                </span>
                <span className="font-medium">{item.productSetName ?? "(unnamed set)"}</span>
                {item.productSetCode && <span className="text-gray-500"> [{item.productSetCode}]</span>}{" "}
                <span className="text-gray-500">
                  · {item.gameName} · {item.eventType} · {item.eventRegion}
                </span>
              </div>
              <Link href={`/calendar?eventId=${item.eventId}`} className="text-xs text-blue-600 hover:underline">
                View in calendar
              </Link>
            </div>

            <p className="mt-1 text-xs text-gray-500">
              Opened {STAMP_FORMATTER.format(new Date(item.createdAt))} · {REASON_COPY[item.reason] ?? "Flagged by the gate."}
            </p>

            {item.summary ? (
              <p className="mt-2 rounded bg-gray-50 p-2 text-gray-800">{item.summary}</p>
            ) : (
              <p className="mt-2 text-xs italic text-gray-500">
                No written summary (the automated reviewer that would write one is not built yet) — the competing claims
                are shown in full below.
              </p>
            )}

            <p className="mt-2 text-gray-700">
              Currently showing: <span className="font-medium">{formatCurrentDate(item.currentDate)}</span> ·{" "}
              {item.eventStatus}
              {item.isManualOverride && (
                <span className="ml-2 rounded bg-blue-100 px-1.5 py-0.5 text-xs font-medium text-blue-800">
                  manually pinned
                </span>
              )}
              {item.gapDays !== null && (
                <span className="ml-2 text-gray-500">largest disagreement: {Math.round(item.gapDays)} day(s)</span>
              )}
            </p>

            <table className="mt-2 w-full text-left text-xs">
              <caption className="sr-only">Competing claims for this event</caption>
              <thead>
                <tr className="border-b border-gray-200 uppercase text-gray-500">
                  <th className="py-1">Origin</th>
                  <th>Tier</th>
                  <th>Date claimed</th>
                  <th>Runs</th>
                  <th>Seen this run</th>
                  <th>Last seen</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {item.claims.map((claim) => (
                  <tr key={`${item.id}-${claim.index}`} className="border-b border-gray-100">
                    <td className="py-1 font-medium">{claim.origin}</td>
                    <td>
                      <span
                        className={`rounded px-1.5 py-0.5 font-medium ${TIER_STYLES[claim.tier] ?? "bg-gray-100 text-gray-700"}`}
                      >
                        {claim.tier}
                      </span>
                    </td>
                    <td>{formatSerializedDate(claim.date)}</td>
                    <td>{claim.consecutiveRuns}</td>
                    <td>{claim.seenInCurrentRun ? "yes" : "no"}</td>
                    <td>
                      {claim.url ? (
                        <a href={claim.url} target="_blank" rel="noopener noreferrer" className="underline">
                          {STAMP_FORMATTER.format(new Date(claim.lastSeenAt))}
                        </a>
                      ) : (
                        STAMP_FORMATTER.format(new Date(claim.lastSeenAt))
                      )}
                    </td>
                    <td>
                      <button
                        type="button"
                        disabled={isPending}
                        onClick={() =>
                          resolve(
                            item.id,
                            { kind: "accept", claimIndex: claim.index, note: note || undefined },
                            `Accepted ${claim.origin}'s date and pinned the event`,
                          )
                        }
                        title="Writes this date onto the event and sets isManualOverride, so no later scan moves it."
                        className="rounded-md border border-gray-300 px-2 py-1 hover:bg-gray-100 disabled:opacity-50"
                      >
                        Accept this date
                      </button>
                    </td>
                  </tr>
                ))}
                {item.claims.length === 0 && (
                  <tr>
                    <td colSpan={7} className="py-2 text-gray-500">
                      This item stored no claim detail.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>

            <div className="mt-2 flex flex-wrap items-center gap-2">
              <label className="sr-only" htmlFor={`note-${item.id}`}>
                Resolution note
              </label>
              <input
                id={`note-${item.id}`}
                type="text"
                value={note}
                onChange={(e) => setNotes({ ...notes, [item.id]: e.target.value })}
                placeholder="Optional note (stored on the item as resolvedNote)"
                className="min-w-64 flex-1 rounded-md border border-gray-300 px-2 py-1 text-xs"
              />
              <button
                type="button"
                disabled={isPending}
                onClick={() => resolve(item.id, { kind: "keep", note: note || undefined }, "Kept the current date")}
                title="Closes the item without changing the event. The crawler stays free to move the date later."
                className="rounded-md border border-gray-300 px-2 py-1 text-xs hover:bg-gray-100 disabled:opacity-50"
              >
                Keep current value
              </button>
              <button
                type="button"
                disabled={isPending}
                onClick={() => resolve(item.id, { kind: "dismiss", note: note || undefined }, "Dismissed")}
                title="Closes the item as not worth acting on. The event is untouched."
                className="rounded-md border border-gray-300 px-2 py-1 text-xs hover:bg-gray-100 disabled:opacity-50"
              >
                Dismiss
              </button>
            </div>

            <p className="mt-1 text-xs text-gray-500">
              &ldquo;Accept&rdquo; pins the date (sets <code>isManualOverride</code>) so a later scan cannot silently undo
              it. &ldquo;Keep&rdquo; and &ldquo;Dismiss&rdquo; close the item and leave the event exactly as it is.
            </p>
          </div>
        );
      })}
    </div>
  );
}

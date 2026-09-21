import type { ReleaseEventType, ReleaseStatus } from "@/app/generated/prisma/client";
import * as ingestRepo from "@/data/ingest/ingestRepo";
import { logEvent } from "@/lib/logger";
import { isPastDate } from "./types";

/**
 * The release lifecycle pass: an event whose date is over is RELEASED.
 *
 * Nothing in v2 did this. The v1 crawler had a lifecycle pass; it was deleted
 * with the rest of `lib/crawler/` at the cutover and gate.ts's own G7 comment
 * ("the release lifecycle pass owns the past-dated case") still points at it.
 * The gap was measured on 2026-09-20: 81 of 161 live events were dated in the
 * past, and every one of them was still CONFIRMED, ANNOUNCED or RUMORED --
 * "Marvel Super Heroes: Confirmed, June 26" on a calendar read in September.
 * A status that says a shipped product is still upcoming is a wrong fact, and it
 * also broke everything keyed on status: the "Released" filter matched nothing,
 * and the upcoming-count query (calendarRepo) counted shipped sets as upcoming.
 *
 * ## What qualifies
 *
 * ANNOUNCED and CONFIRMED events with an EXACT or RANGE date whose last day is
 * over (types.ts's isPastDate). Deliberately not:
 *
 *  - RUMORED. Nothing ever endorsed that date, so its passing is no evidence the
 *    product shipped -- it may equally have slipped or been dropped, which is
 *    exactly the case a human should look at rather than a pass papering over.
 *  - CANCELLED. Cancellation is a stronger, later statement than a date passing.
 *  - WINDOW and TBD dates, which never named a day (see isPastDate).
 *  - Manual overrides. A person pinned that event; this pass does not overrule.
 *
 * The gate cooperates from its side: an event already RELEASED that keeps being
 * restated at the same past date stays RELEASED (gate.ts's PUBLISH branch), and
 * one whose date moves back into the future stops being released, so this pass
 * is one-directional and can never fight it.
 */

/** How recently an event must have crossed its date for followers to be told. */
export const RELEASE_NOTIFY_WINDOW_DAYS = 3;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type ReleaseLifecycleDeps = Pick<typeof ingestRepo, "getReleaseLifecycleCandidates" | "markEventsReleased">;

export type ReleasedEvent = {
  id: string;
  type: ReleaseEventType;
  statusBefore: ReleaseStatus;
  /**
   * Whether the date passed recently enough to be news. The first run after this
   * pass shipped marked months of history at once, and the same is true of any
   * install that was paused for a while; telling every follower that a June set
   * "is now released" in September would be noise presented as an alert.
   */
  recent: boolean;
};

export type ReleaseLifecycleResult = {
  released: ReleasedEvent[];
  errors: number;
};

export async function runReleaseLifecycle(
  params: { installIds: string[]; now: Date },
  deps: ReleaseLifecycleDeps = ingestRepo,
): Promise<ReleaseLifecycleResult> {
  const { installIds, now } = params;
  const result: ReleaseLifecycleResult = { released: [], errors: 0 };
  if (installIds.length === 0) return result;

  try {
    const candidates = await deps.getReleaseLifecycleCandidates(installIds);
    const due = candidates.filter((event) => isPastDate(event.date, now));
    if (due.length === 0) return result;

    await deps.markEventsReleased(due.map((event) => event.id));

    for (const event of due) {
      const lastDay =
        event.date?.kind === "EXACT" ? event.date.date : event.date?.kind === "RANGE" ? event.date.end : null;
      result.released.push({
        id: event.id,
        type: event.type,
        statusBefore: event.status,
        recent: lastDay !== null && now.getTime() - (lastDay.getTime() + MS_PER_DAY) < RELEASE_NOTIFY_WINDOW_DAYS * MS_PER_DAY,
      });
    }
  } catch (error) {
    // Housekeeping, like the derivation pass: a failure here leaves statuses a
    // day stale and must not fail a run that produced good dates.
    result.errors += 1;
    logEvent({
      action: "ingest.releaseLifecycle",
      outcome: "error",
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return result;
}

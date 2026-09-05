import * as crawlerRepo from "@/data/crawler/crawlerRepo";
import { FORWARD_WINDOW_DAYS } from "@/lib/ingest/providers/shared";
import { withActionLogging } from "@/lib/logger";

export type RetentionCleanupResult = { eventsDeleted: number; productSetsPurged: number };

/** How long past its date an event is kept before the purge takes it. */
export const RETENTION_DAYS = 30;

/**
 * The purge cutoff, in days, never falling inside the ingest forward window.
 *
 * This is the one rule that keeps "delete unconditionally" from rebuilding v1's
 * churn loop. Retention deletes an event permanently -- including, by an
 * accepted decision, events carrying follows, notes, dismissals and reactions --
 * so the *only* thing that stops the next scan re-creating what the last one
 * deleted is that no provider will still be offering the row.
 *
 * Providers drop any candidate dated more than FORWARD_WINDOW_DAYS in the past
 * (lib/ingest/providers/shared.ts's isWithinForwardWindow), so an event deleted
 * at or beyond that age cannot come back: the row that would re-create it is
 * filtered out at parse time, before it is ever a Candidate. Delete anything
 * *newer* than the window and the two passes fight -- purge, re-ingest, purge
 * again, every night, which is precisely v1's measured 3,196-created /
 * 3,173-deleted loop and the reason it looked like an abusive scrape from
 * upstream.
 *
 * Stated as a floor rather than as one constant so the two numbers can move
 * independently in the safe direction: keeping events longer than the window is
 * always fine, keeping them for less than it never is.
 */
export function retentionCutoffDays(olderThanDays: number = RETENTION_DAYS): number {
  return Math.max(olderThanDays, FORWARD_WINDOW_DAYS);
}

/**
 * Permanently deletes ReleaseEvents more than `olderThanDays` past their
 * date (merged-away duplicates included -- see deleteOldEvents) and
 * ProductSets that have sat archived that long, to keep the live dataset
 * lean. Real deletes, not an archive: once an event ages out here it's
 * gone for good, unlike the merge-undo archival elsewhere in this module.
 * Runs at the end of every scan (see orchestrate.ts) and is also
 * admin-triggerable, same as dedupPass.ts's runDedupPass.
 *
 * `excludeEventIds` (orchestrate.ts only) skips a same-scan set of ids
 * outright, regardless of how far past their date they are -- specifically
 * events whose dateless TBD placeholder was just resolved to a real date
 * moments earlier in this same scan. Without it, a decades-old product
 * whose date only just became known (e.g. a bare-year historical date, see
 * dateParsing.ts) would be purged in the very same scan that discovered
 * it, before ever being visible.
 *
 * `olderThanDays` is a request, not the last word, for the *event* purge: see
 * retentionCutoffDays, which floors it at the ingest forward window so a purged
 * past event cannot be re-created by the next run. The ProductSet purge takes it
 * unchanged -- that one measures time since a merge, not distance from a release
 * date, so the forward window says nothing about it.
 */
export async function runRetentionCleanupPass(
  params: { installIds?: string[]; olderThanDays?: number; excludeEventIds?: string[] } = {},
): Promise<RetentionCleanupResult> {
  return withActionLogging("crawler.runRetentionCleanupPass", async () => {
    const eventsDeleted = await crawlerRepo.deleteOldEvents(
      params.installIds,
      retentionCutoffDays(params.olderThanDays),
      params.excludeEventIds,
    );
    const productSetsPurged = await crawlerRepo.deleteStaleArchivedProductSets(
      params.installIds,
      params.olderThanDays,
    );
    return { eventsDeleted, productSetsPurged };
  });
}

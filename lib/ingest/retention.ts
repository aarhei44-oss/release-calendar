import * as ingestRepo from "@/data/ingest/ingestRepo";
import { FORWARD_WINDOW_DAYS } from "@/lib/ingest/providers/shared";
import { withActionLogging } from "@/lib/logger";

/**
 * v2's retention/purge pass. Moved here from lib/crawler/retention.ts at the
 * v1 cutover -- despite living under lib/crawler, this was never v1-specific:
 * its cutoff logic is built directly around v2's FORWARD_WINDOW_DAYS, and
 * nothing in lib/ingest/orchestrate.ts's executeIngest calls it
 * automatically, so the admin System tab's "Trigger retention cleanup"
 * button (data/admin/adminRepo.ts's triggerRescan-adjacent wiring) is the
 * only way this ever runs.
 */

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
 * date and ProductSets that have sat archived that long, to keep the live
 * dataset lean. Real deletes, not an archive: once an event ages out here
 * it's gone for good. Admin-triggerable from the System tab; nothing calls
 * it automatically today.
 *
 * `excludeEventIds` skips a same-run set of ids outright, regardless of how
 * far past their date they are -- for a caller that just resolved some
 * dateless placeholder to a real (possibly decades-old) date and doesn't
 * want retention to purge it in the same breath it was discovered.
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
  return withActionLogging("ingest.runRetentionCleanupPass", async () => {
    const eventsDeleted = await ingestRepo.deleteOldEvents(
      params.installIds,
      retentionCutoffDays(params.olderThanDays),
      params.excludeEventIds,
    );
    const productSetsPurged = await ingestRepo.deleteStaleArchivedProductSets(
      params.installIds,
      params.olderThanDays,
    );
    return { eventsDeleted, productSetsPurged };
  });
}

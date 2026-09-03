import * as crawlerRepo from "@/data/crawler/crawlerRepo";
import { withActionLogging } from "@/lib/logger";

export type RetentionCleanupResult = { eventsDeleted: number; productSetsPurged: number };

/**
 * Permanently deletes ReleaseEvents more than `olderThanDays` past their
 * date (merged-away duplicates included -- see deleteOldEvents) and
 * ProductSets that have sat archived that long, to keep the live dataset
 * lean. Real deletes, not an archive: once an event ages out here it's
 * gone for good, unlike the merge-undo archival elsewhere in this module.
 * Runs at the end of every scan (see orchestrate.ts) and is also
 * admin-triggerable, same as dedupPass.ts's runDedupPass.
 */
export async function runRetentionCleanupPass(
  params: { installIds?: string[]; olderThanDays?: number } = {},
): Promise<RetentionCleanupResult> {
  return withActionLogging("crawler.runRetentionCleanupPass", async () => {
    const eventsDeleted = await crawlerRepo.deleteOldEvents(params.installIds, params.olderThanDays);
    const productSetsPurged = await crawlerRepo.deleteStaleArchivedProductSets(
      params.installIds,
      params.olderThanDays,
    );
    return { eventsDeleted, productSetsPurged };
  });
}

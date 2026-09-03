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
 *
 * `excludeEventIds` (orchestrate.ts only) skips a same-scan set of ids
 * outright, regardless of how far past their date they are -- specifically
 * events whose dateless TBD placeholder was just resolved to a real date
 * moments earlier in this same scan. Without it, a decades-old product
 * whose date only just became known (e.g. a bare-year historical date, see
 * dateParsing.ts) would be purged in the very same scan that discovered
 * it, before ever being visible.
 */
export async function runRetentionCleanupPass(
  params: { installIds?: string[]; olderThanDays?: number; excludeEventIds?: string[] } = {},
): Promise<RetentionCleanupResult> {
  return withActionLogging("crawler.runRetentionCleanupPass", async () => {
    const eventsDeleted = await crawlerRepo.deleteOldEvents(
      params.installIds,
      params.olderThanDays,
      params.excludeEventIds,
    );
    const productSetsPurged = await crawlerRepo.deleteStaleArchivedProductSets(
      params.installIds,
      params.olderThanDays,
    );
    return { eventsDeleted, productSetsPurged };
  });
}

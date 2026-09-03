import * as crawlerRepo from "@/data/crawler/crawlerRepo";
import { withActionLogging } from "@/lib/logger";
import { computeConfidenceAndStatus } from "./confidence";

export type UndoProductSetMergeResult = { restoredProductSetId: string; movedEventIds: string[] };
export type UndoReleaseEventMergeResult = { restoredEventId: string; recomputedEventIds: string[] };

/** Reverses a ProductSet merge (see crawlerRepo.mergeProductSets/undoProductSetMerge). ProductSet has no derived confidence/status, so there's nothing to recompute afterward. */
export async function undoProductSetMergeAndRecompute(duplicateId: string): Promise<UndoProductSetMergeResult> {
  return withActionLogging("crawler.undoProductSetMerge", async () => {
    const { movedEventIds } = await crawlerRepo.undoProductSetMerge(duplicateId);
    return { restoredProductSetId: duplicateId, movedEventIds };
  });
}

/**
 * Reverses a ReleaseEvent merge (see crawlerRepo.mergeReleaseEvents/
 * undoReleaseEventMerge), then recomputes confidence/status for the
 * restored event and every event that actually lost claims/notes to it --
 * not just "the primary," since a chain of merges since the original one
 * may mean that's no longer a single fixed id.
 */
export async function undoReleaseEventMergeAndRecompute(duplicateId: string): Promise<UndoReleaseEventMergeResult> {
  return withActionLogging("crawler.undoReleaseEventMerge", async () => {
    const { affectedEventIds } = await crawlerRepo.undoReleaseEventMerge(duplicateId);

    for (const eventId of [duplicateId, ...affectedEventIds]) {
      const claims = await crawlerRepo.getClaimsForEvent(eventId);
      const { confidence, status } = computeConfidenceAndStatus(claims);
      await crawlerRepo.updateEventFromClaims(eventId, { confidence, status });
    }

    return { restoredEventId: duplicateId, recomputedEventIds: affectedEventIds };
  });
}

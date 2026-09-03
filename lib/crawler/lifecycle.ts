import * as crawlerRepo from "@/data/crawler/crawlerRepo";
import { withActionLogging } from "@/lib/logger";

export type ReleaseLifecycleResult = { eventsReleased: number; releasedEventIds: string[] };

/**
 * Transitions ReleaseEvents whose date has passed to RELEASED, independent
 * of any new crawler claims. Without this, an event that reaches CONFIRMED
 * and then never gets touched again (its source stops mentioning it once
 * the set is out) would sit at CONFIRMED forever. Runs at the end of every
 * scan (see orchestrate.ts) -- which already re-fetches every enabled
 * install's sources on a schedule regardless of whether anything changed --
 * and is also admin-triggerable (UC-14-style manual pass), same as
 * dedupPass.ts's runDedupPass.
 */
export async function runReleaseLifecyclePass(
  params: { installIds?: string[] } = {},
): Promise<ReleaseLifecycleResult> {
  return withActionLogging("crawler.runReleaseLifecyclePass", async () => {
    const { count, eventIds } = await crawlerRepo.releasePastDueEvents(params.installIds);
    return { eventsReleased: count, releasedEventIds: eventIds };
  });
}

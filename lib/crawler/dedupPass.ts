import * as crawlerRepo from "@/data/crawler/crawlerRepo";
import { withActionLogging } from "@/lib/logger";
import { computeConfidenceAndStatus } from "./confidence";
import { findMatchingEvent } from "./dedup";

export type DedupPassResult = { groupsChecked: number; eventsMerged: number };

/**
 * Admin-triggered cleanup pass (UC-14) over *existing* events -- distinct
 * from the crawler's own live dedup, which only prevents new duplicates
 * from being created during a scan. This reconciles anything that slipped
 * through before, e.g. from data entered before this logic existed.
 *
 * Conservative on purpose: it only ever merges claims/comments from a
 * duplicate onto a survivor and deletes the duplicate. It never rewrites
 * the survivor's own date fields, so a dedup pass can't silently change an
 * event's displayed date.
 */
export async function runDedupPass(): Promise<DedupPassResult> {
  return withActionLogging("crawler.runDedupPass", async () => {
    const events = await crawlerRepo.getAllReleaseEventsForDedup();

    const groups = new Map<string, typeof events>();
    for (const event of events) {
      const key = `${event.productSetId}:${event.type}`;
      const list = groups.get(key);
      if (list) list.push(event);
      else groups.set(key, [event]);
    }

    let eventsMerged = 0;

    for (const group of groups.values()) {
      if (group.length < 2) continue;

      const primary = group.find((e) => e.isManualOverride) ?? group[0];
      let primaryClaimsChanged = false;

      for (const candidate of group) {
        if (candidate.id === primary.id) continue;
        const match = findMatchingEvent(candidate, [primary]);
        if (!match) continue;

        await crawlerRepo.mergeReleaseEvents(primary.id, candidate.id);
        eventsMerged += 1;
        primaryClaimsChanged = true;
      }

      if (primaryClaimsChanged) {
        const claims = await crawlerRepo.getClaimsForEvent(primary.id);
        const { confidence, status } = computeConfidenceAndStatus(claims);
        await crawlerRepo.updateEventFromClaims(primary.id, { confidence, status });
      }
    }

    return { groupsChecked: groups.size, eventsMerged };
  });
}

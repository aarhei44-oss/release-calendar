import * as crawlerRepo from "@/data/crawler/crawlerRepo";
import { withActionLogging } from "@/lib/logger";
import { computeConfidenceAndStatus } from "./confidence";
import { findMatchingEvent, isMatchableNormalizedName, normalizeProductSetName } from "./dedup";

export type DedupPassResult = { groupsChecked: number; eventsMerged: number; productSetsMerged: number };

/**
 * Admin-triggered cleanup pass (UC-14) over *existing* events -- distinct
 * from the crawler's own live dedup, which only prevents new duplicates
 * from being created during a scan. This reconciles anything that slipped
 * through before, e.g. from data entered before this logic existed. Also
 * invoked automatically at the end of every crawler scan (see
 * orchestrate.ts), scoped to just the installs that were scanned.
 *
 * Conservative on purpose: it only ever merges claims/comments from a
 * duplicate onto a survivor and deletes the duplicate. It never rewrites
 * the survivor's own date fields, so a dedup pass can't silently change an
 * event's displayed date.
 */
export async function runDedupPass(params: { installIds?: string[] } = {}): Promise<DedupPassResult> {
  return withActionLogging("crawler.runDedupPass", async () => {
    // Phase 0: merge ProductSets within the same install whose names are
    // identical after normalization -- different sources format the same
    // real product's name differently (e.g. a trailing set-code suffix or
    // capitalization), so exact-code identity alone misses these. Kept to
    // exact-normalized-match only (no fuzzy similarity/prefix-stripping):
    // this runs automatically after every scan, so it must never risk
    // silently combining two genuinely different products.
    const productSets = await crawlerRepo.getProductSetsForFuzzyMerge(params.installIds);
    const bySetKey = new Map<string, typeof productSets>();
    for (const ps of productSets) {
      if (!ps.name) continue;
      const normalized = normalizeProductSetName(ps.name);
      if (!isMatchableNormalizedName(normalized)) continue;
      const key = `${ps.tcgProfileInstallId}:${normalized}`;
      const list = bySetKey.get(key);
      if (list) list.push(ps);
      else bySetKey.set(key, [ps]);
    }

    let productSetsMerged = 0;
    for (const group of bySetKey.values()) {
      if (group.length < 2) continue;
      const [primary, ...duplicates] = group; // already sorted by createdAt asc
      for (const duplicate of duplicates) {
        await crawlerRepo.mergeProductSets(primary.id, duplicate.id);
        productSetsMerged += 1;
      }
    }

    // Phase 1: existing event-level dedup, now also covering any events a
    // Phase 0 merge just brought onto the same ProductSet.
    const events = await crawlerRepo.getAllReleaseEventsForDedup(params.installIds);

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

    return { groupsChecked: groups.size, eventsMerged, productSetsMerged };
  });
}

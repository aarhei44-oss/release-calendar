import * as crawlerRepo from "@/data/crawler/crawlerRepo";
import { withActionLogging } from "@/lib/logger";
import { computeConfidenceAndStatus } from "./confidence";
import {
  findMatchingEvent,
  isFuzzyProductSetNameMatch,
  isMatchableNormalizedName,
  normalizeProductSetName,
} from "./dedup";

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
 * duplicate onto a survivor and archives the duplicate (soft-delete --
 * undoable via lib/crawler/mergeUndo.ts, until retention eventually purges
 * it). It never rewrites the survivor's own date fields, so a dedup pass
 * can't silently change an event's displayed date.
 */
export async function runDedupPass(params: { installIds?: string[] } = {}): Promise<DedupPassResult> {
  return withActionLogging("crawler.runDedupPass", async () => {
    // Phase 0: merge ProductSets within the same install whose names are
    // identical after normalization -- different sources format the same
    // real product's name differently (e.g. a trailing set-code suffix or
    // capitalization), so exact-code identity alone misses these. Exact
    // match only, checked before the fuzzy pass below, so a same-normalized
    // group's earliest member is always the fuzzy pass's candidate too.
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

    // Phase 0b: fuzzy-match the ProductSets that survived Phase 0 (i.e.
    // weren't identical after normalization) but are still very likely the
    // same real product under looser cross-source naming -- see dedup.ts's
    // productSetNameSimilarity for exactly what this does and doesn't catch
    // (e.g. it reconciles lorcana.gg's "Set 1: The First Chapter" against
    // Wikipedia's "The First Chapter", but not a set code folded into a
    // name with no shared words). Scoped to the same install and same
    // "earliest survives" rule as Phase 0.
    const survivorsByInstall = new Map<string, { id: string; name: string; createdAt: Date }[]>();
    for (const group of bySetKey.values()) {
      const survivor = group[0];
      if (!survivor.name) continue;
      const entry = { id: survivor.id, name: survivor.name, createdAt: survivor.createdAt };
      const list = survivorsByInstall.get(survivor.tcgProfileInstallId);
      if (list) list.push(entry);
      else survivorsByInstall.set(survivor.tcgProfileInstallId, [entry]);
    }

    for (const survivors of survivorsByInstall.values()) {
      const sorted = [...survivors].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      const mergedAway = new Set<string>();
      for (let i = 0; i < sorted.length; i++) {
        const primary = sorted[i];
        if (mergedAway.has(primary.id)) continue;
        for (let j = i + 1; j < sorted.length; j++) {
          const candidate = sorted[j];
          if (mergedAway.has(candidate.id)) continue;
          if (!isFuzzyProductSetNameMatch(primary.name, candidate.name)) continue;
          await crawlerRepo.mergeProductSets(primary.id, candidate.id);
          mergedAway.add(candidate.id);
          productSetsMerged += 1;
        }
      }
    }

    // Phase 1: existing event-level dedup, now also covering any events a
    // Phase 0/0b merge just brought onto the same ProductSet.
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

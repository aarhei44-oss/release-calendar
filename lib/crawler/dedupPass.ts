import * as crawlerRepo from "@/data/crawler/crawlerRepo";
import { withActionLogging } from "@/lib/logger";
import { computeConfidenceAndStatus } from "./confidence";
import {
  findMatchingEvent,
  isFuzzyProductSetNameMatch,
  isMatchableNormalizedName,
  normalizeProductSetName,
  significantTokenSet,
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

      // Bucket by shared significant token instead of comparing every pair
      // -- see significantTokenSet's docstring for why this is safe (drops
      // zero true matches). `candidatePairs` collects each (i, j) with i<j
      // at most once even if the pair shares several tokens, then they're
      // visited in the same (i, then j) order the old nested loop used, so
      // "the earliest unmerged entry always survives as primary" still
      // holds exactly as before.
      const byToken = new Map<string, number[]>();
      sorted.forEach((entry, idx) => {
        for (const token of significantTokenSet(entry.name)) {
          const list = byToken.get(token);
          if (list) list.push(idx);
          else byToken.set(token, [idx]);
        }
      });

      const candidatePairs = new Set<number>();
      for (const indices of byToken.values()) {
        for (let a = 0; a < indices.length; a++) {
          for (let b = a + 1; b < indices.length; b++) {
            candidatePairs.add(indices[a] * sorted.length + indices[b]);
          }
        }
      }

      const sortedPairs = [...candidatePairs].sort((a, b) => a - b);
      for (const key of sortedPairs) {
        const i = Math.floor(key / sorted.length);
        const j = key % sorted.length;
        const primary = sorted[i];
        const candidate = sorted[j];
        if (mergedAway.has(primary.id) || mergedAway.has(candidate.id)) continue;
        if (!isFuzzyProductSetNameMatch(primary.name, candidate.name)) continue;
        await crawlerRepo.mergeProductSets(primary.id, candidate.id);
        mergedAway.add(candidate.id);
        productSetsMerged += 1;
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

      // Match each candidate against every survivor kept so far, not just
      // the group's single primary -- mirrors the live-scan matching in
      // orchestrate.ts (findMatchingEvent against `existingEvents`, plural).
      // A single-`[primary]` comparison misses real duplicates whenever the
      // primary itself doesn't semantically match anything (e.g. it's a
      // dateless TBD placeholder): two later WINDOW-dated candidates with an
      // identical date range would each individually fail to match that
      // primary and never get compared against each other, leaving both
      // stranded as separate events.
      const primary = group.find((e) => e.isManualOverride) ?? group[0];
      const survivors = [primary];
      const affectedIds = new Set<string>();

      for (const candidate of group) {
        if (candidate.id === primary.id) continue;
        const match = findMatchingEvent(candidate, survivors);
        if (!match) {
          survivors.push(candidate);
          continue;
        }

        await crawlerRepo.mergeReleaseEvents(match.id, candidate.id);
        eventsMerged += 1;
        affectedIds.add(match.id);
      }

      for (const id of affectedIds) {
        const claims = await crawlerRepo.getClaimsForEvent(id);
        const { confidence, status } = computeConfidenceAndStatus(claims);
        await crawlerRepo.updateEventFromClaims(id, { confidence, status });
      }
    }

    return { groupsChecked: groups.size, eventsMerged, productSetsMerged };
  });
}

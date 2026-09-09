import type { Region, ReleaseStatus } from "@/app/generated/prisma/client";
import * as ingestRepo from "@/data/ingest/ingestRepo";
import { logEvent } from "@/lib/logger";
import { GATE_THRESHOLDS } from "./gate";
import { prereleaseOccurrencesFor, prereleaseScheduleFor } from "./prerelease";
import { datesAgreeWithin, type CandidateDate } from "./types";

/**
 * The derived-prerelease pass: put a prerelease on the calendar for every shelf
 * date confident enough to imply one, and take it back off when that stops
 * being true.
 *
 * Runs after Apply rather than as a gate stage, because it is not reasoning
 * about evidence -- it is restating a date the gate has *already* settled,
 * through the game's published schedule (./prerelease.ts). Running it after
 * Apply also means it reads this run's freshly written shelf dates, including
 * the manual overrides applyVerdictToEvent respects, rather than a state the
 * run is about to change.
 *
 * ## What it owns, and what it must not touch
 *
 * Exactly the rows with a non-null `derivedFromEventId`. Those are invisible to
 * the gate (excluded from both findOrCreateReleaseEvent and
 * getIngestTrackedEvents), carry no source claims, and are reconciled from
 * scratch here every run. Source-backed prerelease events -- Wikipedia's Magic
 * and Lorcana columns, Riot's Pre-Rift -- belong to the gate, and this pass
 * only ever *reads* them, to stand out of their way.
 *
 * ## The two directions
 *
 * Forward: a SHELF event that is CONFIRMED with an exact date, in a game with a
 * schedule, wants one derived row per slot. Backward: a derived row whose
 * anchor no longer qualifies is archived. Archived rather than deleted -- see
 * ingestRepo.archiveDerivedPrereleaseEvent for why, but the short version is
 * that a set slipping a week must not silently unfollow everyone who was
 * following its prerelease.
 *
 * Reconciliation is stateless: the desired set is computed fresh from the
 * anchors each run and compared against what exists. There is no incremental
 * bookkeeping to drift, so a run that crashed halfway through leaves nothing to
 * repair -- the next run simply computes the same answer again.
 */

/** The slice of ingestRepo this pass uses, narrowed so a test fake only has to provide these five. */
export type DerivePrereleaseDeps = Pick<
  typeof ingestRepo,
  | "getShelfAnchors"
  | "getSourcedPrereleaseDates"
  | "getDerivedPrereleaseEvents"
  | "upsertDerivedPrereleaseEvent"
  | "archiveDerivedPrereleaseEvent"
>;

export type DerivePrereleaseResult = {
  /** Derived rows written this run, whether newly created, moved with their anchor, or un-archived. */
  written: number;
  /** Derived rows archived because their anchor stopped qualifying. */
  retracted: number;
  errors: number;
};

/**
 * A shelf date only anchors a prerelease once the gate has called it CONFIRMED.
 *
 * Anything weaker would put a computed date on the calendar off the back of a
 * date that is itself still being argued about, and the derived event would
 * inherit none of that uncertainty visually -- it would just look like a fact.
 * CONFIRMED is the same bar the calendar already uses to mean "this is
 * happening", so the derived row is never more certain than its anchor.
 */
const ANCHOR_STATUS: ReleaseStatus = "CONFIRMED";

type DesiredRow = {
  key: string;
  productSetId: string;
  derivedFromEventId: string;
  derivedSlot: string;
  region: Region;
  date: CandidateDate;
  status: ReleaseStatus;
  confidence: number;
  sourceSummary: string;
};

/** NUL-separated for the same reason identity.ts's identityKey is: no component can forge a collision. */
function rowKey(anchorEventId: string, slotKey: string): string {
  return `${anchorEventId}\0${slotKey}`;
}

export async function derivePrereleaseEvents(
  params: { installIds: string[]; now: Date; scanRunId?: string },
  deps: DerivePrereleaseDeps = ingestRepo,
): Promise<DerivePrereleaseResult> {
  const { installIds, now } = params;
  const result: DerivePrereleaseResult = { written: 0, retracted: 0, errors: 0 };
  if (installIds.length === 0) return result;

  const [anchors, sourced, existing] = await Promise.all([
    deps.getShelfAnchors(installIds),
    deps.getSourcedPrereleaseDates(installIds),
    deps.getDerivedPrereleaseEvents(installIds),
  ]);

  // Prerelease dates a real source already publishes, per (productSet, region).
  const sourcedByScope = new Map<string, CandidateDate[]>();
  for (const event of sourced) {
    const key = `${event.productSetId}\0${event.region}`;
    const dates = sourcedByScope.get(key) ?? [];
    dates.push(event.date);
    sourcedByScope.set(key, dates);
  }

  const desired = new Map<string, DesiredRow>();
  for (const anchor of anchors) {
    if (anchor.status !== ANCHOR_STATUS) continue;
    const schedule = prereleaseScheduleFor(anchor.game);
    if (!schedule) continue;

    const occurrences = prereleaseOccurrencesFor(anchor.game, anchor.date);
    const sourcedDates = sourcedByScope.get(`${anchor.productSetId}\0${anchor.region}`) ?? [];

    for (const occurrence of occurrences) {
      // A real source already covers this occurrence. Stand down rather than
      // put a second, computed prerelease card a few days from a stated one --
      // to a reader those are two events, and only one of them is real.
      const alreadySourced = sourcedDates.some((date) =>
        datesAgreeWithin(date, occurrence.date, GATE_THRESHOLDS.agreementDays),
      );
      if (alreadySourced) continue;

      const key = rowKey(anchor.id, occurrence.slotKey);
      desired.set(key, {
        key,
        productSetId: anchor.productSetId,
        derivedFromEventId: anchor.id,
        derivedSlot: occurrence.slotKey,
        region: anchor.region,
        date: occurrence.date,
        // The derived row is exactly as trustworthy as the shelf date it was
        // computed from, so it inherits that confidence rather than inventing
        // one. Nothing here corroborates anything; it restates.
        status: ANCHOR_STATUS,
        confidence: anchor.confidence,
        sourceSummary: `${occurrence.label}, derived from the confirmed release date. ${schedule.note}`,
      });
    }
  }

  // ---- Forward: write every row the schedules currently call for. ----
  for (const row of desired.values()) {
    try {
      await deps.upsertDerivedPrereleaseEvent({
        productSetId: row.productSetId,
        derivedFromEventId: row.derivedFromEventId,
        derivedSlot: row.derivedSlot,
        region: row.region,
        date: row.date,
        status: row.status,
        confidence: row.confidence,
        sourceSummary: row.sourceSummary,
        now,
      });
      result.written += 1;
    } catch (error) {
      result.errors += 1;
      logEvent({
        action: "ingest.derivePrerelease",
        scanRunId: params.scanRunId,
        productSetId: row.productSetId,
        releaseEventId: row.derivedFromEventId,
        derivedSlot: row.derivedSlot,
        outcome: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ---- Backward: retract what the schedules no longer call for. ----
  // Covers every way an anchor can stop qualifying at once -- deleted,
  // archived, un-confirmed, its date gone vague, its game's schedule changed,
  // or a real source having since published the date -- because "not in the
  // desired set" is the union of all of them and needs no separate branch.
  for (const row of existing) {
    if (row.archivedAt !== null) continue;
    if (desired.has(rowKey(row.derivedFromEventId, row.derivedSlot ?? ""))) continue;
    try {
      await deps.archiveDerivedPrereleaseEvent(row.id, now);
      result.retracted += 1;
    } catch (error) {
      result.errors += 1;
      logEvent({
        action: "ingest.retractPrerelease",
        scanRunId: params.scanRunId,
        releaseEventId: row.id,
        outcome: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}

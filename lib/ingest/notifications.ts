import type { ScanChange } from "@/lib/notifications/types";
import type { RunDiffChange } from "./types";

/**
 * Maps v2's per-event diff (lib/ingest/apply.ts's RunDiffChange -- gate action
 * plus before/after dates and status) onto v1's ScanChange shape, so the same
 * subscriber/follower dispatch (lib/notifications/dispatch.ts's
 * dispatchScanChangeNotifications) keeps working after the v1 crawler --
 * previously the only caller -- was retired.
 *
 * `context` resolves a releaseEventId to the install/game/product-set names a
 * notification needs to say something human-readable; build it from
 * data/ingest/ingestRepo.ts's getChangeContextForEvents.
 *
 * Only emits a change where the status actually transitioned. A verdict that
 * only moved a date (or held one) with no status change produces no
 * ScanChange here, same as v1: `kind` has no "date_changed" case, so v1 never
 * notified on those either.
 */
export function toScanChanges(
  changes: RunDiffChange[],
  context: Map<string, { installId: string; gameName: string; productSetName: string }>,
): ScanChange[] {
  const result: ScanChange[] = [];

  for (const change of changes) {
    const ctx = context.get(change.releaseEventId);
    if (!ctx) continue; // context is queried for exactly these event ids; absence means the event vanished mid-run

    let kind: ScanChange["kind"];
    if (change.statusBefore === null) {
      kind = "created";
    } else if (change.statusBefore !== change.statusAfter) {
      kind = change.statusAfter === "RELEASED" ? "released" : "status_changed";
    } else {
      continue;
    }

    result.push({
      installId: ctx.installId,
      eventId: change.releaseEventId,
      gameName: ctx.gameName,
      productSetName: ctx.productSetName,
      status: change.statusAfter,
      kind,
      previousStatus: change.statusBefore ?? undefined,
    });
  }

  return result;
}

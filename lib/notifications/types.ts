import type { ReleaseStatus } from "@/app/generated/prisma/client";

/**
 * A single notable thing that happened to a release event during a scan --
 * either it's brand new, its status progressed (RUMORED->ANNOUNCED-> etc.,
 * driven by fresh source claims), or it crossed into RELEASED via the
 * date-based lifecycle pass. Collected during orchestrate.ts's runScan and
 * fanned out to subscribed users' alert channels (email, Discord) once the
 * scan finishes.
 */
export type ScanChange = {
  installId: string;
  eventId: string;
  gameName: string;
  productSetName: string;
  status: ReleaseStatus;
  kind: "created" | "status_changed" | "released";
  previousStatus?: ReleaseStatus;
};

export function describeChange(change: ScanChange): string {
  if (change.kind === "created") return `new release tracked (${change.status})`;
  if (change.kind === "released") return "is now released";
  return change.previousStatus
    ? `status changed: ${change.previousStatus} -> ${change.status}`
    : `status changed to ${change.status}`;
}

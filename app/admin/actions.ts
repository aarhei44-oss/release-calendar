"use server";

import { z } from "zod";
import { requireAdmin } from "@/lib/authGuards";
import * as adminRepo from "@/data/admin/adminRepo";
import { withActionLogging } from "@/lib/logger";

const idSchema = z.string().min(1);
const userRoleSchema = z.enum(["USER", "ADMIN"]);

export async function listPackagesWithInstalls() {
  return withActionLogging("admin.listPackagesWithInstalls", async () => {
    await requireAdmin();
    return adminRepo.listPackagesWithInstalls();
  });
}

export async function toggleInstallEnabled(installId: string, enabled: boolean) {
  return withActionLogging("admin.toggleInstallEnabled", async () => {
    await requireAdmin();
    return adminRepo.toggleInstallEnabled(idSchema.parse(installId), z.boolean().parse(enabled));
  });
}

export async function enableAndSeedInstall(installId: string) {
  return withActionLogging("admin.enableAndSeedInstall", async () => {
    await requireAdmin();
    return adminRepo.enableAndSeedInstall(idSchema.parse(installId));
  });
}

export async function listUsers() {
  return withActionLogging("admin.listUsers", async () => {
    await requireAdmin();
    return adminRepo.listUsers();
  });
}

export async function setUserRole(userId: string, role: "USER" | "ADMIN") {
  return withActionLogging("admin.setUserRole", async () => {
    const actingAdmin = await requireAdmin();
    const parsedUserId = idSchema.parse(userId);
    const parsedRole = userRoleSchema.parse(role);

    if (parsedUserId === actingAdmin.id && parsedRole !== "ADMIN") {
      throw new Error("You cannot remove your own admin role.");
    }

    return adminRepo.setUserRole(parsedUserId, parsedRole);
  });
}

export async function setUserActive(userId: string, active: boolean) {
  return withActionLogging("admin.setUserActive", async () => {
    const actingAdmin = await requireAdmin();
    const parsedUserId = idSchema.parse(userId);
    const parsedActive = z.boolean().parse(active);

    if (parsedUserId === actingAdmin.id && !parsedActive) {
      throw new Error("You cannot deactivate your own account.");
    }

    return adminRepo.setUserActive(parsedUserId, parsedActive);
  });
}

export async function setUserPremium(userId: string, isPremium: boolean) {
  return withActionLogging("admin.setUserPremium", async () => {
    await requireAdmin();
    return adminRepo.setUserPremium(idSchema.parse(userId), z.boolean().parse(isPremium));
  });
}

export async function listScanRuns(installId?: string) {
  return withActionLogging("admin.listScanRuns", async () => {
    await requireAdmin();
    return adminRepo.listScanRuns(installId ? idSchema.parse(installId) : undefined);
  });
}

export async function triggerRescan(installId: string) {
  return withActionLogging("admin.triggerRescan", async () => {
    await requireAdmin();
    return adminRepo.triggerRescan(idSchema.parse(installId));
  });
}

export async function triggerDedup() {
  return withActionLogging("admin.triggerDedup", async () => {
    await requireAdmin();
    return adminRepo.triggerDedup();
  });
}

export async function triggerReleaseLifecycle() {
  return withActionLogging("admin.triggerReleaseLifecycle", async () => {
    await requireAdmin();
    return adminRepo.triggerReleaseLifecycle();
  });
}

export async function listContradictedEvents() {
  return withActionLogging("admin.listContradictedEvents", async () => {
    await requireAdmin();
    return adminRepo.getEventsWithHighTierContradiction();
  });
}

export async function triggerRetentionCleanup() {
  return withActionLogging("admin.triggerRetentionCleanup", async () => {
    await requireAdmin();
    return adminRepo.triggerRetentionCleanup();
  });
}

export async function listRecentMerges() {
  return withActionLogging("admin.listRecentMerges", async () => {
    await requireAdmin();
    return adminRepo.listRecentMerges();
  });
}

export async function undoProductSetMerge(productSetId: string) {
  return withActionLogging("admin.undoProductSetMerge", async () => {
    await requireAdmin();
    return adminRepo.undoProductSetMerge(idSchema.parse(productSetId));
  });
}

export async function undoReleaseEventMerge(releaseEventId: string) {
  return withActionLogging("admin.undoReleaseEventMerge", async () => {
    await requireAdmin();
    return adminRepo.undoReleaseEventMerge(idSchema.parse(releaseEventId));
  });
}

// ---------------------------------------------------------------------------
// v2 ingest pipeline (lib/ingest) -- provider health, replay/retry, review
// queue. Same requireAdmin gate and same withActionLogging wrapper as
// everything above; no second auth mechanism.
// ---------------------------------------------------------------------------

export async function listIngestRunHealth() {
  return withActionLogging("admin.listIngestRunHealth", async () => {
    await requireAdmin();
    return adminRepo.listIngestRunHealth();
  });
}

export async function listProviderHealth() {
  return withActionLogging("admin.listProviderHealth", async () => {
    await requireAdmin();
    return adminRepo.listProviderHealth();
  });
}

/** Re-derives a stored run's conclusions from its saved payloads. Does no network I/O -- see lib/ingest/replay.ts. */
export async function replayIngestRun(runId: string) {
  return withActionLogging("admin.replayIngestRun", async () => {
    await requireAdmin();
    return adminRepo.triggerIngestReplay(idSchema.parse(runId));
  });
}

/** Re-fetches only the providers that FAILED in a run, then replays it. This one does hit the network. */
export async function retryIngestRun(runId: string) {
  return withActionLogging("admin.retryIngestRun", async () => {
    await requireAdmin();
    return adminRepo.triggerIngestRetry(idSchema.parse(runId));
  });
}

export async function triggerFreshnessCheck() {
  return withActionLogging("admin.triggerFreshnessCheck", async () => {
    await requireAdmin();
    return adminRepo.triggerFreshnessAlarmPass();
  });
}

export async function listReviewQueue() {
  return withActionLogging("admin.listReviewQueue", async () => {
    await requireAdmin();
    return adminRepo.listReviewQueue();
  });
}

export async function countOpenReviewItems() {
  return withActionLogging("admin.countOpenReviewItems", async () => {
    await requireAdmin();
    return adminRepo.countOpenReviewItems();
  });
}

/**
 * Resolves one review item.
 *
 * The resolution is parsed rather than trusted: it arrives from a client
 * component, and "accept claim #3" writes a date onto a live event and pins it
 * against future scans, so the shape is checked before it reaches the repo.
 */
const reviewResolutionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("accept"), claimIndex: z.number().int().min(0), note: z.string().max(500).optional() }),
  z.object({ kind: z.literal("keep"), note: z.string().max(500).optional() }),
  z.object({ kind: z.literal("dismiss"), note: z.string().max(500).optional() }),
]);

export async function resolveReviewItem(itemId: string, resolution: z.input<typeof reviewResolutionSchema>) {
  return withActionLogging("admin.resolveReviewItem", async () => {
    await requireAdmin();
    return adminRepo.resolveReviewItem(idSchema.parse(itemId), reviewResolutionSchema.parse(resolution));
  });
}

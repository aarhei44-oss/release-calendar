"use server";

import { z } from "zod";
import { requireAdmin } from "@/lib/authGuards";
import * as adminRepo from "@/data/admin/adminRepo";
import { withActionLogging } from "@/lib/logger";
import { requestAccountDeletion } from "@/lib/accountRemoval";
import { banAccount, unbanAccount } from "@/lib/accountModeration";
import { cancelUserRemoval } from "@/data/profile/profileRepo";

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

/**
 * Same deletion a user gets from their profile (requestAccountDeletion):
 * Stripe subscription cancelled, account deactivated, erased by the nightly
 * pass 30 days later. Note the user can undo it just by signing back in --
 * to lock someone out for abuse, use setUserActive instead.
 */
export async function deleteUser(userId: string) {
  return withActionLogging("admin.deleteUser", async () => {
    const actingAdmin = await requireAdmin();
    const parsedUserId = idSchema.parse(userId);

    if (parsedUserId === actingAdmin.id) {
      throw new Error("You cannot delete your own account here. Use your Profile page.");
    }

    await requestAccountDeletion(parsedUserId);
  });
}

/**
 * Bans a user: signed out everywhere, can't sign in, Stripe subscription
 * cancelled (no refund -- that's a manual Stripe Dashboard call), alerts off,
 * comments hidden. Unlike deleteUser, signing back in doesn't undo it, and
 * the nightly erasure pass skips banned accounts so the ban can't be dodged
 * by re-registering. Admins must be demoted before they can be banned.
 */
export async function banUser(userId: string) {
  return withActionLogging("admin.banUser", async () => {
    const actingAdmin = await requireAdmin();
    const parsedUserId = idSchema.parse(userId);

    if (parsedUserId === actingAdmin.id) {
      throw new Error("You cannot ban your own account.");
    }
    if ((await adminRepo.getUserRole(parsedUserId)) === "ADMIN") {
      throw new Error("Remove this user's admin role before banning them.");
    }

    await banAccount(parsedUserId);
  });
}

export async function unbanUser(userId: string) {
  return withActionLogging("admin.unbanUser", async () => {
    await requireAdmin();
    await unbanAccount(idSchema.parse(userId));
  });
}

/** Cancels a pending deletion -- the admin-side equivalent of the user signing back in. */
export async function cancelUserDeletion(userId: string) {
  return withActionLogging("admin.cancelUserDeletion", async () => {
    await requireAdmin();
    await cancelUserRemoval(idSchema.parse(userId));
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

export async function triggerRetentionCleanup() {
  return withActionLogging("admin.triggerRetentionCleanup", async () => {
    await requireAdmin();
    return adminRepo.triggerRetentionCleanup();
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

export async function getLastScheduledRun() {
  return withActionLogging("admin.getLastScheduledRun", async () => {
    await requireAdmin();
    return adminRepo.getLastScheduledRun();
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

// ---------------------------------------------------------------------------
// News feed (backlog item 26): source health for the admin System tab. Same
// requireAdmin gate and withActionLogging wrapper as everything above.
// ---------------------------------------------------------------------------

export async function listNewsSourceHealth() {
  return withActionLogging("admin.listNewsSourceHealth", async () => {
    await requireAdmin();
    return adminRepo.listNewsSourceHealth();
  });
}

export async function toggleNewsSourceEnabled(sourceId: string, enabled: boolean) {
  return withActionLogging("admin.toggleNewsSourceEnabled", async () => {
    await requireAdmin();
    return adminRepo.toggleNewsSourceEnabled(idSchema.parse(sourceId), z.boolean().parse(enabled));
  });
}

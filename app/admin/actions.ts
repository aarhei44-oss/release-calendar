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

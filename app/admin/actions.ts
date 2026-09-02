"use server";

import { z } from "zod";
import { requireAdmin } from "@/lib/authGuards";
import * as adminRepo from "@/data/admin/adminRepo";

const idSchema = z.string().min(1);
const userRoleSchema = z.enum(["USER", "ADMIN"]);

export async function listPackagesWithInstalls() {
  await requireAdmin();
  return adminRepo.listPackagesWithInstalls();
}

export async function toggleInstallEnabled(installId: string, enabled: boolean) {
  await requireAdmin();
  return adminRepo.toggleInstallEnabled(idSchema.parse(installId), z.boolean().parse(enabled));
}

export async function enableAndSeedInstall(installId: string) {
  await requireAdmin();
  return adminRepo.enableAndSeedInstall(idSchema.parse(installId));
}

export async function listUsers() {
  await requireAdmin();
  return adminRepo.listUsers();
}

export async function setUserRole(userId: string, role: "USER" | "ADMIN") {
  const actingAdmin = await requireAdmin();
  const parsedUserId = idSchema.parse(userId);
  const parsedRole = userRoleSchema.parse(role);

  if (parsedUserId === actingAdmin.id && parsedRole !== "ADMIN") {
    throw new Error("You cannot remove your own admin role.");
  }

  return adminRepo.setUserRole(parsedUserId, parsedRole);
}

export async function setUserActive(userId: string, active: boolean) {
  const actingAdmin = await requireAdmin();
  const parsedUserId = idSchema.parse(userId);
  const parsedActive = z.boolean().parse(active);

  if (parsedUserId === actingAdmin.id && !parsedActive) {
    throw new Error("You cannot deactivate your own account.");
  }

  return adminRepo.setUserActive(parsedUserId, parsedActive);
}

export async function listScanRuns(installId?: string) {
  await requireAdmin();
  return adminRepo.listScanRuns(installId ? idSchema.parse(installId) : undefined);
}

export async function triggerRescan(installId: string) {
  await requireAdmin();
  return adminRepo.triggerRescan(idSchema.parse(installId));
}

export async function triggerDedup() {
  await requireAdmin();
  return adminRepo.triggerDedup();
}

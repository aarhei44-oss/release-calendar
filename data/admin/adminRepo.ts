import { prisma } from "@/lib/prisma";
import type { UserRole } from "@/app/generated/prisma/client";
import { runScan } from "@/lib/crawler/orchestrate";
import { runDedupPass } from "@/lib/crawler/dedupPass";
import { runReleaseLifecyclePass } from "@/lib/crawler/lifecycle";

export async function listPackagesWithInstalls() {
  return prisma.tcgProfilePackage.findMany({
    include: { installs: { include: { _count: { select: { productSets: true } } } } },
    orderBy: { name: "asc" },
  });
}

export async function toggleInstallEnabled(installId: string, enabled: boolean) {
  return prisma.tcgProfileInstall.update({
    where: { id: installId },
    data: { enabled },
  });
}

/**
 * Enables the install and, if it has no product sets yet, creates one
 * placeholder set so the install isn't empty in the UI while the admin
 * waits on real data. The crawler (Phase 6) supersedes this placeholder
 * with real discovered product sets on its first scan; it is never
 * overwritten automatically before that.
 */
export async function enableAndSeedInstall(installId: string) {
  const install = await prisma.tcgProfileInstall.update({
    where: { id: installId },
    data: { enabled: true },
    include: { _count: { select: { productSets: true } } },
  });

  if (install._count.productSets === 0) {
    await prisma.productSet.create({
      data: {
        tcgProfileInstallId: installId,
        code: `PLACEHOLDER-${installId}`,
        name: "Placeholder product set (awaiting crawler data)",
        meta: { placeholder: true },
      },
    });
  }

  return install;
}

export async function listUsers() {
  return prisma.user.findMany({ orderBy: { createdAt: "asc" } });
}

export async function setUserRole(userId: string, role: UserRole) {
  return prisma.user.update({ where: { id: userId }, data: { role } });
}

export async function setUserActive(userId: string, active: boolean) {
  return prisma.user.update({ where: { id: userId }, data: { active } });
}

export async function listScanRuns(installId?: string) {
  return prisma.scanRun.findMany({
    where: installId ? { scopeId: installId } : undefined,
    orderBy: { createdAt: "desc" },
    take: 50,
  });
}

export async function triggerRescan(installId: string) {
  return runScan({ scopeType: "INSTALL", scopeId: installId, trigger: "MANUAL" });
}

export async function triggerDedup() {
  return runDedupPass();
}

export async function triggerReleaseLifecycle() {
  return runReleaseLifecyclePass();
}

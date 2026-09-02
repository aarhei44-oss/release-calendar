import { prisma } from "@/lib/prisma";
import type { UserRole } from "@/app/generated/prisma/client";

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

export async function enableAndSeedInstall(installId: string) {
  await prisma.tcgProfileInstall.update({
    where: { id: installId },
    data: { enabled: true },
  });
  // Seeding product sets from the package's discoveryConfig happens once the
  // crawler subsystem (Phase 6) can bootstrap sets from source config.
  throw new Error("enableAndSeedInstall: seeding logic lands in Phase 6");
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
  throw new Error(`triggerRescan(${installId}): implemented alongside the crawler orchestration in Phase 6`);
}

export async function triggerDedup() {
  throw new Error("triggerDedup: implemented alongside the crawler orchestration in Phase 6");
}

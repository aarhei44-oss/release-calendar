import { prisma } from "@/lib/prisma";

export async function subscribe(userId: string, installId: string) {
  return prisma.subscription.upsert({
    where: { userId_tcgProfileInstallId: { userId, tcgProfileInstallId: installId } },
    update: {},
    create: { userId, tcgProfileInstallId: installId },
  });
}

export async function unsubscribe(userId: string, installId: string) {
  await prisma.subscription.deleteMany({
    where: { userId, tcgProfileInstallId: installId },
  });
}

export async function listSubscriptions(userId: string) {
  return prisma.subscription.findMany({
    where: { userId },
    include: { install: { include: { package: true } } },
  });
}

export async function getUpcomingForSubscriptions(userId: string, days = 30) {
  const from = new Date();
  const to = new Date();
  to.setDate(to.getDate() + days);

  const installIds = (
    await prisma.subscription.findMany({ where: { userId }, select: { tcgProfileInstallId: true } })
  ).map((s) => s.tcgProfileInstallId);

  if (installIds.length === 0) return [];

  return prisma.releaseEvent.findMany({
    where: {
      productSet: { tcgProfileInstallId: { in: installIds } },
      dateType: "EXACT",
      dateExact: { gte: from, lte: to },
    },
    include: { productSet: { include: { install: { include: { package: true } } } } },
    orderBy: { dateExact: "asc" },
  });
}

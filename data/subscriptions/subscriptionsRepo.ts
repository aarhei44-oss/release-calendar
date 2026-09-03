import { prisma } from "@/lib/prisma";
import { getFilteredEvents, getRecentlyUpdatedEvents } from "@/data/calendar/calendarRepo";

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

export async function getSubscribedInstallIds(userId: string): Promise<string[]> {
  return (
    await prisma.subscription.findMany({ where: { userId }, select: { tcgProfileInstallId: true } })
  ).map((s) => s.tcgProfileInstallId);
}

export async function getUpcomingForSubscriptions(userId: string, days = 30) {
  const from = new Date();
  const to = new Date();
  to.setDate(to.getDate() + days);

  const installIds = await getSubscribedInstallIds(userId);
  if (installIds.length === 0) return [];

  return getFilteredEvents({ installIds, from, to });
}

/** Events updated in the last `days` across a user's subscribed installs -- see getRecentlyUpdatedEvents for what "recent" can and can't tell you here. */
export async function getRecentActivityForSubscriptions(userId: string, days = 7) {
  const updatedSince = new Date();
  updatedSince.setDate(updatedSince.getDate() - days);

  const installIds = await getSubscribedInstallIds(userId);
  if (installIds.length === 0) return [];

  return getRecentlyUpdatedEvents({ installIds, updatedSince });
}

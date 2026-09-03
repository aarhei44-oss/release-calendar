import { prisma } from "@/lib/prisma";
import { getFilteredEvents, getRecentlyUpdatedEvents, type CalendarEvent } from "@/data/calendar/calendarRepo";
import { getDismissedEventIds } from "@/data/events/eventPersonalizationRepo";

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

/**
 * Excludes events the user has dismissed ("not interested" -- premium,
 * see eventPersonalizationRepo). Applied unconditionally, not re-checked
 * against current premium status the way dashboardCardIds is: unlike
 * showing a *customization*, un-hiding something a user explicitly
 * dismissed if their premium lapses would be a confusing regression, not
 * a safe fallback -- there's no "default" dismissal state to revert to.
 */
async function excludeDismissed(userId: string, events: CalendarEvent[]): Promise<CalendarEvent[]> {
  const dismissedIds = await getDismissedEventIds(userId);
  if (dismissedIds.length === 0) return events;
  const dismissed = new Set(dismissedIds);
  return events.filter((e) => !dismissed.has(e.id));
}

export async function getUpcomingForSubscriptions(userId: string, days = 30) {
  const from = new Date();
  const to = new Date();
  to.setDate(to.getDate() + days);

  const installIds = await getSubscribedInstallIds(userId);
  if (installIds.length === 0) return [];

  const events = await getFilteredEvents({ installIds, from, to });
  return excludeDismissed(userId, events);
}

/** Events updated in the last `days` across a user's subscribed installs -- see getRecentlyUpdatedEvents for what "recent" can and can't tell you here. */
export async function getRecentActivityForSubscriptions(userId: string, days = 7) {
  const updatedSince = new Date();
  updatedSince.setDate(updatedSince.getDate() - days);

  const installIds = await getSubscribedInstallIds(userId);
  if (installIds.length === 0) return [];

  const events = await getRecentlyUpdatedEvents({ installIds, updatedSince });
  return excludeDismissed(userId, events);
}

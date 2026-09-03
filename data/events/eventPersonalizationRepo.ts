import { prisma } from "@/lib/prisma";

export async function followEvent(userId: string, releaseEventId: string) {
  return prisma.eventFollow.upsert({
    where: { userId_releaseEventId: { userId, releaseEventId } },
    update: {},
    create: { userId, releaseEventId },
  });
}

export async function unfollowEvent(userId: string, releaseEventId: string) {
  await prisma.eventFollow.deleteMany({ where: { userId, releaseEventId } });
}

export async function dismissEvent(userId: string, releaseEventId: string) {
  return prisma.eventDismissal.upsert({
    where: { userId_releaseEventId: { userId, releaseEventId } },
    update: {},
    create: { userId, releaseEventId },
  });
}

export async function undismissEvent(userId: string, releaseEventId: string) {
  await prisma.eventDismissal.deleteMany({ where: { userId, releaseEventId } });
}

/** Empty string deletes the note (nothing left to store); non-empty upserts it. */
export async function savePersonalNote(userId: string, releaseEventId: string, content: string) {
  if (content.length === 0) {
    await prisma.eventPersonalNote.deleteMany({ where: { userId, releaseEventId } });
    return null;
  }
  return prisma.eventPersonalNote.upsert({
    where: { userId_releaseEventId: { userId, releaseEventId } },
    update: { content },
    create: { userId, releaseEventId, content },
  });
}

export type EventPersonalization = {
  isFollowed: boolean;
  isDismissed: boolean;
  personalNote: string | null;
};

/** One user's private view of one event -- follow/dismiss/note are all scoped per (user, event), never visible to anyone else. */
export async function getEventPersonalization(userId: string, releaseEventId: string): Promise<EventPersonalization> {
  const [follow, dismissal, note] = await Promise.all([
    prisma.eventFollow.findUnique({ where: { userId_releaseEventId: { userId, releaseEventId } } }),
    prisma.eventDismissal.findUnique({ where: { userId_releaseEventId: { userId, releaseEventId } } }),
    prisma.eventPersonalNote.findUnique({ where: { userId_releaseEventId: { userId, releaseEventId } } }),
  ]);

  return {
    isFollowed: follow !== null,
    isDismissed: dismissal !== null,
    personalNote: note?.content ?? null,
  };
}

/** For subscriptionsRepo's "hide dismissed events" filtering. */
export async function getDismissedEventIds(userId: string): Promise<string[]> {
  const rows = await prisma.eventDismissal.findMany({ where: { userId }, select: { releaseEventId: true } });
  return rows.map((r) => r.releaseEventId);
}

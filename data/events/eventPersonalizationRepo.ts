import { prisma } from "@/lib/prisma";
import { REACTION_EMOJIS } from "@/app/calendar/eventDisplay";

const POSITIVE_EMOJIS = new Set<string>(REACTION_EMOJIS.filter((r) => r.sentiment === "positive").map((r) => r.emoji));
const NEGATIVE_EMOJIS = new Set<string>(REACTION_EMOJIS.filter((r) => r.sentiment === "negative").map((r) => r.emoji));

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

/** Sets (or changes) the calling user's single emoji reaction on an event. Free tier -- no premium check here, that lives in the server action's requireUser(). */
export async function setEventReaction(userId: string, releaseEventId: string, emoji: string) {
  return prisma.eventReaction.upsert({
    where: { userId_releaseEventId: { userId, releaseEventId } },
    update: { emoji },
    create: { userId, releaseEventId, emoji },
  });
}

export async function clearEventReaction(userId: string, releaseEventId: string) {
  await prisma.eventReaction.deleteMany({ where: { userId, releaseEventId } });
}

export type EventReactionSummary = {
  counts: Record<string, number>;
  myReaction: string | null;
};

/** Aggregate counts are public (shown to every viewer, signed in or not); myReaction is only filled in for the given userId, if any. */
export async function getEventReactionSummary(releaseEventId: string, userId?: string): Promise<EventReactionSummary> {
  const [grouped, mine] = await Promise.all([
    prisma.eventReaction.groupBy({ by: ["emoji"], where: { releaseEventId }, _count: { emoji: true } }),
    userId
      ? prisma.eventReaction.findUnique({ where: { userId_releaseEventId: { userId, releaseEventId } } })
      : null,
  ]);

  const counts: Record<string, number> = {};
  for (const row of grouped) counts[row.emoji] = row._count.emoji;

  return { counts, myReaction: mine?.emoji ?? null };
}

/**
 * Bulk full per-emoji reaction counts for a set of events -- for a compact
 * read-only badge on calendar cards/rows/grid cells (as opposed to
 * getEventReactionSummary, which also resolves one user's own reaction for
 * the interactive picker in EventDrawer). Events with zero reactions are
 * simply absent from the returned map.
 */
export async function getReactionSummariesForEvents(eventIds: string[]): Promise<Map<string, Record<string, number>>> {
  const summaries = new Map<string, Record<string, number>>();
  if (eventIds.length === 0) return summaries;

  const grouped = await prisma.eventReaction.groupBy({
    by: ["releaseEventId", "emoji"],
    where: { releaseEventId: { in: eventIds } },
    _count: { emoji: true },
  });

  for (const row of grouped) {
    const entry = summaries.get(row.releaseEventId) ?? {};
    entry[row.emoji] = row._count.emoji;
    summaries.set(row.releaseEventId, entry);
  }

  return summaries;
}

export type ReactionScore = { positive: number; negative: number };

/**
 * Bulk positive/negative reaction totals for a set of events -- for the
 * dashboard's "hype vs. meh" widget. Collapses REACTION_EMOJIS' 5 emoji into
 * the 2 sentiment buckets that matter for ranking; "Watching" (neutral)
 * contributes to neither. Events with zero reactions are simply absent from
 * the returned map rather than present with {0,0}.
 */
export async function getReactionScoresForEvents(eventIds: string[]): Promise<Map<string, ReactionScore>> {
  const scores = new Map<string, ReactionScore>();
  if (eventIds.length === 0) return scores;

  const grouped = await prisma.eventReaction.groupBy({
    by: ["releaseEventId", "emoji"],
    where: { releaseEventId: { in: eventIds } },
    _count: { emoji: true },
  });

  for (const row of grouped) {
    if (!POSITIVE_EMOJIS.has(row.emoji) && !NEGATIVE_EMOJIS.has(row.emoji)) continue;
    const entry = scores.get(row.releaseEventId) ?? { positive: 0, negative: 0 };
    if (POSITIVE_EMOJIS.has(row.emoji)) entry.positive += row._count.emoji;
    else entry.negative += row._count.emoji;
    scores.set(row.releaseEventId, entry);
  }

  return scores;
}

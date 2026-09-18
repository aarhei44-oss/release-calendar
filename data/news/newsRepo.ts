import { prisma } from "@/lib/prisma";

export async function listEnabledSources() {
  return prisma.newsFeedSource.findMany({ where: { enabled: true } });
}

export async function recordFetchOutcome(
  sourceId: string,
  outcome: { etag?: string | null; error?: string | null },
) {
  return prisma.newsFeedSource.update({
    where: { id: sourceId },
    data: {
      lastFetchedAt: new Date(),
      // undefined leaves the stored value alone (e.g. a 304 Not Modified
      // response carries no new etag to overwrite the one already stored);
      // null explicitly clears it (a successful 200 fetch with no etag header).
      lastEtag: outcome.etag === undefined ? undefined : outcome.etag,
      lastError: outcome.error ?? null,
    },
  });
}

export type NewsItemInput = {
  title: string;
  url: string;
  summary: string | null;
  publishedAt: Date;
};

/** Upserts by url -- the dedup key. A feed re-publishing the same item (e.g. an
 * edited title) updates the row in place rather than creating a duplicate. */
export async function upsertItems(sourceId: string, items: NewsItemInput[]) {
  for (const item of items) {
    await prisma.newsItem.upsert({
      where: { url: item.url },
      update: { title: item.title, summary: item.summary, publishedAt: item.publishedAt },
      create: { sourceId, ...item },
    });
  }
}

/** Soft-archives items older than the retention window instead of deleting
 * them outright -- a news archive isn't a wrong ship date, so there's no
 * reason to force an irreversible purge the way ingest's 30-day release-event
 * retention does. Archived rows just stop showing up in every query below. */
export async function pruneOldItems(olderThanDays: number) {
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
  return prisma.newsItem.updateMany({
    where: { publishedAt: { lt: cutoff }, archivedAt: null },
    data: { archivedAt: new Date() },
  });
}

export async function getLatestNewsTeaser(limit: number, installIds?: string[]) {
  return prisma.newsItem.findMany({
    where: {
      archivedAt: null,
      source: {
        enabled: true,
        ...(installIds && installIds.length > 0 ? { tcgProfileInstallId: { in: installIds } } : {}),
      },
    },
    orderBy: { publishedAt: "desc" },
    take: limit,
    include: { source: { select: { label: true, tier: true } } },
  });
}

const NEWS_LIST_LIMIT = 150;

/**
 * Full feed for the paid /news page -- premium-gated by the caller
 * (app/news/page.tsx), unlike getLatestNewsTeaser above. `installIds`
 * filters to sources tied to those TcgProfileInstalls; an empty/omitted
 * filter returns every enabled source's items, cross-game press included.
 */
export async function listNewsItems({ installIds }: { installIds?: string[] } = {}) {
  return prisma.newsItem.findMany({
    where: {
      archivedAt: null,
      source: {
        enabled: true,
        ...(installIds && installIds.length > 0 ? { tcgProfileInstallId: { in: installIds } } : {}),
      },
    },
    orderBy: { publishedAt: "desc" },
    take: NEWS_LIST_LIMIT,
    include: { source: { select: { label: true, tier: true, tcgProfileInstallId: true } } },
  });
}

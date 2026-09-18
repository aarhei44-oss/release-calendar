import { afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { runNewsFetch, NEWS_RETENTION_DAYS } from "@/lib/news/fetchFeeds";

/**
 * lib/news/fetchFeeds.ts's policy: conditional requests, per-source fault
 * isolation, and dedup-by-url. Every test injects fetch -- same seam
 * tests/ingestFetch.test.ts uses for lib/ingest/fetch.ts, not a test-only
 * back door (production passes globalThis.fetch, the default).
 */

function rssFeed(items: { title: string; link: string; pubDate: string }[]): string {
  const body = items
    .map((item) => `<item><title>${item.title}</title><link>${item.link}</link><pubDate>${item.pubDate}</pubDate><description>Summary of ${item.title}</description></item>`)
    .join("");
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>Test Feed</title>${body}</channel></rss>`;
}

function response(status: number, body = "", headers: Record<string, string> = {}): Response {
  return new Response(status === 304 ? null : body, { status, headers });
}

/** A mock fetch typed like the real one, so a recorded call's url/init is readable. */
type FetchMock = (url: string, init?: RequestInit) => Promise<Response>;

async function createSource(overrides: Partial<{ feedUrl: string; enabled: boolean; lastEtag: string | null }> = {}) {
  return prisma.newsFeedSource.create({
    data: {
      label: "Test Source",
      feedUrl: overrides.feedUrl ?? `https://news-fetch.example/${crypto.randomUUID()}`,
      tier: "COMMUNITY",
      enabled: overrides.enabled ?? true,
      lastEtag: overrides.lastEtag ?? null,
    },
  });
}

// Each test's source(s) are cleaned up immediately after, not just once at
// the end of the file -- runNewsFetch fetches every enabled source in the
// database, so a leftover source from an earlier test would otherwise also
// receive whatever body the current test's mock returns and could win
// ownership of that test's item via the upsert-by-url dedup.
afterEach(async () => {
  await prisma.newsItem.deleteMany({ where: { source: { feedUrl: { contains: "news-fetch.example" } } } });
  await prisma.newsFeedSource.deleteMany({ where: { feedUrl: { contains: "news-fetch.example" } } });
});

describe("runNewsFetch: fetching and storing", () => {
  it("stores items from a fresh 200 response and records the etag", async () => {
    const source = await createSource();
    const fetchImpl = vi.fn(async () =>
      response(
        200,
        rssFeed([
          { title: "First headline", link: `${source.feedUrl}/first`, pubDate: "Thu, 17 Sep 2026 12:00:00 GMT" },
          { title: "Second headline", link: `${source.feedUrl}/second`, pubDate: "Thu, 17 Sep 2026 10:00:00 GMT" },
        ]),
        { etag: '"v1"' },
      ),
    );

    const result = await runNewsFetch({ fetch: fetchImpl as unknown as typeof globalThis.fetch });
    expect(result.sourcesFetched).toBeGreaterThanOrEqual(1);

    const items = await prisma.newsItem.findMany({ where: { sourceId: source.id }, orderBy: { publishedAt: "desc" } });
    expect(items).toHaveLength(2);
    expect(items[0].title).toBe("First headline");
    expect(items[0].summary).toBe("Summary of First headline");

    const updated = await prisma.newsFeedSource.findUniqueOrThrow({ where: { id: source.id } });
    expect(updated.lastEtag).toBe('"v1"');
    expect(updated.lastError).toBeNull();
    expect(updated.lastFetchedAt).not.toBeNull();
  });

  it("dedups by url on a repeat fetch of the same items", async () => {
    const source = await createSource();
    const body = rssFeed([{ title: "Repeated", link: `${source.feedUrl}/repeated`, pubDate: "Thu, 17 Sep 2026 12:00:00 GMT" }]);
    const fetchImpl = vi.fn(async () => response(200, body));

    await runNewsFetch({ fetch: fetchImpl as unknown as typeof globalThis.fetch });
    await runNewsFetch({ fetch: fetchImpl as unknown as typeof globalThis.fetch });

    const items = await prisma.newsItem.findMany({ where: { sourceId: source.id } });
    expect(items).toHaveLength(1);
  });

  it("sends the stored etag as If-None-Match and preserves it on a 304 without erroring", async () => {
    const source = await createSource({ lastEtag: '"cached"' });
    const fetchImpl = vi.fn<FetchMock>(async () => response(304));

    await runNewsFetch({ fetch: fetchImpl as unknown as typeof globalThis.fetch });

    const headers = fetchImpl.mock.calls.find((call) => call[0] === source.feedUrl)?.[1]?.headers as
      | Record<string, string>
      | undefined;
    expect(headers?.["If-None-Match"]).toBe('"cached"');

    const updated = await prisma.newsFeedSource.findUniqueOrThrow({ where: { id: source.id } });
    expect(updated.lastEtag).toBe('"cached"');
    expect(updated.lastError).toBeNull();
  });

  it("isolates one source's failure from another's success", async () => {
    const failing = await createSource();
    const succeeding = await createSource();
    const fetchImpl = vi.fn<FetchMock>(async (url) => {
      if (url === failing.feedUrl) throw new Error("feed unreachable");
      return response(200, rssFeed([{ title: "Still works", link: `${succeeding.feedUrl}/ok`, pubDate: "Thu, 17 Sep 2026 12:00:00 GMT" }]));
    });

    await runNewsFetch({ fetch: fetchImpl as unknown as typeof globalThis.fetch });

    const failedSource = await prisma.newsFeedSource.findUniqueOrThrow({ where: { id: failing.id } });
    expect(failedSource.lastError).toContain("feed unreachable");

    const succeededItems = await prisma.newsItem.findMany({ where: { sourceId: succeeding.id } });
    expect(succeededItems).toHaveLength(1);
  });

  it("never fetches a disabled source", async () => {
    const disabled = await createSource({ enabled: false });
    const fetchImpl = vi.fn<FetchMock>(async () => response(200, rssFeed([])));

    await runNewsFetch({ fetch: fetchImpl as unknown as typeof globalThis.fetch });

    expect(fetchImpl.mock.calls.some((call) => call[0] === disabled.feedUrl)).toBe(false);
  });
});

describe("runNewsFetch: retention", () => {
  it("archives items older than the retention window instead of deleting them", async () => {
    const source = await createSource();
    const old = await prisma.newsItem.create({
      data: {
        sourceId: source.id,
        title: "Old item",
        url: `${source.feedUrl}/old`,
        publishedAt: new Date(Date.now() - (NEWS_RETENTION_DAYS + 5) * 24 * 60 * 60 * 1000),
      },
    });
    const fetchImpl = vi.fn(async () => response(200, rssFeed([])));

    await runNewsFetch({ fetch: fetchImpl as unknown as typeof globalThis.fetch });

    const archived = await prisma.newsItem.findUniqueOrThrow({ where: { id: old.id } });
    expect(archived.archivedAt).not.toBeNull();
  });
});

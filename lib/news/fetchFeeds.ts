import Parser from "rss-parser";
import * as newsRepo from "@/data/news/newsRepo";
import type { NewsItemInput } from "@/data/news/newsRepo";

// Longer, looser than ingest's 30-day hard-delete of past-due release events
// (see lib/ingest/retention.ts) -- a news archive isn't a wrong ship date, so
// there's no reason to purge it on the same clock.
export const NEWS_RETENTION_DAYS = 90;

const parser = new Parser();

type EnabledSource = Awaited<ReturnType<typeof newsRepo.listEnabledSources>>[number];

/** One source's fetch, isolated so a single feed failing (dead URL, malformed
 * XML, a timeout) never stops the rest of the run -- same principle
 * lib/ingest/orchestrate.ts applies per-candidate during a scan.
 *
 * `fetchImpl` is injected rather than read off the global, the same seam
 * lib/ingest/fetch.ts's fetchConditional uses -- production passes
 * globalThis.fetch (the default), tests pass a canned one. Not a test-only
 * back door. */
async function fetchOneSource(source: EnabledSource, fetchImpl: typeof globalThis.fetch): Promise<void> {
  try {
    const headers: Record<string, string> = {};
    if (source.lastEtag) headers["If-None-Match"] = source.lastEtag;

    const response = await fetchImpl(source.feedUrl, { headers });

    if (response.status === 304) {
      await newsRepo.recordFetchOutcome(source.id, {});
      return;
    }

    if (!response.ok) {
      await newsRepo.recordFetchOutcome(source.id, { error: `HTTP ${response.status}` });
      return;
    }

    const body = await response.text();
    const feed = await parser.parseString(body);

    const items: NewsItemInput[] = (feed.items ?? [])
      .filter((item): item is Parser.Item & { link: string; title: string } => Boolean(item.link && item.title))
      .map((item) => ({
        title: item.title.trim(),
        url: item.link,
        summary: item.contentSnippet?.trim() || item.summary?.trim() || null,
        publishedAt: item.isoDate
          ? new Date(item.isoDate)
          : item.pubDate
            ? new Date(item.pubDate)
            : new Date(),
      }));

    await newsRepo.upsertItems(source.id, items);
    await newsRepo.recordFetchOutcome(source.id, { etag: response.headers.get("etag") });
  } catch (error) {
    await newsRepo.recordFetchOutcome(source.id, {
      error: error instanceof Error ? error.message : "Unknown fetch error",
    });
  }
}

/** Entry point for the trigger route (app/api/news/run). Sources are fetched
 * one at a time, deliberately not concurrently: this is SQLite (single
 * writer), and lib/ingest/orchestrate.ts's own history is exactly this
 * lesson -- concurrent Prisma writes against it race. A handful of feeds on
 * a 6h cadence has no real need for the network-level concurrency ingest's
 * dozens of providers use; the isolation that matters here is per-source
 * error handling, not parallelism, and fetchOneSource already provides that. */
export async function runNewsFetch(options: { fetch?: typeof globalThis.fetch } = {}): Promise<{
  sourcesFetched: number;
}> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const sources = await newsRepo.listEnabledSources();
  for (const source of sources) {
    await fetchOneSource(source, fetchImpl);
  }
  await newsRepo.pruneOldItems(NEWS_RETENTION_DAYS);
  return { sourcesFetched: sources.length };
}

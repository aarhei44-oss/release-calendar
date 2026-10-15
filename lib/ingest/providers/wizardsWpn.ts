import * as cheerio from "cheerio";
import { z } from "zod";
import { fetchConditional } from "../fetch";
import { isPlaceholderName } from "../identity";
import { decodePayloadBody } from "../normalize";
import type { Candidate, CandidateDate, RawPayloadRecord } from "../types";
import {
  failedPayload,
  isWithinForwardWindow,
  notModifiedPayload,
  okPayload,
  parseErrorFor,
} from "./shared";
import type { FetchContext, Provider } from "./types";

/**
 * Wizards of the Coast's retailer-facing "Dates & Details" pages -- Magic's
 * first OFFICIAL-tier origin.
 *
 * Until now Magic's dates could only publish through gate rule G2 (Scryfall,
 * TCGplayer and Wikipedia agreeing) and, worse, no origin carried a *prerelease*
 * window at all except Wikipedia's lone COMMUNITY column. Wizards publishes both
 * for every main set on wpn.wizards.com, about three months ahead, in a table
 * that is identical from page to page:
 *
 *   <table class="key-dates"> ... Prerelease | November 6-12 ... Release | November 13 </table>
 *
 * Which is what made Star Trek stick at ANNOUNCED: Wikipedia stated 2026-11-20,
 * Scryfall and TCGplayer stated 2026-11-13, and with no OFFICIAL claim in the
 * room nothing could settle it, so the derived prerelease (which needs a
 * CONFIRMED anchor) never appeared either.
 *
 * ## What is and is not read
 *
 * Only the `Prerelease` and `Release` rows of the key-dates table. The pages also
 * carry marketing-kit deadlines, Commander Party weeks, season-long league
 * windows and so on; none of that is a release date. A page describes one *set*
 * -- its Commander decks and collector products share its dates and have no page
 * of their own -- so each page yields at most two candidates, named after the
 * set, with no code (the pages state none; identity resolves by name).
 *
 * ## Years
 *
 * The key-dates table states a year only sometimes ("April 2-8, 2027" on one
 * page, "November 6-12" on another). Resolution order for a year-less cell:
 * the earliest year in the page's "Scheduled Events" list (when it states any;
 * Reality Fracture's states none), then the first occurrence on or after the
 * post's own publish date, which every page prints ("Sep 9, 2026 -- In-Store
 * Play...") and which always precedes the events listed. The release date is
 * resolved relative to the prerelease it follows. A cell with no year from any
 * of these is dropped rather than guessed: this origin publishes alone under G1,
 * so a wrong year would go straight onto the calendar.
 *
 * ## Discovery
 *
 * `/en/news` is a flat list of the latest nine or so posts with no pagination,
 * and a dates page falls off it within weeks of a newer one being posted --
 * long before its set ships. (This is the same trap playriftbound.ts hit when
 * its roadmap article scrolled off.) Pinning slugs does not work here because
 * the slugs are not known in advance, so Fetch also follows the dates pages
 * that each dates page links to in its "Related Articles" block, which keeps an
 * older page reachable from a newer one. Reachability is therefore best-effort
 * for a page more than a couple of newer posts old; the provider's value is the
 * next few months of sets, which are always on or near the index.
 *
 * robots.txt on wpn.wizards.com returns 404 (no restrictions stated), and every
 * request goes through the shared fetch layer's identifying User-Agent.
 */

const PROVIDER_KEY = "wizards-wpn";
const GAME = "magic-the-gathering";
const ORIGIN = "wizards-official";
const BASE_URL = "https://wpn.wizards.com";
const INDEX_URL = `${BASE_URL}/en/news`;

/** An English "<set>-dates-and-details" news post. */
const DATES_PAGE_PATH = /^\/en\/news\/([a-z0-9-]+-dates-and-details)\/?$/;

/** Upper bound on pages fetched per run, so a link loop or a redesign cannot turn one run into a crawl. */
export const MAX_DATES_PAGES = 12;

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

/**
 * Every dates-page slug linked from a page, in document order.
 *
 * Resolved against INDEX_URL before matching so a relative href and an absolute
 * one reduce to the same pathname, and a link to another language ("/ru/news/...")
 * or to a non-dates post never matches.
 */
function discoverDatesSlugs(html: string): string[] {
  const $ = cheerio.load(html);
  const slugs = new Set<string>();
  $("a[href]").each((_, element) => {
    const href = $(element).attr("href");
    if (!href) return;
    let pathname: string;
    try {
      pathname = new URL(href, INDEX_URL).pathname;
    } catch {
      return;
    }
    const match = DATES_PAGE_PATH.exec(pathname);
    if (match) slugs.add(match[1]);
  });
  return [...slugs];
}

/**
 * Drops what a stored page does not need: scripts, styles and the Nuxt hydration
 * blob, which together are most of the ~400 KB each page weighs and contain a
 * second, JSON-escaped copy of the article body. Everything the parser reads is
 * ordinary markup and survives untouched.
 */
function slimPage(html: string): string {
  const $ = cheerio.load(html);
  $("script, style, noscript, svg, link, meta").remove();
  return $.html();
}

/** What this provider stores: the news index plus every dates page reached from it, one payload per run. */
const storedPayloadSchema = z.object({
  index: z.string(),
  pages: z.record(z.string(), z.string()),
});

/**
 * Fetches the news index, then each dates page it links, then (breadth-first,
 * capped) any further dates pages those link to.
 *
 * Assembled into one payload and compared by content hash, for the same reason
 * playriftbound.ts does: a 304 on one piece would leave a hole the FetchContext
 * cannot fill, whereas the whole assembled blob can be compared against last
 * run's hash to skip parsing on a quiet week.
 *
 * A page the *index* links that fails to fetch fails the provider -- that is a
 * real outage and should page someone. A page found only through a related-links
 * block that fails is skipped: an old post being removed is not an outage, and
 * failing on it would fail every night until someone noticed.
 */
export async function fetchWizardsWpn(ctx: FetchContext): Promise<RawPayloadRecord> {
  try {
    const indexResult = await fetchConditional({
      url: INDEX_URL,
      fetch: ctx.fetch,
      signal: ctx.signal,
      accept: "text/html,application/xhtml+xml",
    });
    if (indexResult.kind === "not-modified") {
      throw new Error("unexpected 304 for the news index");
    }

    const fromIndex = new Set(discoverDatesSlugs(indexResult.body));
    const queue = [...fromIndex];
    const seen = new Set<string>();
    const pages: Record<string, string> = {};

    while (queue.length > 0 && seen.size < MAX_DATES_PAGES) {
      const slug = queue.shift() as string;
      if (seen.has(slug)) continue;
      seen.add(slug);

      try {
        const result = await fetchConditional({
          url: `${INDEX_URL}/${slug}`,
          fetch: ctx.fetch,
          signal: ctx.signal,
          accept: "text/html,application/xhtml+xml",
        });
        if (result.kind === "not-modified") continue;
        pages[slug] = slimPage(result.body);
        queue.push(...discoverDatesSlugs(result.body));
      } catch (error) {
        if (fromIndex.has(slug)) throw error;
      }
    }

    const sorted = Object.fromEntries(Object.entries(pages).sort(([a], [b]) => a.localeCompare(b)));
    const payload = okPayload({
      scanRunId: ctx.scanRunId,
      providerKey: PROVIDER_KEY,
      value: { index: slimPage(indexResult.body), pages: sorted },
      fetchedAt: ctx.now,
    });

    if (ctx.contentHash && ctx.contentHash === payload.contentHash) {
      return notModifiedPayload({
        scanRunId: ctx.scanRunId,
        providerKey: PROVIDER_KEY,
        contentHash: payload.contentHash,
        fetchedAt: ctx.now,
      });
    }

    return payload;
  } catch (error) {
    return failedPayload({ scanRunId: ctx.scanRunId, providerKey: PROVIDER_KEY, fetchedAt: ctx.now, error });
  }
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

const MONTH_PATTERN =
  "(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?";
const DASH = "\\s*[\\u2013\\u2014-]\\s*";

/** "April 9, 2027" / "November 13" */
const SINGLE_DATE = new RegExp(`^${MONTH_PATTERN}\\s+(\\d{1,2})(?:,\\s*(\\d{4}))?$`, "i");
/** "November 6-12" / "April 2-8, 2027" */
const SAME_MONTH_RANGE = new RegExp(`^${MONTH_PATTERN}\\s+(\\d{1,2})${DASH}(\\d{1,2})(?:,\\s*(\\d{4}))?$`, "i");
/** "September 25-October 1" / "December 29, 2026-January 4, 2027" */
const CROSS_MONTH_RANGE = new RegExp(
  `^${MONTH_PATTERN}\\s+(\\d{1,2})(?:,\\s*(\\d{4}))?${DASH}${MONTH_PATTERN}\\s+(\\d{1,2})(?:,\\s*(\\d{4}))?$`,
  "i",
);

const MONTH_INDEX: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

function monthIndex(name: string): number {
  return MONTH_INDEX[name.slice(0, 3).toLowerCase()];
}

/** A UTC-midnight date, or null for one that does not exist (February 30 must not roll into March). */
function utcDate(year: number, month: number, day: number): Date | null {
  const date = new Date(Date.UTC(year, month, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month && date.getUTCDate() === day ? date : null;
}

type ResolvedSpan = { start: Date; end: Date };

/**
 * One key-dates cell as a span of days (a single day has start === end).
 *
 * A year the cell states always wins. Otherwise the year comes from `hintYear`
 * (the page's own Scheduled Events list), and failing that from `notBefore`'s
 * year; with neither, a year-less cell fails (null) rather than being guessed.
 *
 * `notBefore` is also the floor for a year-less cell: it must land strictly
 * after it, so a date that falls on or before it means the *next* year. That is
 * how a release resolves relative to the prerelease it follows ("December
 * 29-31" then "January 4"), and how a cell resolves relative to the page's
 * publish date. A range that appears to run backwards ("December 29-January 4")
 * likewise ends in the following year.
 */
export function parseWpnDateCell(raw: string, hintYear: number | null, notBefore: Date | null): ResolvedSpan | null {
  const text = raw.replace(/\s+/g, " ").trim();

  /** Resolves a month/day to a date, preferring a stated year and otherwise the earliest year clearing the floor. */
  const resolve = (month: string, day: string, explicitYear: string | undefined): Date | null => {
    if (explicitYear) return utcDate(Number(explicitYear), monthIndex(month), Number(day));
    const year = hintYear ?? notBefore?.getUTCFullYear() ?? null;
    if (year === null) return null;
    const date = utcDate(year, monthIndex(month), Number(day));
    if (date && notBefore && date <= notBefore) return utcDate(year + 1, monthIndex(month), Number(day));
    return date;
  };

  const cross = CROSS_MONTH_RANGE.exec(text);
  if (cross) {
    const [, startMonth, startDay, startYear, endMonth, endDay, endYear] = cross;
    const start = resolve(startMonth, startDay, startYear);
    if (!start) return null;
    let end = utcDate(endYear ? Number(endYear) : start.getUTCFullYear(), monthIndex(endMonth), Number(endDay));
    if (end && !endYear && end < start) end = utcDate(start.getUTCFullYear() + 1, monthIndex(endMonth), Number(endDay));
    return end ? { start, end } : null;
  }

  const sameMonth = SAME_MONTH_RANGE.exec(text);
  if (sameMonth) {
    const [, month, startDay, endDay, explicitYear] = sameMonth;
    const start = resolve(month, startDay, explicitYear);
    if (!start) return null;
    const end = utcDate(start.getUTCFullYear(), monthIndex(month), Number(endDay));
    return end && end >= start ? { start, end } : null;
  }

  const single = SINGLE_DATE.exec(text);
  if (single) {
    const [, month, day, explicitYear] = single;
    const date = resolve(month, day, explicitYear);
    return date ? { start: date, end: date } : null;
  }

  return null;
}

/**
 * "Magic: The Gathering(R) | Star Trek(TM) - Dates & Details | WPN" -> "Star Trek".
 * A page that does not follow the shape yields "" and is skipped.
 */
export function setNameFromTitle(title: string): string {
  return title
    .replace(/[®™]/g, "")
    .replace(/\s*\|\s*WPN\s*$/i, "")
    .replace(/\s*[–—-]\s*Dates\s*&\s*Details\s*$/i, "")
    .replace(/^\s*Magic:\s*The\s+Gathering\s*\|\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The key-dates table as label -> value, lower-cased labels, first row wins.
 * A label's parenthetical annotation is dropped ("WPN Marketing Portal
 * availability (updated)"), since Wizards flags a revised row that way.
 */
function readKeyDates($: cheerio.CheerioAPI): Map<string, string> | null {
  const table = $("table.key-dates").first();
  if (table.length === 0) return null;
  const rows = new Map<string, string>();
  table.find("tr").each((_, row) => {
    const cells = $(row).find("td, th");
    if (cells.length < 2) return;
    const label = cells.eq(0).text().replace(/\s+/g, " ").replace(/\s*\([^)]*\)\s*$/, "").trim().toLowerCase();
    if (label && !rows.has(label)) rows.set(label, cells.eq(1).text().replace(/\s+/g, " ").trim());
  });
  return rows;
}

/** The earliest four-digit year in the "Scheduled Events" section, which always states full years. */
function scheduledEventsYear($: cheerio.CheerioAPI): number | null {
  let years: number[] = [];
  $("h2").each((_, heading) => {
    if (!/^Scheduled Events\b/i.test($(heading).text().trim())) return;
    const text = $(heading).nextUntil("h2").text();
    years = [...text.matchAll(/\b(20\d{2})\b/g)].map((match) => Number(match[1]));
    return false;
  });
  return years.length > 0 ? Math.min(...years) : null;
}

/** "Sep 9, 2026 -- In-Store Play, Events, Promos": the post's own publish date. Its class name is a build hash, so it is found by shape. */
const PUBLISHED_LINE = new RegExp(`^${MONTH_PATTERN}\\s+(\\d{1,2}),\\s*(\\d{4})\\s*[\\u2013\\u2014-]`, "i");

function publishedDate($: cheerio.CheerioAPI): Date | null {
  let published: Date | null = null;
  $("p").each((_, paragraph) => {
    const match = PUBLISHED_LINE.exec($(paragraph).text().trim());
    if (!match) return;
    published = utcDate(Number(match[3]), monthIndex(match[1]), Number(match[2]));
    return false;
  });
  return published;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function candidateDate(span: ResolvedSpan): CandidateDate {
  return span.start.getTime() === span.end.getTime()
    ? { kind: "EXACT", date: span.start }
    : { kind: "RANGE", start: span.start, end: span.end };
}

/** Candidates from one page, and whether it had a key-dates table at all (for the drift check). */
function parsePage(args: {
  slug: string;
  html: string;
  fetchedAt: Date;
}): { candidates: Candidate[]; hasKeyDates: boolean } {
  const { slug, html, fetchedAt } = args;
  const $ = cheerio.load(html);

  const keyDates = readKeyDates($);
  if (!keyDates) return { candidates: [], hasKeyDates: false };

  const name = setNameFromTitle($("title").first().text());
  if (!name || isPlaceholderName(name)) return { candidates: [], hasKeyDates: true };

  const hintYear = scheduledEventsYear($);
  const prereleaseText = keyDates.get("prerelease");
  const releaseText = keyDates.get("release");

  // A dates page is posted before any event it lists, so a year-less cell lands
  // on or after the post date. The day before is the (strict) floor.
  const published = publishedDate($);
  const publishFloor = published ? new Date(published.getTime() - MS_PER_DAY) : null;

  const prerelease = prereleaseText ? parseWpnDateCell(prereleaseText, hintYear, publishFloor) : null;
  const release = releaseText
    ? parseWpnDateCell(
        releaseText,
        prerelease ? prerelease.end.getUTCFullYear() : hintYear,
        prerelease?.end ?? publishFloor,
      )
    : null;

  const base = {
    origin: ORIGIN,
    game: GAME,
    name,
    code: null,
    region: "GLOBAL" as const,
    url: `${INDEX_URL}/${slug}`,
  };
  const candidates: Candidate[] = [];

  if (release) {
    const date = candidateDate(release);
    if (isWithinForwardWindow(date, fetchedAt)) {
      candidates.push({ ...base, externalIds: { [ORIGIN]: slug }, date, type: "SHELF" });
    }
  }
  if (prerelease) {
    const date = candidateDate(prerelease);
    if (isWithinForwardWindow(date, fetchedAt)) {
      candidates.push({ ...base, externalIds: { [ORIGIN]: slug }, date, type: "PRERELEASE" });
    }
  }

  return { candidates, hasKeyDates: true };
}

function decodeWizardsWpnPayload(payload: RawPayloadRecord): { index: string; pages: Record<string, string> } {
  const decoded = storedPayloadSchema.safeParse(decodePayloadBody(payload));
  if (!decoded.success) {
    const issue = decoded.error.issues[0];
    throw parseErrorFor(PROVIDER_KEY, issue.path.map(String).join(".") || "body", issue.message, decoded.error);
  }
  return decoded.data;
}

/**
 * Two kinds of drift are errors rather than a quiet week. The index losing every
 * dates-page link means the news list was redesigned out from under the selector
 * (there is always at least one set in the pipeline). And a run that fetched
 * dates pages but found a key-dates table on none of them means the table was
 * restyled -- every real dates page has one, so "none" is never news.
 */
function parseWizardsWpn(payload: RawPayloadRecord): Candidate[] {
  const { index, pages } = decodeWizardsWpnPayload(payload);

  if (discoverDatesSlugs(index).length === 0) {
    throw parseErrorFor(PROVIDER_KEY, "index", "no dates-and-details links matched on the news index");
  }

  const candidates: Candidate[] = [];
  let withTable = 0;
  const slugs = Object.keys(pages);
  for (const slug of slugs) {
    const result = parsePage({ slug, html: pages[slug], fetchedAt: payload.fetchedAt });
    if (result.hasKeyDates) withTable += 1;
    candidates.push(...result.candidates);
  }

  if (slugs.length > 0 && withTable === 0) {
    throw parseErrorFor(PROVIDER_KEY, "pages", "no fetched dates page contained a key-dates table");
  }

  return candidates;
}

export const wizardsWpnProvider: Provider = {
  key: PROVIDER_KEY,
  origin: ORIGIN,
  tier: "OFFICIAL",
  games: [GAME],
  fetch: fetchWizardsWpn,
  parse: parseWizardsWpn,
};

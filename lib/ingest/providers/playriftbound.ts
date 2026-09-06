import * as cheerio from "cheerio";
import { z } from "zod";
import { decodeValidators, encodeValidators, fetchConditional } from "../fetch";
import { isPlaceholderName } from "../identity";
import { decodePayloadBody } from "../normalize";
import type { Candidate, CandidateDate, RawPayloadRecord } from "../types";
import {
  failedPayload,
  isWithinForwardWindow,
  notModifiedPayload,
  okPayload,
  parseCandidateDateText,
  parseErrorFor,
} from "./shared";
import type { FetchContext, Provider } from "./types";

/**
 * Riftbound's own news site -- its first OFFICIAL-tier origin.
 *
 * Until now Riftbound had tcgcsv (RETAILER) and wikipedia (COMMUNITY), so its
 * dates could only ever publish through gate rule G2. Neither of those origins
 * carries a "Pre-Rift" date at all -- Riftbound's own term for the week-early
 * local-store event that precedes a set's worldwide release -- and nothing else
 * in the registry does either, per registry.ts's note that Riot's site was
 * originally skipped as "news and a get-started page". That was true of the
 * page originally evaluated; it is not true of this one.
 *
 * `/en-us/news/announcements/` turns out to publish exactly the missing data,
 * in a genuinely consistent shape: every set announcement carries an `<h2>Set
 * N: Name</h2>` heading followed by a plain-language info list --
 * `3-Letter Code`, `Pre-Rift`, `Release` -- inside prose that is otherwise
 * ordinary marketing copy. A companion fan site (riftbound.gg) has the same
 * information in actual HTML tables, which would parse more cleanly, but its
 * robots.txt disallows `anthropic-ai`/`Claude-Web`/`GPTBot` by name (a Raptive
 * ad-network requirement) -- deliberately not worked around here by presenting
 * as a different user-agent, since that is the site's stated policy, not an
 * accident of technical detection. playriftbound.com's robots.txt is wide open.
 *
 * Two-phase fetch, unlike every other provider in this file: the article URLs
 * are not known ahead of time, so Fetch reads the announcements index first,
 * discovers which articles exist, and then fetches each of those -- all before
 * returning, so Parse is still handed a complete, static snapshot and stays a
 * pure function of it. Most articles are merch-store updates or FAQs with zero
 * set sections; that is normal, not drift, so unlike the Bandai and MediaWiki
 * providers there is no assertion that every fetch must yield a row. The one
 * failure this can still detect is the index itself losing every recognisable
 * article link, which means the site was redesigned out from under the
 * selector -- see the drift check in `parsePlayriftbound`.
 */

const PROVIDER_KEY = "playriftbound";
const GAME = "riftbound";
const ORIGIN = "riot-official";
const BASE_URL = "https://playriftbound.com";
const INDEX_URL = `${BASE_URL}/en-us/news/announcements/`;

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

/** An announcement article link on the index page: "/en-us/news/announcements/<slug>", with or without a trailing slash. */
const ARTICLE_PATH = /^\/en-us\/news\/announcements\/([a-z0-9-]+)\/?$/;

/**
 * Every announcement slug linked from the index page.
 *
 * Resolved against INDEX_URL before matching, so both a relative href
 * ("/en-us/news/announcements/foo") and an absolute one (the page's own
 * language-switcher links) reduce to a pathname the same regex can judge --
 * and so a language-switcher link to "/de-de/..." is naturally excluded rather
 * than needing its own carve-out.
 */
function discoverArticleSlugs(indexHtml: string): string[] {
  const $ = cheerio.load(indexHtml);
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
    const match = ARTICLE_PATH.exec(pathname);
    if (match) slugs.add(match[1]);
  });

  return [...slugs];
}

/** What this provider stores: the index page plus every article page it linked to, one payload per run. */
const storedPayloadSchema = z.object({
  index: z.string(),
  articles: z.record(z.string(), z.string()),
});

/**
 * Fetches the announcements index, then every article it links to, and stores
 * both as one payload.
 *
 * Assembled into a single blob for the same reason the multi-page providers
 * in publisherHtml.ts and mediawiki.ts are: a 304 on one piece would leave a
 * hole the FetchContext cannot fill, since it carries last run's *hash* and
 * not last run's body. The whole assembled payload is compared by content
 * hash instead, which still skips parsing and everything downstream on a
 * quiet week -- most weeks, for a page that changes when Riot posts news.
 */
export async function fetchPlayriftbound(ctx: FetchContext): Promise<RawPayloadRecord> {
  try {
    const indexResult = await fetchConditional({
      url: INDEX_URL,
      fetch: ctx.fetch,
      signal: ctx.signal,
      accept: "text/html,application/xhtml+xml",
      validators: decodeValidators(ctx.etag),
    });
    if (indexResult.kind === "not-modified") {
      throw new Error("unexpected 304 for the announcements index");
    }

    const articles: Record<string, string> = {};
    for (const slug of discoverArticleSlugs(indexResult.body)) {
      const result = await fetchConditional({
        url: `${INDEX_URL}${slug}/`,
        fetch: ctx.fetch,
        signal: ctx.signal,
        accept: "text/html,application/xhtml+xml",
        validators: decodeValidators(ctx.etag),
      });
      if (result.kind === "not-modified") continue;
      articles[slug] = result.body;
    }

    const payload = okPayload({
      scanRunId: ctx.scanRunId,
      providerKey: PROVIDER_KEY,
      value: { index: indexResult.body, articles },
      fetchedAt: ctx.now,
      etag: encodeValidators({}),
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

/** "Set 6: Legacy" -> "Legacy". "Set 8" (no colon -- Riot's own marker for a set with no name locked yet) does not match, same reasoning as identity.ts's isPlaceholderName. */
const SET_HEADING = /^Set\s+\d+\s*:\s*(.+)$/i;

const CODE_LINE = /^3-Letter Code:\s*(.+)$/i;
const PRERELEASE_LINE = /^Pre-Rift:\s*(.+)$/i;
const RELEASE_LINE = /^Release:\s*(.+)$/i;

/**
 * Riot writes a Pre-Rift window as "April 23-29, 2027" -- a same-month day
 * range with no space around the inner hyphen, which is not a shape
 * parseCandidateDateText's RANGE_SPLIT recognises (it requires a spaced
 * hyphen, on purpose, so it never misreads "2026-07-25"). Rewriting it into a
 * form RANGE_SPLIT already handles is simpler than teaching the shared parser
 * a format only this one source uses.
 */
const SAME_MONTH_DAY_RANGE = /^([A-Za-z]+)\s+(\d{1,2})\s*-\s*(\d{1,2}),\s*(\d{4})$/;

function parsePreRiftDate(raw: string): CandidateDate {
  const text = raw.trim().replace(/\s+/g, " ");
  const match = SAME_MONTH_DAY_RANGE.exec(text);
  if (!match) return parseCandidateDateText(text);
  const [, month, startDay, endDay, year] = match;
  return parseCandidateDateText(`${month} ${startDay}, ${year} - ${month} ${endDay}, ${year}`);
}

/** "The Reckoning" -> "the-reckoning", for an external id that reads sensibly next to the article slug. */
function slugifyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function parseArticle(args: { slug: string; html: string; url: string; fetchedAt: Date }): Candidate[] {
  const { slug, html, url, fetchedAt } = args;
  const $ = cheerio.load(html);
  const candidates: Candidate[] = [];

  $("h2").each((_, heading) => {
    const headingText = $(heading).text().replace(/\s+/g, " ").trim();
    const match = SET_HEADING.exec(headingText);
    if (!match) return;

    const name = match[1].trim();
    // A row whose name is a placeholder is a reserved slot, not a product --
    // same rule mediawiki.ts applies to a wiki's own "TBA" rows, and the same
    // reason: refusing it here is what stops it becoming an identity key.
    if (isPlaceholderName(name)) return;

    // Everything between this heading and the next h2 is this set's section,
    // regardless of how many <h3> subsections and paragraphs sit in between.
    // Collected into plain text first, and only then scanned in an ordinary
    // loop: assigning the result variables from inside the .each() callback
    // itself defeats TypeScript's narrowing of them below (they come back
    // widened to their declared type only, never `never`, but the compiler
    // can no longer see that `releaseDate &&` actually excludes `null`).
    const liTexts: string[] = [];
    $(heading)
      .nextUntil("h2")
      .find("li")
      .each((_, li) => {
        liTexts.push($(li).text().replace(/\s+/g, " ").trim());
      });

    let code: string | null = null;
    let releaseDate: CandidateDate | null = null;
    let prereleaseDate: CandidateDate | null = null;

    for (const text of liTexts) {
      const codeMatch = CODE_LINE.exec(text);
      if (codeMatch) {
        code = codeMatch[1].trim();
        continue;
      }

      const prereleaseMatch = PRERELEASE_LINE.exec(text);
      if (prereleaseMatch) {
        prereleaseDate = parsePreRiftDate(prereleaseMatch[1]);
        continue;
      }

      const releaseMatch = RELEASE_LINE.exec(text);
      if (releaseMatch) {
        releaseDate = parseCandidateDateText(releaseMatch[1].replace(/\s*\([^)]*\)\s*$/, ""));
      }
    }

    const externalIds = { [ORIGIN]: `${slug}:${slugifyName(name)}` };
    const base = { origin: ORIGIN, game: GAME, name, code, region: "GLOBAL" as const, url };

    if (releaseDate && releaseDate.kind !== "TBD" && isWithinForwardWindow(releaseDate, fetchedAt)) {
      candidates.push({ ...base, externalIds: { ...externalIds }, date: releaseDate, type: "SHELF" });
    }
    // Unlike the shelf date, a dateless Pre-Rift is not worth an event: "this
    // set will have a Pre-Rift at some point" is not news, and every other
    // origin already covers "announced but undated" for the shelf date.
    if (prereleaseDate && prereleaseDate.kind !== "TBD" && isWithinForwardWindow(prereleaseDate, fetchedAt)) {
      candidates.push({ ...base, externalIds: { ...externalIds }, date: prereleaseDate, type: "PRERELEASE" });
    }
  });

  return candidates;
}

function decodePlayriftboundPayload(payload: RawPayloadRecord): { index: string; articles: Record<string, string> } {
  const decoded = storedPayloadSchema.safeParse(decodePayloadBody(payload));
  if (!decoded.success) {
    const issue = decoded.error.issues[0];
    throw parseErrorFor(PROVIDER_KEY, issue.path.map(String).join(".") || "body", issue.message, decoded.error);
  }
  return decoded.data;
}

/**
 * Most announcements are merch-store updates, FAQs and roadmap posts with no
 * set section at all -- that is the normal case, not drift, so there is no
 * assertion that every run must yield a candidate the way there is for the
 * Bandai and MediaWiki providers. The one thing that *is* drift is the index
 * page itself losing every article link it should have: that means the site's
 * markup changed under the selector, not that there was no news this week.
 */
function parsePlayriftbound(payload: RawPayloadRecord): Candidate[] {
  const { index, articles } = decodePlayriftboundPayload(payload);

  if (discoverArticleSlugs(index).length === 0) {
    throw parseErrorFor(PROVIDER_KEY, "index", "no announcement article links matched on the index page");
  }

  const candidates: Candidate[] = [];
  for (const [slug, html] of Object.entries(articles)) {
    candidates.push(
      ...parseArticle({ slug, html, url: `${INDEX_URL}${slug}/`, fetchedAt: payload.fetchedAt }),
    );
  }
  return candidates;
}

export const playriftboundProvider: Provider = {
  key: PROVIDER_KEY,
  origin: ORIGIN,
  tier: "OFFICIAL",
  games: [GAME],
  fetch: fetchPlayriftbound,
  parse: parsePlayriftbound,
};

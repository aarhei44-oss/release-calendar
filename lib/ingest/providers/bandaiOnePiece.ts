import * as cheerio from "cheerio";
import type { Candidate, RawPayloadRecord } from "../types";
import {
  assertPageYield,
  decodePublisherPayload,
  fetchPublisherPages,
  productSlug,
  type PageYield,
  type PublisherPageSpec,
} from "./publisherHtml";
import { isWithinForwardWindow, parseCandidateDateText } from "./shared";
import type { FetchContext, Provider } from "./types";

/**
 * Bandai's English ONE PIECE Card Game product index.
 *
 * One Piece's second origin, and its first OFFICIAL one. Until now the game had
 * tcgcsv alone, which means its dates could only publish through gate rule G3 --
 * a lone RETAILER claim that has reported the same date for seven consecutive
 * runs. A publisher stating its own street date satisfies G1 on the first run
 * it is seen. This provider and its Gundam sibling are the first OFFICIAL-tier
 * origins in the pipeline, so they are also what turns G1 from an untested
 * branch into live code.
 *
 * **The English site only, still -- but no longer for the original reason.**
 * Phases 2 and 3 held the Japanese site back because ReleaseEvents were keyed by
 * (productSet, type) and not by region, so a JP street date and a global one for
 * one product landed on a single event as two claims months apart and the gate
 * correctly read that as a G5 conflict. Phase 4 fixed that: region is part of
 * the event key now (lib/ingest/orchestrate.ts's eventGroupKey), and
 * bulbapedia.ts's Japanese expansion list went live on the strength of it.
 *
 * What still blocks www.onepiece-cardgame.com is parsing, and it is more than a
 * flag flip. The page reuses this one's class names (`.linkListColBox`,
 * `.linkListColTitle`, `.linkListColDate`) but nothing else:
 *
 *   - the release-date label is "発売日", not "Release date", so RELEASE_DATE_LABEL
 *     below cannot tell a street date from a Premium Bandai delivery month;
 *   - dates read "2026.10.03(土)" or "2026.10" -- a dotted format with a
 *     weekday in kana, and a bare month for a month-granularity release. Neither
 *     reaches parseCandidateDateText, and both have to keep their granularity
 *     (see the note below on why the `datetime` attribute is not read);
 *   - set codes are printed in full-width brackets, 【EB-05】, so TITLE_CODE
 *     misses them -- and that regex is the accessory filter, so getting it wrong
 *     fills the calendar with playmats at OFFICIAL tier;
 *   - product names are Japanese, so a JP-only product would appear on an
 *     English calendar under a Japanese name, which is a display decision that
 *     wants making deliberately rather than by accident.
 *
 * Three new parsing rules and a display decision is a provider of its own, not a
 * spec entry, so it is left for a later phase. The same applies to
 * www.gundam-gcg.com; see bandaiGundam.ts.
 */

const PROVIDER_KEY = "bandai-onepiece";
const GAME = "one-piece-tcg";
const BASE_URL = "https://en.onepiece-cardgame.com/products/";

/**
 * The first three pages of the product index.
 *
 * The list is ordered newest-announcement-first, twelve products to a page, and
 * on 2026-09-04 three pages reached back to a June 2026 release -- just past the
 * ninety-day forward window everything downstream filters on. Fetching further
 * would cost eighteen requests to read rows that are then discarded. Fetching
 * fewer would risk missing a near-future product announced a while ago, since
 * the ordering is by announcement rather than by release date.
 */
export const ONE_PIECE_PAGES: readonly PublisherPageSpec[] = [
  { key: "op-products-1", url: `${BASE_URL}?page=1` },
  { key: "op-products-2", url: `${BASE_URL}?page=2` },
  { key: "op-products-3", url: `${BASE_URL}?page=3` },
];

/**
 * The label Bandai puts beside a date it is willing to call a street date.
 *
 * The other label on this page is "Delivery Month", used for Premium Bandai
 * mail-order exclusives -- that is when a pre-order ships to the person who
 * bought it, not when a product reaches shelves, and it is stated as a month
 * rather than a day. Treating the two as the same thing would put a mail-order
 * fulfilment window on the calendar as a release, and would do it at OFFICIAL
 * tier where a single claim publishes unopposed.
 */
const RELEASE_DATE_LABEL = "release date";

/** "EXTRA BOOSTER -ONE PIECE HEROINES EDITION vol.2- [EB-05]" -> "EB-05". */
const TITLE_CODE = /\[([^\]]{1,16})\]\s*$/;

function parseOnePiece(payload: RawPayloadRecord): Candidate[] {
  const pages = decodePublisherPayload(PROVIDER_KEY, payload);
  const candidates: Candidate[] = [];
  const totals: PageYield = { rows: 0, dated: 0 };

  for (const spec of ONE_PIECE_PAGES) {
    const html = pages[spec.key];
    // A page missing from the payload is not fatal: a replay of a payload
    // captured when the list was shorter looks exactly like this.
    if (html === undefined) continue;

    const $ = cheerio.load(html);

    $(".linkListColBox").each((_, element) => {
      const $row = $(element);
      const rawTitle = $row.find(".linkListColTitle").first().text().replace(/\s+/g, " ").trim();
      if (!rawTitle) return;
      totals.rows += 1;

      const $date = $row.find(".linkListColDate").first();
      const $time = $date.find("time").first();
      if ($time.length === 0) return;
      totals.dated += 1;

      const label = $date.find(".head").first().text().replace(/\s+/g, " ").trim().toLowerCase();
      if (label !== RELEASE_DATE_LABEL) return;

      // The visible text, not the `datetime` attribute. Bandai fills the
      // attribute with the first of the month for a month-granularity release
      // ("October 2026" carries datetime="2026-10-01"), so reading the attribute
      // would silently promote "some time in October" to "October 1st" -- an
      // OFFICIAL-tier exact date that nothing else in the pipeline could
      // contradict. The rendered text keeps the granularity the publisher meant.
      const date = parseCandidateDateText($time.text());
      if (date.kind === "TBD") return;
      if (!isWithinForwardWindow(date, payload.fetchedAt)) return;

      // A bracketed set code is what separates a card product from an
      // accessory on this page: Bandai prints one on every booster, deck and
      // premium collection, and on no playmat, sleeve or storage box. Without
      // this filter the calendar fills with merchandise -- and at OFFICIAL tier
      // it would fill immediately, since rule G1 publishes a lone official claim
      // with nothing to corroborate or contradict it. It also guarantees every
      // candidate here carries the key that pairs it with the retailer's row.
      const codeMatch = TITLE_CODE.exec(rawTitle);
      if (!codeMatch) return;
      const code = codeMatch[1].trim();
      // The bracketed code is dropped from the display name: it is carried on
      // `code`, where identity resolution reads it, and repeating it in the name
      // is noise on the calendar.
      const name = rawTitle.slice(0, codeMatch.index).trim() || rawTitle;

      const href = $row.find("a").first().attr("href");
      const slug = productSlug(href, spec.url);

      candidates.push({
        origin: "bandai-official",
        game: GAME,
        // Namespaced by game: one Bandai origin covers two card games, and
        // SetIdentity is unique on (origin, externalId), so "st11" alone would
        // collide across them.
        externalIds: slug ? { "bandai-official": `onepiece:${slug}` } : {},
        name,
        code,
        date,
        region: "GLOBAL",
        type: "SHELF",
        url: href ? new URL(href, spec.url).toString() : spec.url,
      });
    });
  }

  assertPageYield(PROVIDER_KEY, totals);
  return candidates;
}

export const bandaiOnePieceProvider: Provider = {
  key: PROVIDER_KEY,
  origin: "bandai-official",
  tier: "OFFICIAL",
  games: [GAME],
  fetch: (ctx: FetchContext) => fetchPublisherPages(PROVIDER_KEY, ONE_PIECE_PAGES, ctx),
  parse: parseOnePiece,
};

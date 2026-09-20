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
 * Bandai's English DIGIMON CARD GAME product index (world.digimoncard.com).
 *
 * Digimon's second origin and its first OFFICIAL one -- the same reasoning as
 * bandaiGundam.ts: without it the game has tcgcsv alone and every date waits
 * out gate rule G3's seven-run retailer streak, where an OFFICIAL claim
 * publishes under G1 on first sight.
 *
 * This is the friendliest of the Bandai pages. It is one page, one `<article>`
 * per product, and each article states everything Parse needs: a genre
 * (`genre-pack` / `genre-deck` / `genre-premium` / `genre-goods`), a title
 * ending in the set code in brackets, and a `dl.release` per date. Unlike Union
 * Arena there is no detail page to fetch for the code.
 *
 * Boosters can carry two dates -- "Pre-Release date" and "Release date" -- and
 * both are real, stated by the publisher: BT-26 pre-releases Friday
 * 2026-08-28 and ships Friday 2026-09-04. The first becomes a PRERELEASE event
 * (the schedule table in ../prerelease.ts deliberately has no Digimon rule for
 * that reason: a computed date next to a stated one would be a second opinion
 * nobody asked for, and starter decks and EX boosters state none at all).
 *
 * Only boosters and decks are read. "Premium Bandai" items (LM-/PB- limited
 * packs and selection boxes) carry two conflicting regional dates -- a US
 * shipping date and a separate one for "other regions" -- which would put a
 * permanent G5 conflict beside tcgcsv's single date; "goods" are sleeves and
 * playmats. Both are excluded the way bandaiOnePiece.ts and bandaiGundam.ts
 * exclude anything that is not a card product.
 */

const PROVIDER_KEY = "bandai-digimon";
const GAME = "digimon-card-game";
const ORIGIN = "bandai-official";
const PAGE_URL = "https://world.digimoncard.com/products/";

export const DIGIMON_PAGES: readonly PublisherPageSpec[] = [{ key: "digimon-products", url: PAGE_URL }];

const CARD_GENRES = new Set(["pack", "deck"]);

/** "…TIMELESS BONDS [BT-26]" -> "BT-26". Anchored to the end: a name can hold other brackets. */
const TRAILING_BRACKETED_CODE = /\[([^\]]{1,16})\]\s*$/;
const GAME_PREFIX = /^DIGIMON CARD GAME\s+/i;
const PRERELEASE_LABEL = /^pre-?release date/i;
const RELEASE_LABEL = /^release date/i;

function parseDigimon(payload: RawPayloadRecord): Candidate[] {
  const pages = decodePublisherPayload(PROVIDER_KEY, payload);
  const candidates: Candidate[] = [];
  const totals: PageYield = { rows: 0, dated: 0 };

  for (const spec of DIGIMON_PAGES) {
    const html = pages[spec.key];
    if (html === undefined) continue;

    const $ = cheerio.load(html);
    // "DIGIMON CARD GAME<br>PREMIUM ..." would otherwise glue two words together.
    $("br").replaceWith(" ");

    $("article[data-url]").each((_, element) => {
      const $article = $(element);

      const genreClass = ($article.find(".genrename").first().attr("class") ?? "").match(/genre-(\w+)/)?.[1];
      if (!genreClass || !CARD_GENRES.has(genreClass)) return;

      const title = $article.find(".prodname").first().text().replace(/\s+/g, " ").trim();
      if (!title) return;
      totals.rows += 1;

      let releaseText = "";
      let prereleaseText = "";
      $article.find("dl.release").each((__, dl) => {
        const label = $(dl).find("dt").first().text().replace(/\s+/g, " ").trim();
        const value = $(dl).find("dd").first().text().replace(/\s+/g, " ").trim();
        if (PRERELEASE_LABEL.test(label)) prereleaseText = value;
        else if (RELEASE_LABEL.test(label)) releaseText = value;
      });
      if (!releaseText) return;
      totals.dated += 1;

      const codeMatch = TRAILING_BRACKETED_CODE.exec(title);
      // Every booster and deck prints its code; a title without one is a
      // product shape this parser has not seen, and a code-less claim cannot be
      // paired with the retailer's row for the same set.
      if (!codeMatch) return;
      const code = codeMatch[1].trim();
      const name = title.slice(0, codeMatch.index).replace(GAME_PREFIX, "").trim();
      if (!name) return;

      const href = $article.attr("data-url");
      const slug = productSlug(href, spec.url);
      const url = href ? new URL(href, spec.url).toString() : spec.url;
      const externalIds: Record<string, string> = slug ? { [ORIGIN]: `digimon:${genreClass}/${slug}` } : {};
      const base = {
        origin: ORIGIN,
        game: GAME,
        externalIds,
        name,
        code,
        region: "GLOBAL" as const,
        url,
      };

      const date = parseCandidateDateText(releaseText);
      if (date.kind !== "TBD" && isWithinForwardWindow(date, payload.fetchedAt)) {
        candidates.push({ ...base, externalIds: { ...base.externalIds }, date, type: "SHELF" });
      }

      // Unlike the street date, a dateless prerelease is not worth an event.
      if (prereleaseText) {
        const prerelease = parseCandidateDateText(prereleaseText);
        if (prerelease.kind !== "TBD" && isWithinForwardWindow(prerelease, payload.fetchedAt)) {
          candidates.push({ ...base, externalIds: { ...base.externalIds }, date: prerelease, type: "PRERELEASE" });
        }
      }
    });
  }

  assertPageYield(PROVIDER_KEY, totals);
  return candidates;
}

export const bandaiDigimonProvider: Provider = {
  key: PROVIDER_KEY,
  origin: ORIGIN,
  tier: "OFFICIAL",
  games: [GAME],
  fetch: (ctx: FetchContext) => fetchPublisherPages(PROVIDER_KEY, DIGIMON_PAGES, ctx),
  parse: parseDigimon,
};

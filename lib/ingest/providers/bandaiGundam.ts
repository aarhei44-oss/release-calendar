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
 * Bandai's English GUNDAM CARD GAME product index.
 *
 * Gundam's second origin and its first OFFICIAL one, for exactly the reasons
 * set out at the top of bandaiOnePiece.ts: without it the game has tcgcsv alone
 * and every date has to wait out gate rule G3's seven-run retailer streak, where
 * an OFFICIAL claim publishes under G1 on first sight.
 *
 * English site only, and for the same modelling reason -- ReleaseEvent is keyed
 * by (productSet, type) and not by region, so a Japanese street date beside a
 * global one would be a permanent G5 conflict rather than two events.
 *
 * One page, four kinds of product block. The blocks share their inner class
 * names (.title, .number, .date) but not their containers, because the page
 * lays starter decks out as a hero carousel, boosters as a second carousel, and
 * accessories as two grids. Selecting the containers by name is verbose but it
 * is the honest description of the page; a positional selector would start
 * reading a navigation element the first time a section moved.
 */

const PROVIDER_KEY = "bandai-gundam";
const GAME = "gundam-card-game";
const PAGE_URL = "https://www.gundam-gcg.com/en/products/";

export const GUNDAM_PAGES: readonly PublisherPageSpec[] = [{ key: "gundam-products", url: PAGE_URL }];

/**
 * The four product-block containers, in the order the page presents them.
 *
 * `.mvBox` is the starter-deck carousel, `.boosterMvCol` the booster carousel,
 * and `.detailBox` covers both accessory grids (which are themselves anchors
 * rather than containing one).
 */
const PRODUCT_BLOCKS = [".mvBox", ".boosterMvCol", ".detailBox"] as const;

/** "[ST14]" -> "ST14", and "…-Mobile Suit Gundam IRON-BLOODED ORPHANS- [PC01A]" -> "PC01A". */
const BRACKETED_CODE = /\[([^\]]{1,16})\]/;
const TRAILING_BRACKETED_CODE = /\[([^\]]{1,16})\]\s*$/;

function parseGundam(payload: RawPayloadRecord): Candidate[] {
  const pages = decodePublisherPayload(PROVIDER_KEY, payload);
  const candidates: Candidate[] = [];
  const totals: PageYield = { rows: 0, dated: 0 };
  const seen = new Set<string>();

  for (const spec of GUNDAM_PAGES) {
    const html = pages[spec.key];
    if (html === undefined) continue;

    const $ = cheerio.load(html);
    // Line breaks inside a title ("Premium Card Collection <br>GUNDAM ASSEMBLE
    // Set <br><span>-…-</span>") would otherwise glue two words together.
    $("br").replaceWith(" ");

    for (const selector of PRODUCT_BLOCKS) {
      $(selector).each((_, element) => {
        const $block = $(element);
        const title = $block.find(".title").first().text().replace(/\s+/g, " ").trim();
        if (!title) return;
        totals.rows += 1;

        const dateText = $block.find(".date").first().text().replace(/\s+/g, " ").trim();
        if (!dateText) return;
        totals.dated += 1;

        // "September 25,2026" appears alongside "September 25, 2026" on this
        // page; normalising the missing space is cheaper than teaching the
        // shared date parser a Bandai-specific quirk.
        const date = parseCandidateDateText(dateText.replace(/,(\S)/g, ", $1"));
        if (date.kind === "TBD") return;
        if (!isWithinForwardWindow(date, payload.fetchedAt)) return;

        // The dedicated `.number` element on the carousels, else a bracketed
        // code at the end of the title on the product grids.
        const numberText = $block.find(".number").first().text().trim();
        const codeMatch = numberText ? BRACKETED_CODE.exec(numberText) : TRAILING_BRACKETED_CODE.exec(title);
        // No code means an accessory -- a card case, sleeves, a playmat. Bandai
        // prints a set code on every card product and on none of those, and
        // ingesting them would put merchandise on the calendar immediately,
        // since at OFFICIAL tier rule G1 publishes a lone claim unopposed. It
        // also means every candidate carries the key that pairs it with the
        // retailer's row for the same product.
        if (!codeMatch) return;
        const code = codeMatch[1].trim();

        const name = numberText ? title : title.slice(0, codeMatch.index).trim() || title;

        const href = $block.is("a") ? $block.attr("href") : $block.find("a").first().attr("href");
        const slug = productSlug(href, spec.url);

        // A carousel can render a slide twice (swiper duplicates slides for its
        // infinite scroll), and a product can legitimately appear in more than
        // one block -- a booster that is also promoted in the hero. Emitting it
        // twice would put two claims from one origin on one event, which changes
        // no gate verdict (the gate reasons per origin) but does make the run
        // diff overstate how much evidence arrived.
        const fingerprint = `${slug ?? ""}|${code}|${name}`;
        if (seen.has(fingerprint)) return;
        seen.add(fingerprint);

        candidates.push({
          origin: "bandai-official",
          game: GAME,
          externalIds: slug ? { "bandai-official": `gundam:${slug}` } : {},
          name,
          code,
          date,
          region: "GLOBAL",
          type: "SHELF",
          url: href ? new URL(href, spec.url).toString() : spec.url,
        });
      });
    }
  }

  assertPageYield(PROVIDER_KEY, totals);
  return candidates;
}

export const bandaiGundamProvider: Provider = {
  key: PROVIDER_KEY,
  origin: "bandai-official",
  tier: "OFFICIAL",
  games: [GAME],
  fetch: (ctx: FetchContext) => fetchPublisherPages(PROVIDER_KEY, GUNDAM_PAGES, ctx),
  parse: parseGundam,
};

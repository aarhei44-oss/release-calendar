import * as cheerio from "cheerio";
import { z } from "zod";
import { decodeValidators, encodeValidators, fetchConditional } from "../fetch";
import { decodePayloadBody } from "../normalize";
import type { Candidate, RawPayloadRecord } from "../types";
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
 * Bandai's English UNION ARENA product index -- Union Arena's introduction to
 * the pipeline, and its first (and so far only) origin.
 *
 * Union Arena is a Bandai game, built from the same publisher template as
 * bandaiOnePiece.ts and bandaiGundam.ts, but its product index splits what
 * those two put in one field into two: `/na/products/` lists every booster
 * and starter deck's name, category and release date, but never its set code
 * -- the code (e.g. "UE28BT") only appears on the product's own detail page,
 * in the `<h1>`'s bracketed suffix. So unlike the other two Bandai providers,
 * this one is a two-phase fetch like playriftbound.ts: read the index, then
 * fetch every upcoming product's detail page for the one field the index
 * doesn't carry, before Parse ever runs. tcgcsv's `abbreviation` field for
 * this game's TCGplayer category (81) already matches this code format
 * exactly (spot-checked 2026-09-05: "UE24BT", "UE24ST", "UEX07BT" appear on
 * both sides), so paying for the extra fetch is what lets identity.ts's code
 * tier pair this origin with tcgcsv at all -- without it, every candidate here
 * would fall to a name-only match against a retailer listing titled
 * "UE24BT: Re:ZERO -Starting Life in Another World-", which is a materially
 * weaker guarantee.
 *
 * The index separates its catalogue into two sections, "COMING SOON" and
 * "AVAILABLE NOW" (`<h3 id="comingsoon">` / `<h3 id="availablenow">`, plain
 * siblings of the `<ul class="productsBox">` that follows each). Only the
 * first is read. That is a politeness choice, not a correctness shortcut: the
 * archive section runs to several dozen already-shipped products, none of
 * which this pipeline needs, and reading a publisher's site for rows it is
 * going to throw away on every run is exactly the churn the whole v2 rebuild
 * exists to avoid (see ingest-v2-plan.md's "Why"). The tradeoff is a product
 * that ships without ever appearing in COMING SOON during a scan window would
 * be missed -- accepted as a real but narrow gap, the same way playriftbound
 * accepts that a product only ever announced off-page would be missed.
 *
 * Each row in that section carries `data-tags` naming both its category
 * ("boosters", "decks", or "other") and a short franchise tag ("DGM", "UPD");
 * "other" is merchandise (playmats, sleeves, anniversary sets) and is
 * excluded the same way bandaiOnePiece.ts and bandaiGundam.ts exclude
 * anything with no bracketed code -- doubly so here, since a code is fetched
 * separately anyway and an accessory's detail page simply won't have one.
 */

const PROVIDER_KEY = "bandai-unionarena";
const GAME = "union-arena-tcg";
const ORIGIN = "bandai-official";
const BASE_URL = "https://www.unionarena-tcg.com";
const INDEX_URL = `${BASE_URL}/na/products/`;

// ---------------------------------------------------------------------------
// Shared index reading -- used by both Fetch (to know what to request) and
// Parse (to re-derive the same rows as a drift check, per playriftbound.ts's
// pattern).
// ---------------------------------------------------------------------------

type ComingSoonItem = {
  /** "boosters/dgm-1" -- the category segment is part of the key because Bandai
   * reuses one franchise slug across both folders (a booster and a starter
   * deck for the same franchise can both be "upd-1"). */
  key: string;
  href: string;
  /** The franchise-name line of the two-line title ("Booster Pack" / franchise), read from the page's own line break rather than assumed to be second. */
  name: string;
  dateText: string;
};

/** "/na/products/boosters/dgm-1.php" -> "boosters/dgm-1". Absolute or relative; extension-agnostic. */
function productPath(href: string, pageUrl: string): string | null {
  let pathname: string;
  try {
    pathname = new URL(href, pageUrl).pathname;
  } catch {
    return null;
  }
  const segments = pathname.split("/").filter(Boolean);
  const file = segments.pop();
  const category = segments.pop();
  if (!file || !category) return null;
  const slug = file.replace(/\.[a-z0-9]+$/i, "").trim();
  return slug ? `${category}/${slug}` : null;
}

const RELEASE_DATE_LABEL = /^release date$/i;

/** Every boosters/decks row in the COMING SOON section, with the index's own name and date text -- everything Parse needs except the code. */
function discoverComingSoonProducts(indexHtml: string): ComingSoonItem[] {
  const $ = cheerio.load(indexHtml);
  // The two-line title ("Booster Pack<br>D.Gray-man") glues into one word
  // without this, the same problem bandaiGundam.ts's carousel titles have.
  $("br").replaceWith("\n");

  const items: ComingSoonItem[] = [];

  $("h3#comingsoon")
    .nextUntil("h3")
    .find("li.productsDetail")
    .each((_, element) => {
      const $item = $(element);
      const tags = ($item.attr("data-tags") ?? "").split(",").map((tag) => tag.trim().toLowerCase());
      if (!tags.includes("boosters") && !tags.includes("decks")) return;

      const href = $item.find("a").first().attr("href");
      if (!href) return;
      const key = productPath(href, INDEX_URL);
      if (!key) return;

      const titleLines = $item
        .find(".js_productsTit")
        .first()
        .text()
        .split("\n")
        .map((line) => line.replace(/\s+/g, " ").trim())
        .filter(Boolean);
      // The category line ("Booster Pack") is dropped in favour of the
      // franchise line, matching how bandaiGundam.ts's carousel reads only
      // `.title` and leaves its sibling `.category` field unused.
      const name = titleLines[1] ?? titleLines[0] ?? "";
      if (!name) return;

      const $date = $item.find(".productsDate").first();
      const label = $date.find(".productsHeadTit").first().text().trim();
      const dateText = RELEASE_DATE_LABEL.test(label)
        ? $date.text().replace(label, "").replace(/\s+/g, " ").trim()
        : "";

      items.push({ key, href, name, dateText });
    });

  return items;
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

/** What this provider stores: the index page plus every upcoming product's detail page, one payload per run. */
const storedPayloadSchema = z.object({
  index: z.string(),
  products: z.record(z.string(), z.string()),
});

export async function fetchBandaiUnionArena(ctx: FetchContext): Promise<RawPayloadRecord> {
  try {
    const indexResult = await fetchConditional({
      url: INDEX_URL,
      fetch: ctx.fetch,
      signal: ctx.signal,
      accept: "text/html,application/xhtml+xml",
      validators: decodeValidators(ctx.etag),
    });
    if (indexResult.kind === "not-modified") {
      throw new Error("unexpected 304 for the products index");
    }

    const products: Record<string, string> = {};
    for (const item of discoverComingSoonProducts(indexResult.body)) {
      const result = await fetchConditional({
        url: new URL(item.href, INDEX_URL).toString(),
        fetch: ctx.fetch,
        signal: ctx.signal,
        accept: "text/html,application/xhtml+xml",
        validators: decodeValidators(ctx.etag),
      });
      if (result.kind === "not-modified") continue;
      products[item.key] = result.body;
    }

    const payload = okPayload({
      scanRunId: ctx.scanRunId,
      providerKey: PROVIDER_KEY,
      value: { index: indexResult.body, products },
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

/** The product page's own `<h1>`: `<span class="pageTitSubTxt">UNION ARENA BOOSTER PACK </span><p class="pageTit"> D.Gray-man [UE28BT]</p>`. */
const CODE_SUFFIX = /\[([A-Z0-9-]{3,12})\]\s*$/;

function extractCode(detailHtml: string): string | null {
  const $ = cheerio.load(detailHtml);
  const heading = $("h1#sec0").first();
  const text = `${heading.find(".pageTitSubTxt").text()} ${heading.find(".pageTit").text()}`
    .replace(/\s+/g, " ")
    .trim();
  return CODE_SUFFIX.exec(text)?.[1] ?? null;
}

function decodeBandaiUnionArenaPayload(payload: RawPayloadRecord): { index: string; products: Record<string, string> } {
  const decoded = storedPayloadSchema.safeParse(decodePayloadBody(payload));
  if (!decoded.success) {
    const issue = decoded.error.issues[0];
    throw parseErrorFor(PROVIDER_KEY, issue.path.map(String).join(".") || "body", issue.message, decoded.error);
  }
  return decoded.data;
}

function parseBandaiUnionArena(payload: RawPayloadRecord): Candidate[] {
  const { index, products } = decodeBandaiUnionArenaPayload(payload);
  const items = discoverComingSoonProducts(index);

  // The one thing that is drift, not a quiet week: COMING SOON going empty
  // means the section was renamed or restructured out from under the
  // selector, since Bandai always has something in its pipeline.
  if (items.length === 0) {
    throw parseErrorFor(PROVIDER_KEY, "index", "no booster/deck rows found in the COMING SOON section");
  }

  const candidates: Candidate[] = [];
  for (const item of items) {
    // A page missing from the payload is not fatal: a replay of a payload
    // captured when this product hadn't been fetched yet (or had 304'd) looks
    // exactly like this.
    const detailHtml = products[item.key];
    if (detailHtml === undefined) continue;

    // Same role as the bracketed-code check in bandaiOnePiece.ts and
    // bandaiGundam.ts: no code reached here means the detail page didn't
    // carry the expected heading shape, which for a real booster/deck page
    // shouldn't happen -- this is the accessory filter's Union Arena form.
    const code = extractCode(detailHtml);
    if (!code) continue;

    if (!item.dateText) continue;
    const date = parseCandidateDateText(item.dateText);
    if (date.kind === "TBD") continue;
    if (!isWithinForwardWindow(date, payload.fetchedAt)) continue;

    candidates.push({
      origin: ORIGIN,
      game: GAME,
      externalIds: { [ORIGIN]: `unionarena:${item.key}` },
      name: item.name,
      code,
      date,
      region: "GLOBAL",
      type: "SHELF",
      url: new URL(item.href, INDEX_URL).toString(),
    });
  }

  return candidates;
}

export const bandaiUnionArenaProvider: Provider = {
  key: PROVIDER_KEY,
  origin: ORIGIN,
  tier: "OFFICIAL",
  games: [GAME],
  fetch: fetchBandaiUnionArena,
  parse: parseBandaiUnionArena,
};

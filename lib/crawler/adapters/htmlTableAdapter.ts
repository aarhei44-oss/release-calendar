import * as cheerio from "cheerio";
import type { Element } from "domhandler";
import type { ReleaseEventType, Region } from "@/app/generated/prisma/client";
import { parseFlexibleDate } from "../dateParsing";
import { fetchWithRetry } from "../httpFetch";
import type { ParserAdapter, ParsedCandidate, RawFetchResult, SourceConfig } from "./types";

type HtmlTableOptions = {
  /** Case-insensitive substring(s) to find the product-name column header. Tried in order. */
  nameColumnHints?: string[];
  /** Case-insensitive substring(s) to find the release-date column header. Tried in order. */
  dateColumnHints?: string[];
  /** Case-insensitive substring(s) to find an optional set-description column header. Tried in order; sources without such a column simply yield no description. */
  descriptionColumnHints?: string[];
  codePrefix?: string;
  eventType?: ReleaseEventType;
  region?: Region;
  /**
   * Case-insensitive trailing text to strip from the parsed name (tried in
   * order, first match wins) -- for sources whose name cell has known
   * site-chrome glued onto the real product name by cellText's inserted
   * separator, e.g. yugiohcardlist.com's name link is followed by a nested
   * "card list · prices" sublink pair with no space in the source markup,
   * which cellText correctly renders as "Magnificent Maestros card list ·
   * prices" rather than silently swallowing it -- that text is real (it
   * came from the page), just not part of the product's name. Left in,
   * it's not just a cosmetic wart: the boilerplate suffix is identical
   * across every row from a chrome-heavy source, so it inflates
   * dedup.ts's fuzzy name-similarity score for every pair drawn from that
   * source, enough to wrongly merge unrelated products (e.g. "Abyss
   * Rising" into "Rage of the Abyss") purely on the strength of the shared
   * chrome text they both carry.
   */
  nameStripSuffixes?: string[];
};

const DEFAULT_NAME_HINTS = ["name", "set"];
const DEFAULT_DATE_HINTS = ["release date", "en release", "release"];
const DEFAULT_DESCRIPTION_HINTS = ["details", "description", "notes", "summary"];

/**
 * Generic adapter for MediaWiki-style (and similarly shaped) HTML data
 * tables: scans every <table> on the page, matches a name column and a
 * release-date column by header text (not position, since column count and
 * order vary between tables/sites), and emits one candidate per data row.
 * Reused across installs via each source config's `options`, rather than
 * writing a bespoke adapter per TCG.
 */
export const htmlTableAdapter: ParserAdapter = {
  key: "html-table",

  async fetch(config: SourceConfig): Promise<RawFetchResult> {
    const response = await fetchWithRetry(config.url);
    const html = await response.text();
    return { url: config.url, status: response.status, html, fetchedAt: new Date() };
  },

  parse(raw: RawFetchResult, config: SourceConfig): ParsedCandidate[] {
    const options = (config.options ?? {}) as HtmlTableOptions;
    const nameHints = (options.nameColumnHints ?? DEFAULT_NAME_HINTS).map((h) => h.toLowerCase());
    const dateHints = (options.dateColumnHints ?? DEFAULT_DATE_HINTS).map((h) => h.toLowerCase());
    const descriptionHints = (options.descriptionColumnHints ?? DEFAULT_DESCRIPTION_HINTS).map((h) =>
      h.toLowerCase(),
    );
    const eventType = options.eventType ?? "SHELF";
    const region = options.region ?? "GLOBAL";
    const codePrefix = options.codePrefix ?? "SET";

    const $ = cheerio.load(raw.html);
    const candidates: ParsedCandidate[] = [];

    $("table").each((_, table) => {
      const rows = $(table).find("tr").toArray();
      if (rows.length < 2) return;

      const headerCells = $(rows[0])
        .find("th,td")
        .toArray()
        .map((cell) => cellText($, cell).toLowerCase());

      // Real set-list tables always have a distinct name column and date
      // column. A single-cell "header" (e.g. a Wikipedia navbox caption row
      // like "...Releases that are entirely composed of prints from other
      // releases are small.") can accidentally contain both a "set" and a
      // "release" substring and match both hints against that one column,
      // turning every row's caption/summary text into a garbage
      // productSetName -- reject that instead of emitting bad candidates.
      if (headerCells.length < 2) return;

      const nameColIdx = findColumn(headerCells, nameHints);
      const dateColIdx = findColumn(headerCells, dateHints);
      if (nameColIdx === -1 || dateColIdx === -1 || nameColIdx === dateColIdx) return;

      let descriptionColIdx = findColumn(headerCells, descriptionHints);
      if (descriptionColIdx === nameColIdx || descriptionColIdx === dateColIdx) descriptionColIdx = -1;

      for (const row of rows.slice(1)) {
        const cells = $(row)
          .find("td")
          .toArray()
          .map((cell) => cellText($, cell));
        if (cells.length <= Math.max(nameColIdx, dateColIdx)) continue;

        const name = stripKnownSuffix(cells[nameColIdx], options.nameStripSuffixes);
        const dateText = cells[dateColIdx];
        if (!name) continue;

        const parsedDate = parseFlexibleDate(dateText ?? "");
        const description =
          descriptionColIdx !== -1 && cells.length > descriptionColIdx ? cells[descriptionColIdx] : "";

        candidates.push({
          productSetCode: `${codePrefix}-${slugify(name)}`,
          productSetName: name,
          ...(description ? { description } : {}),
          eventType,
          region,
          ...parsedDate,
        });
      }
    });

    return candidates;
  },
};

/**
 * Tiered so a hint like "release date" prefers an exact/prefix match over a
 * loose substring one -- "Pre-release date" contains "release date" as a
 * substring, and would otherwise be picked ahead of the actual "Release
 * date" column.
 */
function findColumn(headers: string[], hints: string[]): number {
  for (const hint of hints) {
    const idx = headers.findIndex((h) => h === hint);
    if (idx !== -1) return idx;
  }
  for (const hint of hints) {
    const idx = headers.findIndex((h) => h.startsWith(hint));
    if (idx !== -1) return idx;
  }
  for (const hint of hints) {
    const idx = headers.findIndex((h) => h.includes(hint));
    if (idx !== -1) return idx;
  }
  return -1;
}

function cleanText(text: string): string {
  return text.replace(/\[\d+\]/g, "").replace(/\s+/g, " ").trim();
}

/**
 * A cell's text, with a space forced between its direct children before
 * cheerio's own `.text()` concatenates them. Plain `$(cell).text()` glues
 * adjacent child elements with no separator at all when the source markup
 * has no whitespace between them (e.g. yugiohcardlist.com's
 * `<a>Set Name</a><span>card list</span>`, which `.text()` alone renders as
 * "Set Namecard list") -- besides being cosmetically wrong, a glued-on
 * trailing word can absorb a real token (e.g. a sequence number: "Pack
 * 25card" is no longer recognized as ending in the standalone number "25"),
 * which is exactly what dedup.ts's fuzzy-match number veto relies on to
 * keep sequential releases like "Pack 25" and "Pack 30" apart. Splitting on
 * direct children rather than just text nodes also fixes the same glued-text
 * artifact called out on Bulbapedia's Japanese name cells in seed.ts.
 */
function cellText($: cheerio.CheerioAPI, cell: Element): string {
  const parts = $(cell)
    .contents()
    .toArray()
    .map((node) => $(node).text());
  return cleanText(parts.join(" "));
}

function stripKnownSuffix(name: string, suffixes?: string[]): string {
  if (!suffixes) return name;
  for (const suffix of suffixes) {
    if (name.toLowerCase().endsWith(suffix.toLowerCase())) {
      return name.slice(0, name.length - suffix.length).trim();
    }
  }
  return name;
}

function slugify(text: string): string {
  return text
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

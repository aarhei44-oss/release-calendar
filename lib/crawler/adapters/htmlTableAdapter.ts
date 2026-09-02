import * as cheerio from "cheerio";
import type { ReleaseEventType, Region } from "@/app/generated/prisma/client";
import { parseFlexibleDate } from "../dateParsing";
import type { ParserAdapter, ParsedCandidate, RawFetchResult, SourceConfig } from "./types";

type HtmlTableOptions = {
  /** Case-insensitive substring(s) to find the product-name column header. Tried in order. */
  nameColumnHints?: string[];
  /** Case-insensitive substring(s) to find the release-date column header. Tried in order. */
  dateColumnHints?: string[];
  codePrefix?: string;
  eventType?: ReleaseEventType;
  region?: Region;
};

const DEFAULT_NAME_HINTS = ["name", "set"];
const DEFAULT_DATE_HINTS = ["release date", "en release", "release"];

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
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(config.url, {
        signal: controller.signal,
        headers: { "User-Agent": "release-watcher-crawler/1.0 (self-hosted TCG calendar)" },
      });
      const html = await response.text();
      return { url: config.url, status: response.status, html, fetchedAt: new Date() };
    } finally {
      clearTimeout(timeout);
    }
  },

  parse(raw: RawFetchResult, config: SourceConfig): ParsedCandidate[] {
    const options = (config.options ?? {}) as HtmlTableOptions;
    const nameHints = (options.nameColumnHints ?? DEFAULT_NAME_HINTS).map((h) => h.toLowerCase());
    const dateHints = (options.dateColumnHints ?? DEFAULT_DATE_HINTS).map((h) => h.toLowerCase());
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
        .map((cell) => cleanText($(cell).text()).toLowerCase());

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

      for (const row of rows.slice(1)) {
        const cells = $(row)
          .find("td")
          .toArray()
          .map((cell) => cleanText($(cell).text()));
        if (cells.length <= Math.max(nameColIdx, dateColIdx)) continue;

        const name = cells[nameColIdx];
        const dateText = cells[dateColIdx];
        if (!name) continue;

        const parsedDate = parseFlexibleDate(dateText ?? "");

        candidates.push({
          productSetCode: `${codePrefix}-${slugify(name)}`,
          productSetName: name,
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

function slugify(text: string): string {
  return text
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

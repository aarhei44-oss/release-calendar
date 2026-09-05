import * as cheerio from "cheerio";
import { z } from "zod";
import type { Region } from "@/app/generated/prisma/client";
import { decodeValidators, encodeValidators, fetchConditional } from "../fetch";
import { isPlaceholderName } from "../identity";
import { decodePayloadBody } from "../normalize";
import type { Candidate, Origin, RawPayloadRecord } from "../types";
import {
  failedPayload,
  isWithinForwardWindow,
  notModifiedPayload,
  okPayload,
  parseCandidateDateText,
  parseErrorFor,
} from "./shared";
import type { FetchContext } from "./types";

/**
 * Shared machinery for the two MediaWiki-backed providers (Wikipedia and
 * Bulbapedia).
 *
 * **The API, never the rendered page.** `action=parse&prop=text` is an
 * explicitly sanctioned automated interface: it is cheap for the site, it is
 * versioned, and the HTML it returns is the article body alone rather than a
 * skin that gets redesigned. v1 scraped the rendered pages and paid for it
 * every time a skin changed. The alternative -- `prop=revisions` for raw
 * wikitext -- was considered and rejected: these set lists are built from
 * nested templates, so the wikitext of a row is frequently a template call with
 * no visible date in it, whereas the rendered table is exactly the table a
 * reader sees.
 *
 * Table selection is by *header text*, not by position or class. Both wikis
 * reorganise their pages regularly (Bulbapedia's English expansion list is 20+
 * separate tables, one per era), and an index-based selector would silently
 * start reading a navbox the first time a section moved.
 */

export type WikiPageSpec = {
  /** Stable key. Namespaces this page's external ids, so it must not be renamed casually. */
  key: string;
  /** The MediaWiki api.php endpoint. */
  apiUrl: string;
  /** Human-facing article URL, carried onto the candidates as SourceClaim.url. */
  pageUrl: string;
  /** Article title, as `action=parse&page=` wants it. */
  title: string;
  game: string;
  region: Region;
  /** Normalised header text (see normalizeHeader) identifying the set-name column. */
  nameHeaders: string[];
  /** Normalised header text for the release-date column, in priority order. */
  dateHeaders: string[];
  /** Optional set-code column; when found it becomes the candidate's code and its external id. */
  codeHeaders?: string[];
  /**
   * Optional second date column yielding a PRERELEASE event. Safe because
   * ReleaseEvents are keyed by (productSet, type, region), so a prerelease date
   * and a shelf date for the same product are two events rather than a conflict.
   */
  prereleaseDateHeaders?: string[];
  /**
   * Optional column whose wiki link identifies the product across *pages*.
   *
   * This is what joins a Japanese expansion row to the English one for the same
   * product. Both of Bulbapedia's lists link the set's own article -- the
   * English list from its name column, the Japanese list from its "English
   * equivalent" column -- and the article path is a fact the wiki publishes
   * about its own catalogue, so it belongs at identity.ts's *id* tier rather
   * than being re-guessed from two names that share half their tokens
   * ("Delta Reign" against "Mega Evolution—Delta Reign" scores 0.667, under the
   * 0.75 threshold, and lowering that threshold is exactly what the code tier
   * exists to avoid).
   *
   * `idOrigin` names the id space, not the claiming origin: it is written into
   * `externalIds` beside the page-scoped id so that both keep working, and
   * nothing in the gate reads it (gate independence is decided by
   * `Candidate.origin`).
   */
  articleLink?: { idOrigin: Origin; headers: string[] };
};

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

export function parseApiUrl(spec: WikiPageSpec): string {
  const params = new URLSearchParams({
    action: "parse",
    page: spec.title,
    prop: "text",
    format: "json",
    formatversion: "2",
  });
  return `${spec.apiUrl}?${params.toString()}`;
}

const parseResponseSchema = z.object({
  parse: z.object({
    title: z.string(),
    text: z.string(),
  }),
});

/** What a wiki provider stores: page key -> rendered HTML, one payload per run. */
const storedPayloadSchema = z.record(z.string(), z.string());

/**
 * Fetches every page in a spec list and stores them as one payload.
 *
 * `action=parse` sends neither ETag nor Last-Modified (verified 2026-09-04), so
 * conditional GET degrades to comparing the assembled content hash against the
 * one Phase 1 stored. That still skips the parse and everything downstream on
 * an unchanged day, which is where the cost is -- these pages change a handful
 * of times a year.
 */
export async function fetchWikiPages(
  providerKey: string,
  specs: readonly WikiPageSpec[],
  ctx: FetchContext,
): Promise<RawPayloadRecord> {
  try {
    const stored: Record<string, string> = {};

    for (const spec of specs) {
      const result = await fetchConditional({
        url: parseApiUrl(spec),
        fetch: ctx.fetch,
        signal: ctx.signal,
        validators: decodeValidators(ctx.etag),
      });
      // A 304 here would leave a hole in the assembled payload, and these
      // endpoints do not send validators anyway; treat it as a fetch failure
      // rather than storing a partial page set.
      if (result.kind === "not-modified") {
        throw new Error(`unexpected 304 for ${spec.title}`);
      }
      const decoded = parseResponseSchema.safeParse(JSON.parse(result.body));
      if (!decoded.success) {
        throw new Error(`${spec.title}: unexpected action=parse response shape`);
      }
      stored[spec.key] = decoded.data.parse.text;
    }

    const payload = okPayload({
      scanRunId: ctx.scanRunId,
      providerKey,
      value: stored,
      fetchedAt: ctx.now,
      etag: encodeValidators({}),
    });

    if (ctx.contentHash && ctx.contentHash === payload.contentHash) {
      return notModifiedPayload({
        scanRunId: ctx.scanRunId,
        providerKey,
        contentHash: payload.contentHash,
        fetchedAt: ctx.now,
      });
    }

    return payload;
  } catch (error) {
    return failedPayload({ scanRunId: ctx.scanRunId, providerKey, fetchedAt: ctx.now, error });
  }
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

/** Lowercased, alphanumerics only: absorbs `<br>`s, footnote markers and punctuation drift in a header. */
export function normalizeHeader(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Text that names nothing: "—", "N/a", "TBA", "?" and friends.
 *
 * These have to be recognised, not passed through, and the Magic set list shows
 * why. Its forward-looking rows carry the literal code "TBA" for every set
 * Wizards has slotted but not announced -- five of them at once on
 * 2026-09-04. Taken at face value, "TBA" becomes the identity key for five
 * different products, which fuses them into one ProductSet that no later pass
 * can safely take apart again. Exactly the failure identity.ts is built to
 * avoid, arriving through the back door.
 *
 * The *name* column needs a wider net than this -- "Unnamed Universes Beyond
 * Set" is a placeholder that no exact-match list would catch -- so name cells go
 * through identity.ts's isPlaceholderName instead, which subsumes this pattern.
 */
const PLACEHOLDER = /^(?:[—–\-?]+|n\/?a|tba|tbd|tbc|unknown|none)$/i;

function cleanCode(text: string): string | null {
  const trimmed = text.trim().replace(/^[—–-]+\s*/, "");
  if (!trimmed) return null;
  if (PLACEHOLDER.test(trimmed)) return null;
  if (trimmed.length > 16) return null;
  return trimmed.toUpperCase();
}

export function parseWikiPayload(args: {
  providerKey: string;
  origin: Origin;
  specs: readonly WikiPageSpec[];
  payload: RawPayloadRecord;
}): Candidate[] {
  const { providerKey, origin, specs, payload } = args;

  const decoded = storedPayloadSchema.safeParse(decodePayloadBody(payload));
  if (!decoded.success) {
    const issue = decoded.error.issues[0];
    throw parseErrorFor(providerKey, issue.path.map(String).join(".") || "body", issue.message, decoded.error);
  }

  const candidates: Candidate[] = [];

  for (const spec of specs) {
    const html = decoded.data[spec.key];
    // A page missing from the payload is not fatal -- a replay of an older
    // payload, or a page added since it was captured, both look like this.
    if (html === undefined) continue;
    candidates.push(...parseWikiPage({ providerKey, origin, spec, html, fetchedAt: payload.fetchedAt }));
  }

  // A page whose tables all vanished is drift, and a silent zero here is
  // exactly the failure that makes a provider look healthy while contributing
  // nothing. Fail loudly instead, so the ProviderRun goes DEGRADED and the
  // stored payload can be replayed against a fixed selector.
  if (candidates.length === 0 && specs.length > 0) {
    throw parseErrorFor(providerKey, "tables", "no set tables matched the configured headers on any page");
  }

  return candidates;
}

function parseWikiPage(args: {
  providerKey: string;
  origin: Origin;
  spec: WikiPageSpec;
  html: string;
  fetchedAt: Date;
}): Candidate[] {
  const { origin, spec, html, fetchedAt } = args;
  const $ = cheerio.load(html);

  // Footnote markers ("[3]"), edit links and the hidden sort keys sortable
  // tables carry would all otherwise land in the cell text and corrupt both the
  // header match and the parsed date.
  // Every `sup` goes, not just `sup.reference`: Wikipedia's Magic list marks
  // some of its footnotes with roman numerals in a bare `sup`, which would
  // otherwise glue "[XIX]" onto a set name and, through the code column, into
  // its identity key.
  $("sup, .mw-editsection, .sortkey, style").remove();
  $("br").replaceWith(" ");

  const candidates: Candidate[] = [];

  $("table").each((_, table) => {
    const grid = buildGrid($, $(table));
    if (grid.length < 2) return;

    const headers = grid[0].cells.map(normalizeHeader);
    if (headers.length < 2) return;

    const nameIndex = pickColumn(headers, spec.nameHeaders);
    const dateIndex = pickColumn(headers, spec.dateHeaders);
    if (nameIndex === null || dateIndex === null) return;

    const codeIndex = spec.codeHeaders ? pickColumn(headers, spec.codeHeaders) : null;
    const prereleaseIndex = spec.prereleaseDateHeaders ? pickColumn(headers, spec.prereleaseDateHeaders) : null;
    const articleIndex = spec.articleLink ? pickColumn(headers, spec.articleLink.headers) : null;

    for (const row of grid.slice(1)) {
      // A repeated header row -- Bulbapedia restates its headers between eras.
      if (row.allHeaderCells) continue;
      // A full-width banner row: one cell with a colspan across the table,
      // which the grid has copied into every column. Wikipedia's Magic tables
      // are full of them ("Mirage Block", "Commander"), and without this the
      // banner's text would be read as both a set name and a release date and
      // yield a dateless candidate for every section on the page.
      if (row.sourceCells === 1 && row.cells.length > 1) continue;

      const cellText = (index: number) => row.cells[index] ?? "";

      const name = cellText(nameIndex);
      // A row whose name is a placeholder is a reserved slot, not a product.
      // "TBA" is the obvious form; "Unnamed Universes Beyond Set" is the same
      // thing spelled out, and English Wikipedia's Magic list carries three of
      // those at once. All three also read "TBA" in the code column, so the
      // external id below is identical for all three -- they collapsed onto one
      // ProductSet carrying one contentless, dateless event.
      //
      // Refused outright rather than given a synthetic per-row id. A row index
      // would have to be stable across fetches to serve as an identity, and on
      // this page it is not: the placeholder rows are interleaved between dated
      // ones (Nauctis, unnamed, Kamigawa, unnamed, Zhalfir, unnamed), so the
      // moment one of them is announced and named, every later row shifts up
      // and three ProductSets silently re-pin onto each other's ids -- a worse
      // failure than the merge, and a permanent one. There is nothing to lose
      // by dropping them either: these rows carry no name, no code and no date,
      // so a candidate built from one says only "a set exists" without saying
      // which, when, or what it is called.
      if (isPlaceholderName(name)) continue;

      const code = codeIndex === null ? null : cleanCode(cellText(codeIndex));
      const externalId = `${spec.key}:${code ?? name}`;

      const externalIds: Record<string, string> = { [origin]: externalId };
      // A cross-page article id, when the spec asks for one. Written under its
      // own id-space key so the page-scoped id above keeps working unchanged.
      const articleId = articleIndex === null ? null : wikiArticleId(row.links[articleIndex]);
      if (articleId && spec.articleLink) externalIds[spec.articleLink.idOrigin] = articleId;

      const base = {
        origin,
        game: spec.game,
        externalIds,
        name,
        code,
        region: spec.region,
        url: spec.pageUrl,
      };

      const shelfDate = parseCandidateDateText(cellText(dateIndex));
      if (isWithinForwardWindow(shelfDate, fetchedAt)) {
        candidates.push({ ...base, externalIds: { ...externalIds }, date: shelfDate, type: "SHELF" });
      }

      if (prereleaseIndex !== null) {
        const prereleaseDate = parseCandidateDateText(cellText(prereleaseIndex));
        // Unlike the shelf row, a dateless prerelease is not worth an event:
        // "this product will have a prerelease at some point" is not news.
        if (prereleaseDate.kind !== "TBD" && isWithinForwardWindow(prereleaseDate, fetchedAt)) {
          candidates.push({ ...base, externalIds: { ...externalIds }, date: prereleaseDate, type: "PRERELEASE" });
        }
      }
    }
  });

  return candidates;
}

type GridRow = {
  cells: string[];
  /** First anchor href in each cell, for WikiPageSpec.articleLink. Parallel to `cells`. */
  links: (string | null)[];
  allHeaderCells: boolean;
  sourceCells: number;
};

/**
 * Lays a wiki table out as a rectangular grid, honouring rowspan and colspan.
 *
 * The naive version of this -- read each `<tr>`'s cells positionally -- is
 * wrong on both of these pages, in both directions. Wikipedia's Magic tables
 * merge block names down several rows with `rowspan`, which shifts every
 * following row's columns left; Riftbound's table simply omits its trailing
 * empty `<td>`s, so three genuinely future sets have six cells against a
 * seven-column header. An earlier draft skipped any row whose cell count did
 * not match, which was safe but silently discarded exactly those future rows.
 * Materialising the grid keeps them and keeps the columns aligned.
 *
 * Only the table's own rows are walked (`> tbody > tr` and friends): a nested
 * table's rows belong to that table, and `find("tr")` would hand them over.
 */
function buildGrid($: cheerio.CheerioAPI, $table: ReturnType<cheerio.CheerioAPI>): GridRow[] {
  const rows = $table.find("> tr, > tbody > tr, > thead > tr, > tfoot > tr").get();
  const grid: GridRow[] = [];
  // Cells still spanning down from an earlier row, keyed by column index.
  const pending = new Map<number, { text: string; link: string | null; remaining: number; isHeader: boolean }>();

  for (const row of rows) {
    const cells: string[] = [];
    const links: (string | null)[] = [];
    const headerFlags: boolean[] = [];
    let column = 0;
    let sourceCells = 0;

    const place = (text: string, link: string | null, isHeader: boolean) => {
      cells[column] = text;
      links[column] = link;
      headerFlags[column] = isHeader;
      column += 1;
    };

    const drainPending = () => {
      let carried = pending.get(column);
      while (carried) {
        place(carried.text, carried.link, carried.isHeader);
        carried.remaining -= 1;
        if (carried.remaining <= 0) pending.delete(column - 1);
        carried = pending.get(column);
      }
    };

    drainPending();

    for (const cell of $(row).children("th,td").get()) {
      sourceCells += 1;
      const $cell = $(cell);
      const text = $cell.text().replace(/\s+/g, " ").trim();
      const link = $cell.find("a").first().attr("href") ?? null;
      const isHeader = cell.tagName === "th";
      const colspan = Math.min(Math.max(Number($cell.attr("colspan")) || 1, 1), 20);
      const rowspan = Math.min(Math.max(Number($cell.attr("rowspan")) || 1, 1), 100);

      for (let span = 0; span < colspan; span++) {
        const at = column;
        place(text, link, isHeader);
        if (rowspan > 1) pending.set(at, { text, link, remaining: rowspan - 1, isHeader });
        drainPending();
      }
    }

    // Rows that consist only of a spanned-in cell carry no new information.
    if (cells.length === 0) continue;
    grid.push({
      cells: cells.map((value) => value ?? ""),
      links: cells.map((_, index) => links[index] ?? null),
      allHeaderCells: headerFlags.length > 0 && headerFlags.every(Boolean),
      sourceCells,
    });
  }

  return grid;
}

/**
 * The article a wiki link points at, as a stable id: "/wiki/Delta_Reign_(TCG)"
 * -> "Delta_Reign_(TCG)".
 *
 * Only canonical `/wiki/<Title>` links count. A red link is served as
 * `/w/index.php?title=...&action=edit&redlink=1` -- it means the article does
 * not exist, so it is not evidence that two rows are the same product -- and a
 * `File:` link is the row's set symbol, not the set.
 */
export function wikiArticleId(href: string | null | undefined): string | null {
  if (!href) return null;
  const match = /^(?:https?:\/\/[^/]+)?\/wiki\/([^?#]+)$/.exec(href.trim());
  if (!match) return null;
  let article: string;
  try {
    article = decodeURIComponent(match[1]);
  } catch {
    article = match[1];
  }
  if (!article) return null;
  // A namespaced page is not a product: the set-symbol and logo columns link
  // "File:" pages, and every row on a page would otherwise share one of them.
  // Matched against the namespace list rather than "contains a colon", because
  // plenty of real set articles have one ("Kamigawa: Titanbreach").
  if (NON_ARTICLE_NAMESPACE.test(article)) return null;
  return article;
}

const NON_ARTICLE_NAMESPACE =
  /^(?:file|image|media|category|template|help|special|talk|user|portal|project|mediawiki|module)\s*:/i;

/** First header matching any of `wanted`, in `wanted`'s priority order. */
function pickColumn(headers: string[], wanted: string[]): number | null {
  for (const candidate of wanted) {
    const index = headers.indexOf(candidate);
    if (index !== -1) return index;
  }
  return null;
}

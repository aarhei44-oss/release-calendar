import { z } from "zod";
import { decodeValidators, encodeValidators, fetchConditional } from "../fetch";
import { decodePayloadBody } from "../normalize";
import type { RawPayloadRecord } from "../types";
import { failedPayload, notModifiedPayload, okPayload, parseErrorFor } from "./shared";
import type { FetchContext } from "./types";

/**
 * Shared plumbing for the publisher providers -- the only ones that read an
 * ordinary web page rather than an API.
 *
 * That is a deliberate, narrow exception to the "no scraping" rule this rebuild
 * otherwise holds to, and it is worth naming why it is worth making. One Piece
 * and Gundam had exactly one origin each (tcgcsv), so under the gate their dates
 * could only ever publish via rule G3 -- a lone retailer claim that has held
 * still for seven consecutive runs. A publisher's own product page is an
 * OFFICIAL-tier primary source, which publishes immediately under G1. Four
 * publisher-owned pages is a very different proposition from twenty fan sites,
 * and it is the difference between two of our seven games being a week slow and
 * being current.
 *
 * Everything else about these providers is the same contract as the rest:
 * conditional GET through lib/ingest/fetch.ts's polite layer, the whole response
 * stored verbatim so a parser fix can be replayed against it, and a parse that
 * is a pure function of those bytes.
 */

export type PublisherPageSpec = {
  /** Stable key. Namespaces this page inside the stored payload, so it must not be renamed casually. */
  key: string;
  url: string;
};

/** What a publisher provider stores: page key -> raw HTML, one payload per run. */
const storedPayloadSchema = z.record(z.string(), z.string());

/**
 * Fetches every page in a spec list and stores them as one payload.
 *
 * Assembled into a single blob for the same reason tcgcsv's seven category
 * responses are: a 304 on one page of several would leave a hole the
 * FetchContext cannot fill, since it carries last run's *hash* and not last
 * run's body. So the whole assembled payload is compared by content hash
 * instead, which still skips Normalize and everything downstream on an
 * unchanged day -- which is most days, for pages that change when a product is
 * announced.
 */
export async function fetchPublisherPages(
  providerKey: string,
  specs: readonly PublisherPageSpec[],
  ctx: FetchContext,
): Promise<RawPayloadRecord> {
  try {
    const stored: Record<string, string> = {};

    for (const spec of specs) {
      const result = await fetchConditional({
        url: spec.url,
        fetch: ctx.fetch,
        signal: ctx.signal,
        accept: "text/html,application/xhtml+xml",
        validators: decodeValidators(ctx.etag),
      });
      if (result.kind === "not-modified") {
        throw new Error(`unexpected 304 for ${spec.url}`);
      }
      stored[spec.key] = result.body;
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

/** Decodes a stored publisher payload into page key -> HTML. */
export function decodePublisherPayload(providerKey: string, payload: RawPayloadRecord): Record<string, string> {
  const decoded = storedPayloadSchema.safeParse(decodePayloadBody(payload));
  if (!decoded.success) {
    const issue = decoded.error.issues[0];
    throw parseErrorFor(providerKey, issue.path.map(String).join(".") || "body", issue.message, decoded.error);
  }
  return decoded.data;
}

/**
 * How many product rows a page yielded, and how many of those carried a date.
 *
 * Tracked separately because they fail differently and mean different things. A
 * page that yields no rows at all has been redesigned out from under the
 * selectors. A page with rows but no dates has kept its layout and moved the
 * date somewhere else. Either is drift; neither is a legitimate empty result,
 * because a publisher's product index always has products on it and always says
 * when they ship. Zero *candidates* after the forward-window filter is a
 * different thing entirely and is not an error -- that just means nothing on
 * the page is recent.
 */
export type PageYield = { rows: number; dated: number };

/**
 * Turns the two drift signals above into a ParseError.
 *
 * Raised rather than returning an empty list on purpose. A provider that
 * quietly yields nothing looks healthy in every log and dashboard while
 * contributing no evidence at all, and the events it used to support then age
 * out through rule G7 as though the product had been cancelled. Throwing makes
 * the run DEGRADED in ProviderRun (see orchestrate.ts's normalize loop), leaves
 * the response body on disk, and fails the fixture test in this repository
 * first -- which is where a page redesign should be noticed.
 */
export function assertPageYield(providerKey: string, totals: PageYield): void {
  if (totals.rows === 0) {
    throw parseErrorFor(providerKey, "rows", "no product rows matched the configured selectors on any page");
  }
  if (totals.dated === 0) {
    throw parseErrorFor(providerKey, "dates", `matched ${totals.rows} product rows but none carried a release date`);
  }
}

/**
 * Resolves a possibly-relative product link against its page and reduces it to
 * a stable id: the final path segment without its extension.
 *
 * Bandai's two sites write these three ways on one page ("st14.html",
 * "../products/gd06.html", "https://www.gundam-gcg.com/en/products/st14.html"),
 * and the slug is the only part that stays put across their redesigns -- it is
 * also, conveniently, the set code in lower case.
 */
export function productSlug(href: string | undefined, pageUrl: string): string | null {
  if (!href) return null;
  let path: string;
  try {
    path = new URL(href, pageUrl).pathname;
  } catch {
    return null;
  }
  const last = path.split("/").filter(Boolean).pop();
  if (!last) return null;
  const slug = last.replace(/\.[a-z0-9]+$/i, "").trim();
  return slug || null;
}

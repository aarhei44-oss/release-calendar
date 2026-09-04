import type { ProviderStatus } from "@/app/generated/prisma/client";
import { parseFlexibleDate } from "@/lib/crawler/dateParsing";
import { emptyBody, packPayloadBody } from "../fetch";
import { ParseError } from "../normalize";
import { primaryDate, type CandidateDate, type RawPayloadRecord } from "../types";

/**
 * Everything the concrete providers share: the forward window, date coercion,
 * and the RawPayload framing helpers.
 */

// ---------------------------------------------------------------------------
// The forward window
// ---------------------------------------------------------------------------

/**
 * How far into the past a candidate may be dated and still be ingested.
 *
 * This is the single most important number in the provider layer. v1 had no
 * such filter: it ingested every historical row on every source page -- roughly
 * 3,200 events a night -- then deleted 3,173 of them again as duplicates or
 * strays. That churn was simultaneously the pipeline's performance problem
 * (thousands of writes and deletes per run for no change in what users see) and
 * its biggest site-ban risk (a nightly full-catalogue rewrite looks exactly
 * like an abusive scrape).
 *
 * Ninety days is chosen so that a set which shipped last quarter is still
 * present for corroboration and for the lifecycle pass to reason about, while
 * a decade of historical set lists never enters the pipeline at all.
 *
 * Applied at parse time, deliberately: a row dropped here never becomes a
 * Candidate, never gets an identity, and never reaches the gate.
 */
export const FORWARD_WINDOW_DAYS = 90;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Whether a candidate's date is recent enough to ingest.
 *
 * A TBD date passes. That is not an oversight: an announced-but-undated product
 * is a legitimate candidate -- often the most interesting kind -- and there is
 * no sense in which it is "old". Only a date that is definitely behind us gets
 * dropped.
 *
 * `reference` is the payload's own fetchedAt rather than the wall clock, so a
 * replay of a stored payload filters exactly as the original run did.
 */
export function isWithinForwardWindow(date: CandidateDate, reference: Date): boolean {
  const anchor = primaryDate(date);
  if (!anchor) return true;
  return anchor.getTime() >= reference.getTime() - FORWARD_WINDOW_DAYS * MS_PER_DAY;
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const QUARTER = /^Q([1-4])\s+(\d{4})$/i;

/**
 * Separators the wikis use for a date range: an en or em dash, a spaced hyphen,
 * or the word "to". A bare hyphen is deliberately not in the list -- it would
 * split "2026-07-25" down the middle.
 */
const RANGE_SPLIT = /\s*(?:–|—|\s-\s|\sto\s)\s*/;

/**
 * Turns a provider's date text into a CandidateDate.
 *
 * Delegates the common formats to v1's parseFlexibleDate (so "May 9, 2012",
 * "2026-07-25" and "December 1993" mean the same thing on both pipelines) and
 * adds two forms v1 never needed:
 *
 *  - Quarters ("Q4 2026", "Q3 2027"), which is how Lorcana's and Riftbound's
 *    Wikipedia tables state a set that has a slot but not a date yet.
 *  - Ranges ("July 1999 – March 2003"), which is how Bulbapedia states an
 *    ongoing promo *series* rather than a single release. Parsing these
 *    matters more than it looks: left as TBD they would sail straight through
 *    the forward-window filter, and a decade of discontinued promo lines would
 *    take up permanent residence on the calendar as dateless rumours. Read as
 *    a range starting in 1999, they are dropped like any other old row.
 *
 * Never throws. Unrecognised text becomes TBD, which is the honest answer for
 * "the source said something we do not understand" -- and, unlike a guess, is
 * something the gate already knows how to hold.
 */
export function parseCandidateDateText(raw: string): CandidateDate {
  const text = raw.trim().replace(/\s+/g, " ");
  if (!text) return { kind: "TBD" };

  const parts = text.split(RANGE_SPLIT);
  if (parts.length === 2) {
    const start = parseSingleDateText(parts[0]);
    if (start.kind !== "TBD") {
      const end = parseSingleDateText(parts[1]);
      // An open-ended range ("January 2023 – Present") keeps its start, which
      // is all the forward-window filter needs.
      if (end.kind === "TBD") return start;
      const startAt = primaryDate(start);
      const endAt = end.kind === "EXACT" ? end.date : end.end;
      if (startAt && endAt && endAt.getTime() >= startAt.getTime()) {
        return { kind: "RANGE", start: startAt, end: endAt };
      }
      return start;
    }
  }

  return parseSingleDateText(text);
}

function parseSingleDateText(raw: string): CandidateDate {
  const text = raw.trim().replace(/\s+/g, " ");
  if (!text) return { kind: "TBD" };

  const quarter = QUARTER.exec(text);
  if (quarter) {
    const index = Number(quarter[1]) - 1;
    const year = Number(quarter[2]);
    return {
      kind: "WINDOW",
      granularity: "QUARTER",
      start: new Date(Date.UTC(year, index * 3, 1)),
      end: new Date(Date.UTC(year, index * 3 + 3, 0)),
    };
  }

  const parsed = parseFlexibleDate(text);
  switch (parsed.dateType) {
    case "EXACT":
      return { kind: "EXACT", date: parsed.dateExact };
    case "WINDOW":
      return { kind: "WINDOW", granularity: parsed.windowGranularity, start: parsed.windowStart, end: parsed.windowEnd };
    case "TBD":
      return { kind: "TBD" };
  }
}

/**
 * Parses a plain `YYYY-MM-DD` (Scryfall's `released_at`, YGOPRODeck's
 * `tcg_date`) or the naive `YYYY-MM-DDTHH:MM:SS` tcgcsv sends.
 *
 * Anchored to UTC on purpose. The upstreams state a calendar date with no zone;
 * reading it in the server's local zone would move the whole calendar by a day
 * whenever the deploy host's zone changed, and would make a test's answer
 * depend on the machine it ran on.
 */
export function parseIsoDateUtc(raw: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/.exec(raw.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day) return null;
  return date;
}

// ---------------------------------------------------------------------------
// Payload framing
// ---------------------------------------------------------------------------

/** A payload row for a fetch that produced a body. */
export function okPayload(args: {
  scanRunId: string;
  providerKey: string;
  value: unknown;
  fetchedAt: Date;
  etag?: string | null;
  status?: ProviderStatus;
}): RawPayloadRecord {
  const { body, contentHash } = packPayloadBody(args.value);
  return {
    scanRunId: args.scanRunId,
    providerKey: args.providerKey,
    contentHash,
    body,
    fetchedAt: args.fetchedAt,
    status: args.status ?? "OK",
    etag: args.etag ?? null,
  };
}

/**
 * A payload row for a fetch that produced nothing: a 304, or a body byte-identical
 * to the one already stored.
 *
 * The contentHash is carried forward unchanged so the *next* run can still
 * short-circuit against it -- a NOT_MODIFIED run that forgot the hash would
 * force a full re-parse the run after.
 */
export function notModifiedPayload(args: {
  scanRunId: string;
  providerKey: string;
  contentHash: string;
  fetchedAt: Date;
  etag?: string | null;
}): RawPayloadRecord {
  return {
    scanRunId: args.scanRunId,
    providerKey: args.providerKey,
    contentHash: args.contentHash,
    body: emptyBody(),
    fetchedAt: args.fetchedAt,
    status: "NOT_MODIFIED",
    etag: args.etag ?? null,
  };
}

/**
 * A payload row for a fetch that failed.
 *
 * Returned rather than thrown so that one provider's outage is recorded as that
 * provider's FAILED ProviderRun and the other six are applied normally --
 * fault isolation is the orchestrator's contract, and a provider that throws
 * gets the same treatment, but returning keeps the error message intact.
 */
export function failedPayload(args: {
  scanRunId: string;
  providerKey: string;
  fetchedAt: Date;
  error: unknown;
}): RawPayloadRecord {
  return {
    scanRunId: args.scanRunId,
    providerKey: args.providerKey,
    contentHash: "",
    body: emptyBody(),
    fetchedAt: args.fetchedAt,
    status: "FAILED",
    etag: null,
    error: args.error instanceof Error ? args.error.message : String(args.error),
  };
}

/** Rejects a payload whose decoded shape is not what the provider contract describes. */
export function parseErrorFor(providerKey: string, path: string, message: string, cause?: unknown): ParseError {
  return new ParseError(providerKey, path, message, cause === undefined ? undefined : { cause });
}

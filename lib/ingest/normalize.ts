import { gunzipSync } from "node:zlib";
import { z } from "zod";
import type { Provider } from "./providers/types";
import type { Candidate, RawPayloadRecord } from "./types";

/**
 * Stage 2: turn stored payloads into validated Candidates.
 *
 * The governing rule here is **reject, never coerce**. Upstream sites change
 * their shapes without warning, and the failure mode that actually hurts is
 * not a crash -- it is a parser that quietly keeps working, yields a date of
 * `Invalid Date` or a name of `undefined`, and pushes that into the gate,
 * which then dutifully publishes garbage with a rule name attached. A loud,
 * typed failure that names the provider and the failing path costs us one
 * provider for one run; a silent coercion costs us the calendar's credibility.
 *
 * So: every candidate a provider emits is validated against a strict schema
 * (unknown keys rejected too, since an unexpected key is itself evidence the
 * provider and this contract have drifted apart), and anything that does not
 * fit throws ParseError rather than being repaired.
 */

/** Thrown by every failure path in this module. Always names the provider and where in the data it broke. */
export class ParseError extends Error {
  readonly providerKey: string;
  /** Dotted path into the offending candidate (e.g. "candidates.3.date.date"), or a stage name for a decode failure. */
  readonly path: string;

  constructor(providerKey: string, path: string, message: string, options?: { cause?: unknown }) {
    super(`[${providerKey}] ${path}: ${message}`, options);
    this.name = "ParseError";
    this.providerKey = providerKey;
    this.path = path;
  }
}

const windowGranularitySchema = z.enum(["MONTH", "QUARTER", "YEAR"]);

// z.strictObject throughout: an unknown key means the provider is emitting
// something this contract does not describe, which is exactly the drift this
// stage exists to catch. Stripping it silently (zod's default) would hide it.
const candidateDateSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("EXACT"), date: z.date() }),
  z.strictObject({ kind: z.literal("RANGE"), start: z.date(), end: z.date() }),
  z.strictObject({
    kind: z.literal("WINDOW"),
    granularity: windowGranularitySchema,
    start: z.date(),
    end: z.date(),
  }),
  z.strictObject({ kind: z.literal("TBD") }),
]);

const candidateSchema = z.strictObject({
  origin: z.string().min(1),
  game: z.string().min(1),
  externalIds: z.record(z.string().min(1), z.string().min(1)),
  name: z.string().min(1),
  code: z.string().min(1).nullable(),
  date: candidateDateSchema,
  region: z.enum(["GLOBAL", "NA", "EU", "APAC", "JP", "OTHER"]),
  type: z.enum(["SHELF", "PRERELEASE", "PROMO", "SPECIAL"]),
  url: z.string().optional(),
  description: z.string().optional(),
  imageUrl: z.string().optional(),
});

/**
 * Un-gzips a stored payload and parses it as JSON. Providers whose `parse`
 * wants the decoded object call this; it is exported so a parser never has to
 * re-derive the storage framing (and so the "payload is corrupt" error reads
 * the same as every other parse failure).
 */
export function decodePayloadBody(payload: RawPayloadRecord): unknown {
  let text: string;
  try {
    text = gunzipSync(payload.body).toString("utf8");
  } catch (error) {
    throw new ParseError(payload.providerKey, "body.gunzip", "stored payload is not valid gzip", { cause: error });
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ParseError(payload.providerKey, "body.json", "stored payload is not valid JSON", { cause: error });
  }
}

/**
 * Runs one provider's parser over one stored payload and validates the result.
 *
 * A throw from the provider's own `parse` is wrapped rather than swallowed, so
 * the caller sees a ParseError either way and never has to distinguish "the
 * parser blew up" from "the parser lied" at the call site.
 */
export function normalizePayload(payload: RawPayloadRecord, provider: Provider): Candidate[] {
  if (payload.providerKey !== provider.key) {
    throw new ParseError(
      provider.key,
      "providerKey",
      `payload belongs to provider "${payload.providerKey}"`,
    );
  }

  let raw: unknown;
  try {
    raw = provider.parse(payload);
  } catch (error) {
    if (error instanceof ParseError) throw error;
    throw new ParseError(provider.key, "parse", error instanceof Error ? error.message : String(error), {
      cause: error,
    });
  }

  if (!Array.isArray(raw)) {
    throw new ParseError(provider.key, "candidates", `parse must return an array, got ${typeof raw}`);
  }

  const candidates: Candidate[] = [];
  for (const [index, entry] of raw.entries()) {
    const result = candidateSchema.safeParse(entry);
    if (!result.success) {
      const issue = result.error.issues[0];
      const path = ["candidates", String(index), ...issue.path.map(String)].join(".");
      throw new ParseError(provider.key, path, issue.message, { cause: result.error });
    }
    // A provider claiming another origin's candidates would silently defeat
    // the gate's independence test (G2): two "origins" agreeing would in fact
    // be one provider agreeing with itself.
    if (result.data.origin !== provider.origin) {
      throw new ParseError(
        provider.key,
        ["candidates", String(index), "origin"].join("."),
        `expected origin "${provider.origin}", got "${result.data.origin}"`,
      );
    }
    candidates.push(result.data);
  }

  return candidates;
}

export type NormalizeResult = {
  candidates: Candidate[];
  /** One entry per provider whose payload failed; the run continues without it (a partial run beats no run). */
  errors: Array<{ providerKey: string; path: string; message: string }>;
  /**
   * How many candidates each provider's payload yielded this run, for
   * ProviderRun.candidates (data/ingest/ingestRepo.ts's
   * updateProviderRunCandidateCount). Fetch time is too early to know this --
   * parsing hasn't happened yet -- which is why the Fetch stage's
   * recordProviderRun call always wrote 0 here until this map existed. A
   * provider absent from this map was NOT_MODIFIED or sent an empty body, both
   * of which correctly leave its ProviderRun row's count alone rather than
   * overwriting a real prior count with a stale zero.
   */
  candidatesByProvider: Map<string, number>;
};

/**
 * Normalizes every payload in a run.
 *
 * A provider that fails is recorded and skipped rather than aborting the
 * batch: a run where four providers succeeded and one changed its HTML is a
 * partial success, and throwing away the four good ones would mean one
 * upstream redesign blanks the whole calendar. The failure is still loud --
 * it lands in `errors`, and the caller marks that ProviderRun DEGRADED.
 */
export function normalizeRun(
  payloads: RawPayloadRecord[],
  lookupProvider: (key: string) => Provider | undefined,
): NormalizeResult {
  const candidates: Candidate[] = [];
  const errors: NormalizeResult["errors"] = [];
  const candidatesByProvider = new Map<string, number>();

  for (const payload of payloads) {
    const provider = lookupProvider(payload.providerKey);
    if (!provider) {
      errors.push({
        providerKey: payload.providerKey,
        path: "provider",
        message: "no provider registered for this payload",
      });
      continue;
    }
    // Nothing was fetched, so there is nothing to parse -- not an error. The
    // previous run's candidates for this provider are still standing, which is
    // exactly what NOT_MODIFIED means.
    if (payload.status === "NOT_MODIFIED" || payload.body.length === 0) continue;

    try {
      const parsed = normalizePayload(payload, provider);
      candidates.push(...parsed);
      candidatesByProvider.set(payload.providerKey, (candidatesByProvider.get(payload.providerKey) ?? 0) + parsed.length);
    } catch (error) {
      if (error instanceof ParseError) {
        errors.push({ providerKey: error.providerKey, path: error.path, message: error.message });
      } else {
        errors.push({
          providerKey: payload.providerKey,
          path: "unknown",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return { candidates, errors, candidatesByProvider };
}

import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

/**
 * The Fetch stage's HTTP policy, in one place.
 *
 * lib/crawler/httpFetch.ts already does timeout + single-retry, and the first
 * plan here was to reuse it. It does not fit: it hardcodes the v1 User-Agent,
 * it cannot send conditional-request headers, and it throws away the response
 * headers a conditional GET depends on (ETag/Last-Modified) because its only
 * caller wants the body. Rather than widen v1's helper -- which is live and
 * must keep behaving exactly as it does -- the v2 policy lives here, and v1 is
 * left alone.
 *
 * What this adds over v1's helper:
 *
 *  - Conditional GET. Every provider sends If-None-Match / If-Modified-Since
 *    from the validators Phase 1's ProviderEtag stored, and a 304 comes back as
 *    a first-class result rather than an empty body the caller has to sniff.
 *  - Per-host serialisation with a minimum gap. The orchestrator fetches four
 *    providers at once and several of them make more than one request; without
 *    a gate, tcgcsv.com would see seven requests land simultaneously. The gate
 *    is keyed by host, so unrelated hosts still overlap.
 *  - One shared User-Agent naming the project and a contact address, which is
 *    what Wikimedia's policy requires and what everyone else appreciates.
 */

/**
 * Identifies this crawler to every upstream. Wikimedia's User-Agent policy
 * requires a contact address; Scryfall rejects requests without a descriptive
 * UA outright (403).
 */
export const USER_AGENT = "release-watcher/2.0 (+https://releasewatcher.com; contact@releasewatcher.com)";

const DEFAULT_TIMEOUT_MS = 20_000;
const RETRY_DELAY_MS = 1_000;

/**
 * Minimum spacing between two requests to the same host. Scryfall asks for
 * 50-100ms; this is well clear of that and still lets the seven tcgcsv
 * category requests finish in a couple of seconds.
 */
const HOST_MIN_GAP_MS = 400;

// ---------------------------------------------------------------------------
// Conditional-request validators
// ---------------------------------------------------------------------------

/**
 * The validators a provider carries between runs.
 *
 * Phase 1's ProviderEtag has a single opaque `etag` column, but the real
 * endpoints do not agree on which validator they send: tcgcsv.com sends both
 * ETag and Last-Modified, Scryfall sends a weak ETag only, YGOPRODeck sends
 * Last-Modified only, and the MediaWiki `action=parse` endpoint sends neither.
 * Rather than migrate the schema for this, providers encode whatever they hold
 * into that one column as JSON and decode it defensively, so a column written
 * by an earlier build (a bare ETag string) still reads correctly.
 */
export type Validators = {
  etag?: string | null;
  lastModified?: string | null;
};

export function encodeValidators(validators: Validators): string | null {
  const etag = validators.etag ?? null;
  const lastModified = validators.lastModified ?? null;
  if (!etag && !lastModified) return null;
  // A bare ETag stays a bare string: the common case reads the same in the
  // database as it did before this encoding existed.
  if (etag && !lastModified) return etag;
  return JSON.stringify({ etag, lastModified });
}

export function decodeValidators(stored: string | null | undefined): Validators {
  if (!stored) return {};
  if (!stored.startsWith("{")) return { etag: stored };
  try {
    const parsed: unknown = JSON.parse(stored);
    if (!parsed || typeof parsed !== "object") return { etag: stored };
    const record = parsed as Record<string, unknown>;
    return {
      etag: typeof record.etag === "string" ? record.etag : null,
      lastModified: typeof record.lastModified === "string" ? record.lastModified : null,
    };
  } catch {
    // Not JSON after all -- an ETag that happens to start with "{" is legal.
    return { etag: stored };
  }
}

// ---------------------------------------------------------------------------
// Per-host request gate
// ---------------------------------------------------------------------------

const hostChains = new Map<string, Promise<void>>();
const lastRequestAt = new Map<string, number>();

/**
 * Serialises requests to one host and leaves at least HOST_MIN_GAP_MS between
 * them.
 *
 * The gap is waited *before* a request rather than held open after one, and
 * measured against when the previous request to that host finished. The
 * difference matters more than it sounds: an earlier version released the queue
 * on a trailing `setTimeout`, and because that timer had to be unref'd to avoid
 * holding the process open, Node could exit with the next request still waiting
 * on it -- a run that ended silently having fetched exactly one category.
 * Waiting up front has no timer outliving the request, and costs nothing at all
 * when no second request to that host is queued.
 */
async function withHostGate<T>(url: string, run: () => Promise<T>): Promise<T> {
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    return run();
  }

  const previous = hostChains.get(host) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  hostChains.set(
    host,
    previous.then(() => mine),
  );

  await previous;
  try {
    const last = lastRequestAt.get(host);
    const wait = last === undefined ? 0 : HOST_MIN_GAP_MS - (Date.now() - last);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    return await run();
  } finally {
    lastRequestAt.set(host, Date.now());
    release();
  }
}

// ---------------------------------------------------------------------------
// The request itself
// ---------------------------------------------------------------------------

export type ConditionalResult =
  | { kind: "ok"; body: string; validators: Validators }
  /** The server confirmed our copy is current. A success, not a no-op. */
  | { kind: "not-modified" };

export type ConditionalRequest = {
  url: string;
  fetch: typeof globalThis.fetch;
  /** Sent as If-None-Match / If-Modified-Since. Omit on a first fetch. */
  validators?: Validators;
  accept?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
};

/**
 * One conditional GET, with a hard timeout and a single retry.
 *
 * Retries only a transport failure or a 5xx, exactly as v1 does: a 4xx is the
 * server telling us the request is wrong, and repeating it is both pointless
 * and the fastest way to earn a block. Any non-2xx/304 status throws, which the
 * provider turns into ProviderStatus.FAILED for itself alone.
 */
export async function fetchConditional(request: ConditionalRequest): Promise<ConditionalResult> {
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
    Accept: request.accept ?? "application/json",
  };
  if (request.validators?.etag) headers["If-None-Match"] = request.validators.etag;
  if (request.validators?.lastModified) headers["If-Modified-Since"] = request.validators.lastModified;

  return withHostGate(request.url, async () => {
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= 2; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const abortOuter = () => controller.abort();
      request.signal?.addEventListener("abort", abortOuter, { once: true });

      try {
        const response = await request.fetch(request.url, { headers, signal: controller.signal });

        if (response.status === 304) return { kind: "not-modified" };

        if (response.ok) {
          return {
            kind: "ok",
            body: await response.text(),
            validators: {
              etag: response.headers.get("etag"),
              lastModified: response.headers.get("last-modified"),
            },
          };
        }

        const httpError = new HttpStatusError(request.url, response.status);
        // A 4xx is the server telling us the request itself is wrong. Repeating
        // it changes nothing and is the fastest way to earn a block, so it is
        // rethrown past the retry rather than recorded as a transient failure.
        if (!httpError.retryable || attempt === 2) throw httpError;
        lastError = httpError;
      } catch (error) {
        if (error instanceof HttpStatusError && !error.retryable) throw error;
        if (attempt === 2) throw error;
        lastError = error;
      } finally {
        clearTimeout(timer);
        request.signal?.removeEventListener("abort", abortOuter);
      }

      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }

    throw lastError instanceof Error ? lastError : new Error(`${request.url} failed`);
  });
}

/** A non-2xx, non-304 response. Carries whether repeating the request could plausibly help. */
class HttpStatusError extends Error {
  readonly status: number;
  readonly retryable: boolean;

  constructor(url: string, status: number) {
    super(`${url} responded ${status}`);
    this.name = "HttpStatusError";
    this.status = status;
    this.retryable = status >= 500;
  }
}

// ---------------------------------------------------------------------------
// Payload framing
// ---------------------------------------------------------------------------

/**
 * Helper for providers: gzip a JSON body and hash the uncompressed bytes, the
 * way RawPayload expects.
 *
 * The gzipped Buffer is copied into a freshly allocated Uint8Array rather than
 * wrapped, so the result is a `Uint8Array<ArrayBuffer>` -- wrapping a Buffer
 * infers `ArrayBufferLike`, which Prisma's Bytes column rejects.
 */
export function packPayloadBody(value: unknown): { body: Uint8Array<ArrayBuffer>; contentHash: string } {
  const json = JSON.stringify(value);
  const gzipped = gzipSync(Buffer.from(json, "utf8"));
  const body = new Uint8Array(gzipped.byteLength);
  body.set(gzipped);
  return {
    body,
    contentHash: createHash("sha256").update(json, "utf8").digest("hex"),
  };
}

/** An empty body, for the NOT_MODIFIED and FAILED payload rows that carry none. */
export function emptyBody(): Uint8Array<ArrayBuffer> {
  return new Uint8Array(0);
}

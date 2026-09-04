import type { SourceTier } from "@/app/generated/prisma/client";
import type { Candidate, Origin, RawPayloadRecord } from "../types";

/**
 * Context handed to a provider's fetch. Everything a provider needs to make a
 * conditional request and stamp its payload is passed in rather than looked up
 * inside, so that Fetch remains the only stage with a dependency on the
 * database *or* the network, and a provider can be exercised in isolation.
 */
export type FetchContext = {
  scanRunId: string;
  /** Last run's ETag for this provider, from ProviderEtag. Undefined on first ever fetch. */
  etag?: string | null;
  /** Hash of the last body we stored, for providers that send no ETag. */
  contentHash?: string | null;
  /** Injected so tests never reach the real network and so retries/timeouts stay policy, not per-provider code. */
  fetch: typeof globalThis.fetch;
  /** Injected for determinism; providers must not call Date.now(). */
  now: Date;
  signal?: AbortSignal;
};

/**
 * One upstream data source.
 *
 * The split between `fetch` and `parse` is the pipeline's central constraint,
 * not a stylistic one: `fetch` is allowed to touch the network and nothing
 * else, `parse` is a pure function from stored bytes to candidates and is
 * forbidden from touching anything. That is what lets replay.ts re-derive an
 * entire run from RawPayload rows with the network unplugged.
 *
 * `parse` receives the RawPayloadRecord (not a decoded object) so that the
 * payload's own framing -- gzip, content hash, fetch time -- is available to a
 * parser that needs it, and so the decode failure path is uniform (see
 * normalize.ts's ParseError).
 */
export interface Provider {
  /** Stable key; also the RawPayload/ProviderRun key, so it must never be renamed casually. */
  key: string;
  /** Which upstream identity this provider speaks for -- a key into an OriginRegistry. */
  origin: Origin;
  tier: SourceTier;
  /** TcgProfilePackage slugs this provider yields data for, used to scope a run. */
  games: string[];
  fetch(ctx: FetchContext): Promise<RawPayloadRecord>;
  parse(payload: RawPayloadRecord): Candidate[];
}

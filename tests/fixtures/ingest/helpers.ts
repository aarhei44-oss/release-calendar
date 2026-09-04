import { readFileSync } from "node:fs";
import path from "node:path";
import { packPayloadBody } from "@/lib/ingest/fetch";
import type { Provider } from "@/lib/ingest/providers/types";
import type { Candidate, RawPayloadRecord } from "@/lib/ingest/types";

/**
 * Fixture plumbing shared by the five provider tests.
 *
 * Every fixture in this directory is a trimmed recording of a real response,
 * captured on 2026-09-04 -- see the provenance note at the top of each test.
 * Nothing here touches the network: `parse` is a pure function of stored bytes
 * by design (lib/ingest/providers/types.ts), which is exactly what makes
 * testing it against a recording meaningful rather than a stub of itself.
 */

const FIXTURE_DIR = path.join(process.cwd(), "tests", "fixtures", "ingest");

export function loadFixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(path.join(FIXTURE_DIR, name), "utf8")) as T;
}

/**
 * Frames a fixture the way the Fetch stage would have, so `parse` sees exactly
 * what it sees in production: gzipped bytes with a content hash and a fetch
 * time.
 *
 * `fetchedAt` is load-bearing, not decoration. It is the reference point the
 * forward-window filter measures against, so a test that changes it is testing
 * the filter, and a run replayed years later still filters as it did on the
 * day it was captured.
 */
export function payloadFor(providerKey: string, value: unknown, fetchedAt: Date): RawPayloadRecord {
  const { body, contentHash } = packPayloadBody(value);
  return { scanRunId: "test-run", providerKey, contentHash, body, fetchedAt, status: "OK" };
}

/** Runs a provider's parser over a fixture. */
export function parseFixture(provider: Provider, value: unknown, fetchedAt: Date): Candidate[] {
  return provider.parse(payloadFor(provider.key, value, fetchedAt));
}

export function byName(candidates: Candidate[], name: string): Candidate | undefined {
  return candidates.find((candidate) => candidate.name === name);
}

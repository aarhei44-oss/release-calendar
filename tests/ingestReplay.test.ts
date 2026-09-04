import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { packPayloadBody } from "@/lib/ingest/orchestrate";
import { decodePayloadBody } from "@/lib/ingest/normalize";
import { registerProvider, unregisterProvider } from "@/lib/ingest/providers/registry";
import type { Provider } from "@/lib/ingest/providers/types";
import { replayRun, retryRun } from "@/lib/ingest/replay";
import type { Candidate } from "@/lib/ingest/types";

/**
 * Replay is the property the whole v2 substrate exists to provide, so these
 * tests assert the two things that make it worth having:
 *
 *  1. Replaying a stored run performs no network I/O whatsoever. Asserted by
 *     making every route to the network throw -- `globalThis.fetch` and the
 *     providers' own `fetch` -- so a replay that reached for the network would
 *     fail loudly rather than quietly succeed against a live site.
 *  2. Replaying converges. Running the same stored run three times must leave
 *     the database exactly where running it once did, or "replay a fixed
 *     parser over yesterday's data" is a trap rather than a tool.
 */

const GAME_SLUG = `ingest-replay-test-${crypto.randomUUID()}`;

let installId: string;
let scanRunId: string;

// The wire shape these fake providers publish: JSON, so dates arrive as
// strings and the parser has to revive them -- which is exactly what a real
// provider's parse does, and what keeps zod's z.date() honest.
type WireRow = { id: string; name: string; code: string; date: string };

const OFFICIAL_ROWS: WireRow[] = [
  { id: "off-1", name: "Ember Ascendant", code: "EMA", date: "2026-11-06T00:00:00.000Z" },
  { id: "off-2", name: "Tidal Reckoning", code: "TDR", date: "2027-01-15T00:00:00.000Z" },
];

const RETAILER_ROWS: WireRow[] = [
  // Same two products, listed a day later -- inside the gate's agreement window.
  { id: "ret-1", name: "Ember Ascendant", code: "EMA", date: "2026-11-07T00:00:00.000Z" },
  { id: "ret-2", name: "Tidal Reckoning", code: "TDR", date: "2027-01-15T00:00:00.000Z" },
];

function makeProvider(params: {
  key: string;
  origin: string;
  tier: Provider["tier"];
  rows: WireRow[];
}): Provider {
  return {
    key: params.key,
    origin: params.origin,
    tier: params.tier,
    games: [GAME_SLUG],
    async fetch() {
      // Any replay that reaches the Fetch stage is a bug, so make it loud.
      throw new Error(`network access attempted by provider ${params.key}`);
    },
    parse(payload) {
      const rows = decodePayloadBody(payload) as WireRow[];
      return rows.map(
        (row): Candidate => ({
          origin: params.origin,
          game: GAME_SLUG,
          externalIds: { [params.origin]: row.id },
          name: row.name,
          code: row.code,
          date: { kind: "EXACT", date: new Date(row.date) },
          region: "GLOBAL",
          type: "SHELF",
          url: `https://${params.key}.example/${row.id}`,
        }),
      );
    },
  };
}

const officialProvider = makeProvider({
  key: "replay-test-official",
  origin: "pokemon-official",
  tier: "OFFICIAL",
  rows: OFFICIAL_ROWS,
});

const retailerProvider = makeProvider({
  key: "replay-test-retailer",
  origin: "tcgplayer",
  tier: "RETAILER",
  rows: RETAILER_ROWS,
});

/** Seeds a run whose payloads are already on disk, exactly as a real Fetch stage would have left them. */
async function seedRun(rowsByProvider: Array<{ provider: Provider; rows: WireRow[] }>): Promise<string> {
  const run = await prisma.scanRun.create({
    data: {
      scopeType: "INSTALL",
      scopeId: installId,
      trigger: "SCHEDULED",
      status: "SUCCEEDED",
      startedAt: new Date(),
      finishedAt: new Date(),
    },
  });

  for (const { provider, rows } of rowsByProvider) {
    const { body, contentHash } = packPayloadBody(rows);
    await prisma.rawPayload.create({
      data: {
        scanRunId: run.id,
        providerKey: provider.key,
        contentHash,
        body,
        fetchedAt: new Date(),
      },
    });
    await prisma.providerRun.create({
      data: {
        scanRunId: run.id,
        providerKey: provider.key,
        status: "OK",
        candidates: rows.length,
        startedAt: new Date(),
        finishedAt: new Date(),
      },
    });
  }

  return run.id;
}

/**
 * A stable snapshot of everything a replay is allowed to touch, with ids and
 * timestamps stripped -- those legitimately differ between rows, and what
 * convergence means is that the *content* is identical, not that no row was
 * ever rewritten.
 */
async function snapshot() {
  const productSets = await prisma.productSet.findMany({
    where: { tcgProfileInstallId: installId },
    select: { code: true, name: true },
    orderBy: { code: "asc" },
  });
  const events = await prisma.releaseEvent.findMany({
    where: { productSet: { tcgProfileInstallId: installId } },
    select: {
      type: true,
      dateType: true,
      dateExact: true,
      status: true,
      confidence: true,
      productSet: { select: { code: true } },
    },
    orderBy: { productSet: { code: "asc" } },
  });
  const claims = await prisma.sourceClaim.findMany({
    where: { releaseEvent: { productSet: { tcgProfileInstallId: installId } } },
    select: { origin: true, tier: true, disposition: true, dateExact: true, url: true },
    orderBy: [{ url: "asc" }],
  });
  const identities = await prisma.setIdentity.findMany({
    where: { productSet: { tcgProfileInstallId: installId } },
    select: { origin: true, externalId: true },
    orderBy: [{ origin: "asc" }, { externalId: "asc" }],
  });
  const reviewItems = await prisma.reviewItem.findMany({
    where: { releaseEvent: { productSet: { tcgProfileInstallId: installId } } },
    select: { reason: true, resolvedAt: true },
  });
  return { productSets, events, claims, identities, reviewItems };
}

beforeAll(async () => {
  const pkg = await prisma.tcgProfilePackage.create({
    data: {
      slug: GAME_SLUG,
      name: "Ingest Replay Test",
      version: "1.0.0",
      discoveryConfig: {},
      sourceConfigs: {},
    },
  });
  const install = await prisma.tcgProfileInstall.create({
    data: { packageId: pkg.id, installedVersion: "1.0.0", enabled: true },
  });
  installId = install.id;

  registerProvider(officialProvider);
  registerProvider(retailerProvider);

  scanRunId = await seedRun([
    { provider: officialProvider, rows: OFFICIAL_ROWS },
    { provider: retailerProvider, rows: RETAILER_ROWS },
  ]);
});

afterAll(async () => {
  unregisterProvider(officialProvider.key);
  unregisterProvider(retailerProvider.key);
  await prisma.$disconnect();
});

describe("replayRun", () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("performs no network I/O at all", async () => {
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("replayRun must not touch the network");
    }) as typeof globalThis.fetch;

    // Both providers' own fetch() also throws (see makeProvider), so there is
    // no route to the network that a replay could take quietly.
    const result = await replayRun(scanRunId);

    expect(fetchCalls).toBe(0);
    expect(result.scanRunId).toBe(scanRunId);
    expect(result.totals.candidates).toBe(4);
    expect(result.totals.parseErrors).toBe(0);
  });

  it("rebuilds the full run from stored payloads alone", async () => {
    const state = await snapshot();

    expect(state.productSets.map((set) => set.code)).toEqual(["EMA", "TDR"]);
    expect(state.events).toHaveLength(2);

    const ember = state.events.find((event) => event.productSet.code === "EMA");
    // Official and retailer agree within the gate's window, and G1 publishes
    // the official date rather than the retailer's day-later listing.
    expect(ember?.dateType).toBe("EXACT");
    expect(ember?.dateExact?.toISOString()).toBe("2026-11-06T00:00:00.000Z");
    expect(ember?.status).toBe("CONFIRMED");
    expect(ember?.confidence).toBeGreaterThan(0);

    // One claim per (origin, event), each stamped with its origin.
    expect(state.claims).toHaveLength(4);
    expect(new Set(state.claims.map((claim) => claim.origin))).toEqual(
      new Set(["pokemon-official", "tcgplayer"]),
    );
    expect(state.claims.every((claim) => claim.disposition === "SUPPORTS")).toBe(true);

    // Every upstream id got pinned, so the next run resolves by id.
    expect(state.identities).toHaveLength(4);
    expect(state.reviewItems).toHaveLength(0);
  });

  it("converges: replaying three times leaves the same state as replaying once", async () => {
    const afterOne = await snapshot();

    await replayRun(scanRunId);
    await replayRun(scanRunId);
    await replayRun(scanRunId);

    const afterFour = await snapshot();
    expect(afterFour).toEqual(afterOne);
  });

  it("does not stack duplicate claims across replays", async () => {
    const before = await prisma.sourceClaim.count({
      where: { releaseEvent: { productSet: { tcgProfileInstallId: installId } } },
    });
    await replayRun(scanRunId);
    const after = await prisma.sourceClaim.count({
      where: { releaseEvent: { productSet: { tcgProfileInstallId: installId } } },
    });
    expect(after).toBe(before);
  });

  it("does not create duplicate ProductSets across replays", async () => {
    await replayRun(scanRunId);
    const sets = await prisma.productSet.findMany({ where: { tcgProfileInstallId: installId } });
    expect(sets).toHaveLength(2);
  });

  it("writes a run diff describing what it did, overwriting rather than duplicating it", async () => {
    await replayRun(scanRunId);
    const diffs = await prisma.runDiff.findMany({ where: { scanRunId } });
    expect(diffs).toHaveLength(1);
    const changes = diffs[0].changes as unknown as Array<{ action: string; rule: string }>;
    expect(changes).toHaveLength(2);
    expect(changes.every((change) => change.action === "PUBLISH")).toBe(true);
    expect(changes.every((change) => change.rule === "G1")).toBe(true);
  });

  it("can be narrowed to a subset of providers without touching the others' claims", async () => {
    const result = await replayRun(scanRunId, { providers: [officialProvider.key] });
    expect(result.totals.candidates).toBe(2);
    // The retailer's claims from earlier replays are still on record -- a
    // narrowed replay re-derives part of the run, it does not erase the rest.
    const retailerClaims = await prisma.sourceClaim.count({
      where: { origin: "tcgplayer", releaseEvent: { productSet: { tcgProfileInstallId: installId } } },
    });
    expect(retailerClaims).toBe(2);
  });

  it("rejects an unknown run id rather than silently doing nothing", async () => {
    await expect(replayRun("no-such-run")).rejects.toThrow(/No such run/);
  });

  it("releases the job lock, so a second replay can follow immediately", async () => {
    await replayRun(scanRunId);
    await expect(replayRun(scanRunId)).resolves.toBeTruthy();
    const locks = await prisma.jobLock.findMany({ where: { scopeKey: installId } });
    expect(locks).toHaveLength(0);
  });
});

describe("retryRun", () => {
  it("re-fetches only FAILED providers and leaves successful ones alone", async () => {
    const runId = await seedRun([{ provider: officialProvider, rows: OFFICIAL_ROWS }]);
    // A second provider that failed outright: no payload, status FAILED.
    await prisma.providerRun.create({
      data: {
        scanRunId: runId,
        providerKey: retailerProvider.key,
        status: "FAILED",
        error: "connect ETIMEDOUT",
        startedAt: new Date(),
        finishedAt: new Date(),
      },
    });

    const fetched: string[] = [];
    const recoveringRetailer: Provider = {
      ...retailerProvider,
      async fetch(ctx) {
        fetched.push(retailerProvider.key);
        // A retry must not send the stored ETag -- a 304 would leave the run
        // with the same hole it started with.
        expect(ctx.etag).toBeNull();
        const { body, contentHash } = packPayloadBody(RETAILER_ROWS);
        return {
          scanRunId: ctx.scanRunId,
          providerKey: retailerProvider.key,
          contentHash,
          body,
          fetchedAt: ctx.now,
          status: "OK",
        };
      },
    };
    registerProvider(recoveringRetailer);

    try {
      const result = await retryRun(runId);
      expect(result.refetched).toEqual([retailerProvider.key]);
      expect(result.stillFailing).toEqual([]);
      // The official provider succeeded originally and its fetch throws, so
      // the fact that this did not blow up is the assertion.
      expect(fetched).toEqual([retailerProvider.key]);

      const payloads = await prisma.rawPayload.findMany({ where: { scanRunId: runId } });
      expect(payloads.map((payload) => payload.providerKey).sort()).toEqual(
        [officialProvider.key, retailerProvider.key].sort(),
      );

      const providerRuns = await prisma.providerRun.findMany({ where: { scanRunId: runId } });
      expect(providerRuns.every((run) => run.status === "OK")).toBe(true);
    } finally {
      registerProvider(retailerProvider);
    }
  });

  it("treats a run whose retry still fails as a partial, applying what did work", async () => {
    const runId = await seedRun([{ provider: officialProvider, rows: OFFICIAL_ROWS }]);
    await prisma.providerRun.create({
      data: {
        scanRunId: runId,
        providerKey: "replay-test-never-registered",
        status: "FAILED",
        error: "gone",
        startedAt: new Date(),
        finishedAt: new Date(),
      },
    });

    const result = await retryRun(runId);
    expect(result.stillFailing).toEqual(["replay-test-never-registered"]);
    // The successful provider's data was still applied.
    expect(result.totals.candidates).toBe(2);

    // And the retry left a provenance row pointing back at the repaired run.
    const provenance = await prisma.scanRun.findFirst({ where: { retryOfRunId: runId } });
    expect(provenance).not.toBeNull();
    expect(provenance?.status).toBe("FAILED");
  });
});

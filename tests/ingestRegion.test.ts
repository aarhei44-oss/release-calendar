import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as ingestRepo from "@/data/ingest/ingestRepo";
import { evaluateGate } from "@/lib/ingest/gate";
import { decodePayloadBody } from "@/lib/ingest/normalize";
import {
  eventGroupKey,
  groupResolvedCandidates,
  packPayloadBody,
  runStagesFromPayloads,
} from "@/lib/ingest/orchestrate";
import { registerProvider, unregisterProvider } from "@/lib/ingest/providers/registry";
import type { Provider } from "@/lib/ingest/providers/types";
import { prisma } from "@/lib/prisma";
import type { Candidate, ClaimRecord, ResolvedCandidate } from "@/lib/ingest/types";

/**
 * Region is part of the event key (phase 4).
 *
 * The failure this prevents is specific and was measured: a Japanese street date
 * and a global street date for one product used to resolve to a single
 * ReleaseEvent, reach the gate as two claims months apart, and be flagged as a
 * G5 conflict -- forever, on every set with a Japanese release. That is why
 * phases 2 and 3 shipped with Bulbapedia's Japanese expansion list and both
 * Bandai Japanese catalogues switched off.
 *
 * These tests assert the property from both ends: the pure grouping function
 * that splits candidates, and a real run through Normalize -> Identity -> Gate
 * -> Apply that must produce two published events and no review items.
 */

const GAME_SLUG = `ingest-region-test-${crypto.randomUUID()}`;
const NOW = new Date("2026-09-04T20:00:00.000Z");

let installId: string;

type WireRow = { id: string; name: string; code: string; date: string };

/** One product. The Japanese street date is 98 days ahead of the global one -- Delta Reign's real gap. */
const GLOBAL_ROWS: WireRow[] = [{ id: "g-1", name: "Delta Reign", code: "DLR", date: "2026-11-06T00:00:00.000Z" }];
const JP_ROWS: WireRow[] = [{ id: "j-1", name: "Delta Reign", code: "DLR", date: "2026-07-31T00:00:00.000Z" }];

function makeProvider(params: {
  key: string;
  origin: string;
  tier: Provider["tier"];
  region: Candidate["region"];
}): Provider {
  return {
    key: params.key,
    origin: params.origin,
    tier: params.tier,
    games: [GAME_SLUG],
    async fetch() {
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
          region: params.region,
          type: "SHELF",
          url: `https://${params.key}.example/${row.id}`,
        }),
      );
    },
  };
}

// Both OFFICIAL, so each region publishes on G1 the first time it is seen and
// the test is about region alone rather than about corroboration streaks.
const globalProvider = makeProvider({
  key: "region-test-global",
  origin: "pokemon-official",
  tier: "OFFICIAL",
  region: "GLOBAL",
});
const jpProvider = makeProvider({
  key: "region-test-jp",
  origin: "konami-official",
  tier: "OFFICIAL",
  region: "JP",
});

async function seedRun(): Promise<string> {
  const run = await prisma.scanRun.create({
    data: {
      scopeType: "INSTALL",
      scopeId: installId,
      trigger: "SCHEDULED",
      status: "SUCCEEDED",
      startedAt: NOW,
      finishedAt: NOW,
    },
  });

  for (const { provider, rows } of [
    { provider: globalProvider, rows: GLOBAL_ROWS },
    { provider: jpProvider, rows: JP_ROWS },
  ]) {
    const { body, contentHash } = packPayloadBody(rows);
    await prisma.rawPayload.create({
      data: { scanRunId: run.id, providerKey: provider.key, contentHash, body, fetchedAt: NOW },
    });
    await prisma.providerRun.create({
      data: {
        scanRunId: run.id,
        providerKey: provider.key,
        status: "OK",
        candidates: rows.length,
        startedAt: NOW,
        finishedAt: NOW,
      },
    });
  }

  return run.id;
}

beforeAll(async () => {
  const pkg = await prisma.tcgProfilePackage.create({
    data: {
      slug: GAME_SLUG,
      name: "Ingest Region Test",
      version: "1.0.0",
      discoveryConfig: {},
      sourceConfigs: {},
    },
  });
  const install = await prisma.tcgProfileInstall.create({
    data: { packageId: pkg.id, installedVersion: "1.0.0", enabled: true },
  });
  installId = install.id;

  registerProvider(globalProvider);
  registerProvider(jpProvider);
});

afterAll(async () => {
  unregisterProvider(globalProvider.key);
  unregisterProvider(jpProvider.key);
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// The pure half
// ---------------------------------------------------------------------------

function resolvedCandidate(overrides: Partial<ResolvedCandidate> = {}): ResolvedCandidate {
  return {
    origin: "pokemon-official",
    game: GAME_SLUG,
    externalIds: {},
    name: "Delta Reign",
    code: "DLR",
    date: { kind: "EXACT", date: new Date("2026-11-06T00:00:00.000Z") },
    region: "GLOBAL",
    type: "SHELF",
    tier: "OFFICIAL",
    resolution: { productSetId: "set-1", matchedBy: "code" },
    ...overrides,
  };
}

describe("groupResolvedCandidates", () => {
  it("splits one product's global and Japanese dates into two groups", () => {
    const groups = groupResolvedCandidates([
      resolvedCandidate(),
      resolvedCandidate({ region: "JP", date: { kind: "EXACT", date: new Date("2026-07-31T00:00:00.000Z") } }),
    ]);

    expect(groups.size).toBe(2);
    expect([...groups.keys()].sort()).toEqual(
      [eventGroupKey("set-1", "SHELF", "GLOBAL"), eventGroupKey("set-1", "SHELF", "JP")].sort(),
    );
    for (const group of groups.values()) {
      expect(group.entries).toHaveLength(1);
      expect(group.region).toBe(group.entries[0].region);
    }
  });

  it("still groups two origins in the same region together", () => {
    // The corroboration path must be untouched: same product, same region, two
    // origins is one event with two claims, which is what gate rule G2 reads.
    const groups = groupResolvedCandidates([
      resolvedCandidate(),
      resolvedCandidate({ origin: "tcgplayer", tier: "RETAILER" }),
    ]);
    expect(groups.size).toBe(1);
    expect([...groups.values()][0].entries).toHaveLength(2);
  });

  it("keeps type and region independent", () => {
    const groups = groupResolvedCandidates([
      resolvedCandidate(),
      resolvedCandidate({ type: "PRERELEASE" }),
      resolvedCandidate({ region: "JP" }),
      resolvedCandidate({ region: "JP", type: "PRERELEASE" }),
    ]);
    expect(groups.size).toBe(4);
  });

  it("never lets two regions' claims reach the gate together, so G5 cannot fire on them", () => {
    // Stated as the gate would see it. Fused, these two claims are 98 days apart
    // and both OFFICIAL, so both qualify and G5 flags the event. Split by
    // region, each side publishes cleanly under G1 -- and no amount of tuning
    // the gate could have produced that, because the fused question has no right
    // answer.
    const globalClaim: ClaimRecord = {
      origin: "pokemon-official",
      tier: "OFFICIAL",
      date: { kind: "EXACT", date: new Date("2026-11-06T00:00:00.000Z") },
      consecutiveRuns: 1,
      seenInCurrentRun: true,
      lastSeenAt: NOW,
    };
    const jpClaim: ClaimRecord = {
      ...globalClaim,
      origin: "konami-official",
      date: { kind: "EXACT", date: new Date("2026-07-31T00:00:00.000Z") },
    };

    const fused = evaluateGate({ now: NOW, claims: [globalClaim, jpClaim], published: null });
    expect(fused.action).toBe("FLAG");
    expect(fused.rule).toBe("G5");

    for (const claim of [globalClaim, jpClaim]) {
      const verdict = evaluateGate({ now: NOW, claims: [claim], published: null });
      expect(verdict.action).toBe("PUBLISH");
      expect(verdict.rule).toBe("G1");
      expect(verdict.date).toEqual(claim.date);
    }
  });
});

// ---------------------------------------------------------------------------
// The database half
// ---------------------------------------------------------------------------

describe("findOrCreateReleaseEvent scopes by region", () => {
  let productSetId: string;

  beforeAll(async () => {
    const set = await prisma.productSet.create({
      data: { tcgProfileInstallId: installId, code: `RGN-${crypto.randomUUID()}`, name: "Region Repo Test Set" },
    });
    productSetId = set.id;
  });

  it("creates one event per region and reuses each of them", async () => {
    const date = { kind: "EXACT", date: new Date("2026-11-06T00:00:00.000Z") } as const;
    const globalEvent = await ingestRepo.findOrCreateReleaseEvent({ productSetId, type: "SHELF", region: "GLOBAL", date });
    const jpEvent = await ingestRepo.findOrCreateReleaseEvent({ productSetId, type: "SHELF", region: "JP", date });

    expect(jpEvent.id).not.toBe(globalEvent.id);
    expect(globalEvent.region).toBe("GLOBAL");
    expect(jpEvent.region).toBe("JP");

    // Idempotent per region: a second run resolves the same two rows rather than
    // making a third.
    const again = await ingestRepo.findOrCreateReleaseEvent({ productSetId, type: "SHELF", region: "JP", date });
    expect(again.id).toBe(jpEvent.id);
    expect(
      await prisma.releaseEvent.count({ where: { productSetId, type: "SHELF", archivedAt: null } }),
    ).toBe(2);
  });
});

describe("a run carrying two regions", () => {
  it("publishes both dates, on two events, with nothing flagged for review", async () => {
    const scanRunId = await seedRun();

    const totals = await runStagesFromPayloads({
      scanRunId,
      now: NOW,
      installs: [{ id: installId, package: { slug: GAME_SLUG } }],
    });

    expect(totals.parseErrors).toBe(0);
    expect(totals.errors).toBe(0);
    // One product, not two: the two rows share a set code, so identity puts them
    // on one ProductSet -- which is the precondition for the region split to be
    // the thing that separates them.
    expect(totals.productSetsCreated).toBe(1);
    expect(totals.eventsPublished).toBe(2);
    // The whole point. Before phase 4 this was 1 (G5 CONFLICT).
    expect(totals.eventsFlagged).toBe(0);
    expect(totals.reviewItemsOpened).toBe(0);

    const events = await prisma.releaseEvent.findMany({
      where: { productSet: { tcgProfileInstallId: installId, name: "Delta Reign" }, type: "SHELF" },
      select: { region: true, dateExact: true, status: true, productSetId: true },
      orderBy: { region: "asc" },
    });
    expect(events).toHaveLength(2);
    expect(new Set(events.map((event) => event.productSetId)).size).toBe(1);
    expect(events.map((event) => [event.region, event.dateExact?.toISOString()])).toEqual([
      ["GLOBAL", "2026-11-06T00:00:00.000Z"],
      ["JP", "2026-07-31T00:00:00.000Z"],
    ]);

    const reviewItems = await prisma.reviewItem.count({
      where: { releaseEvent: { productSet: { tcgProfileInstallId: installId } } },
    });
    expect(reviewItems).toBe(0);
  });

  it("keeps each region's claim in its own slot", async () => {
    // Region reaches the claim idempotency key through the event id: a claim is
    // keyed (scanRunId, origin, releaseEventId), and an event is now a
    // (productSet, type, region). Without that, one origin reporting two regions
    // in one run would have written one claim twice and kept only the later
    // date.
    const claims = await prisma.sourceClaim.findMany({
      where: { releaseEvent: { productSet: { tcgProfileInstallId: installId } }, origin: { not: null } },
      select: { origin: true, dateExact: true, releaseEvent: { select: { region: true } } },
      orderBy: { origin: "asc" },
    });

    expect(claims).toHaveLength(2);
    expect(new Set(claims.map((claim) => claim.releaseEvent.region))).toEqual(new Set(["GLOBAL", "JP"]));
  });
});

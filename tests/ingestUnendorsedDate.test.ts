import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GATE_THRESHOLDS } from "@/lib/ingest/gate";
import { decodePayloadBody } from "@/lib/ingest/normalize";
import { packPayloadBody, runStagesFromPayloads } from "@/lib/ingest/orchestrate";
import { registerProvider, unregisterProvider } from "@/lib/ingest/providers/registry";
import type { Provider } from "@/lib/ingest/providers/types";
import { prisma } from "@/lib/prisma";
import type { Candidate, RunDiffChange } from "@/lib/ingest/types";

/**
 * A date reaches the calendar only when a gate rule puts it there.
 *
 * That sounds like a restatement of gate.ts's whole design, and it was one --
 * until you noticed that findOrCreateReleaseEvent used to seed a brand new row
 * with the first candidate's date. getPublishedState then read that seed back
 * as "what this event already shows", so a HOLD verdict (which says "don't move
 * it" by restating the published date) restated a date no rule had endorsed.
 * Every event published its first claim's date on sight, and then froze there,
 * because every later run held the same value.
 *
 * Rule G3 was hit hardest, and is what this file mostly tests: its entire
 * purpose is that a lone retailer date -- the tier most prone to end-of-month
 * placeholders -- must hold still for seven runs before anyone believes it.
 * Seeding published it on run one, leaving G3 with nothing to gate.
 *
 * A single RETAILER provider, so no other rule can fire and the streak is the
 * only route to publication.
 */

const GAME_SLUG = `unendorsed-date-test-${crypto.randomUUID()}`;
const NOW = new Date("2026-06-01T00:00:00.000Z");
const STREET_DATE = "2026-11-06T00:00:00.000Z";

let installId: string;
let runCounter = 0;

type WireRow = { id: string; name: string; date: string };

const retailer: Provider = {
  key: "unendorsed-date-test-retailer",
  origin: "tcgplayer",
  tier: "RETAILER",
  games: [GAME_SLUG],
  async fetch() {
    throw new Error("network access attempted by provider unendorsed-date-test-retailer");
  },
  parse(payload) {
    return (decodePayloadBody(payload) as WireRow[]).map(
      (row): Candidate => ({
        origin: "tcgplayer",
        game: GAME_SLUG,
        externalIds: { tcgplayer: row.id },
        name: row.name,
        code: null,
        date: { kind: "EXACT", date: new Date(row.date) },
        region: "GLOBAL",
        type: "SHELF",
        url: `https://tcgplayer.example/${row.id}`,
      }),
    );
  },
};

async function runWith(rows: WireRow[]) {
  runCounter += 1;
  const at = new Date(NOW.getTime() + runCounter * 60_000);

  const run = await prisma.scanRun.create({
    data: {
      scopeType: "INSTALL",
      scopeId: installId,
      trigger: "SCHEDULED",
      status: "SUCCEEDED",
      startedAt: at,
      finishedAt: at,
    },
  });

  const { body, contentHash } = packPayloadBody(rows);
  await prisma.rawPayload.create({
    data: { scanRunId: run.id, providerKey: retailer.key, contentHash, body, fetchedAt: at },
  });
  await prisma.providerRun.create({
    data: {
      scanRunId: run.id,
      providerKey: retailer.key,
      status: "OK",
      candidates: rows.length,
      startedAt: at,
      finishedAt: at,
    },
  });

  await runStagesFromPayloads({
    scanRunId: run.id,
    now: at,
    installs: [{ id: installId, package: { slug: GAME_SLUG } }],
  });

  const diff = await prisma.runDiff.findUnique({ where: { scanRunId: run.id } });
  return (diff?.changes ?? []) as unknown as RunDiffChange[];
}

function eventFor(setName: string) {
  return prisma.releaseEvent.findFirstOrThrow({
    where: { type: "SHELF", productSet: { tcgProfileInstallId: installId, name: setName } },
  });
}

beforeAll(async () => {
  const pkg = await prisma.tcgProfilePackage.create({
    data: {
      slug: GAME_SLUG,
      name: "Unendorsed Date Test",
      version: "1.0.0",
      discoveryConfig: {},
      sourceConfigs: {},
    },
  });
  const install = await prisma.tcgProfileInstall.create({
    data: { packageId: pkg.id, installedVersion: "1.0.0", enabled: true },
  });
  installId = install.id;

  registerProvider(retailer);
});

afterAll(async () => {
  unregisterProvider(retailer.key);
  await prisma.$disconnect();
});

describe("a claim that satisfies no gate rule", () => {
  it("creates the event but publishes no date on the run it first appears", async () => {
    const setName = `First Sighting ${crypto.randomUUID().slice(0, 8)}`;
    const changes = await runWith([{ id: setName, name: setName, date: STREET_DATE }]);

    const event = await eventFor(setName);
    expect(event.dateType).toBe("TBD");
    expect(event.dateExact).toBeNull();
    expect(event.status).toBe("RUMORED");

    const change = changes.find((c) => c.releaseEventId === event.id);
    expect(change?.action).toBe("HOLD");
    expect(change?.reason).toBe("AWAITING_CORROBORATION");
    // Nothing was published before this run, so the diff says so rather than
    // reporting the row's own default as a prior state.
    expect(change?.statusBefore).toBeNull();
    expect(change?.before).toBeNull();
  });

  it("keeps the evidence even while refusing to show it", async () => {
    const setName = `Evidence Kept ${crypto.randomUUID().slice(0, 8)}`;
    await runWith([{ id: setName, name: setName, date: STREET_DATE }]);

    // The date is not lost, it is just not endorsed: it is on the claim, which
    // is where a reviewer can see it and where the streak is counted from.
    const event = await eventFor(setName);
    const claims = await prisma.sourceClaim.findMany({ where: { releaseEventId: event.id } });
    expect(claims).toHaveLength(1);
    expect(claims[0].dateExact?.toISOString()).toBe(STREET_DATE);
  });
});

describe("G3's seven-run streak, which the seeded date used to short-circuit", () => {
  it("holds for six runs and publishes on the seventh", async () => {
    const setName = `Slow Burn ${crypto.randomUUID().slice(0, 8)}`;
    const rows = [{ id: setName, name: setName, date: STREET_DATE }];

    for (let run = 1; run < GATE_THRESHOLDS.retailerCorroborationRuns; run++) {
      await runWith(rows);
      const event = await eventFor(setName);
      expect(event.dateType, `run ${run} should still be holding`).toBe("TBD");
    }

    const changes = await runWith(rows);
    const event = await eventFor(setName);
    expect(event.dateType).toBe("EXACT");
    expect(event.dateExact?.toISOString()).toBe(STREET_DATE);

    const change = changes.find((c) => c.releaseEventId === event.id);
    expect(change?.action).toBe("PUBLISH");
    expect(change?.rule).toBe("G3");
    expect(change?.reason).toBe("RETAILER_STREAK");
  });

  it("restarts the streak when the retailer's date moves, which is the placeholder churn G3 exists for", async () => {
    const setName = `Churning ${crypto.randomUUID().slice(0, 8)}`;

    // Six runs of an end-of-month placeholder...
    for (let run = 1; run < GATE_THRESHOLDS.retailerCorroborationRuns; run++) {
      await runWith([{ id: setName, name: setName, date: "2026-11-30T00:00:00.000Z" }]);
    }
    // ...then the real date lands. The streak starts over, so nothing publishes.
    await runWith([{ id: setName, name: setName, date: STREET_DATE }]);

    const event = await eventFor(setName);
    expect(event.dateType).toBe("TBD");
  });
});

describe("what still publishes immediately", () => {
  it("an event whose evidence does satisfy a rule -- the fix costs nothing there", async () => {
    // Same retailer, but seven runs deep, is the closest single-provider
    // analogue of "a rule fired": the point is that once one does, the date is
    // written by the verdict and not by the row's creation.
    const setName = `Qualified ${crypto.randomUUID().slice(0, 8)}`;
    const rows = [{ id: setName, name: setName, date: STREET_DATE }];
    for (let run = 0; run < GATE_THRESHOLDS.retailerCorroborationRuns; run++) {
      await runWith(rows);
    }

    const event = await eventFor(setName);
    expect(event.dateExact?.toISOString()).toBe(STREET_DATE);
    expect(event.status).not.toBe("RUMORED");
  });
});

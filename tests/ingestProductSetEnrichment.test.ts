import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodePayloadBody } from "@/lib/ingest/normalize";
import { packPayloadBody, runStagesFromPayloads } from "@/lib/ingest/orchestrate";
import { registerProvider, unregisterProvider } from "@/lib/ingest/providers/registry";
import type { Provider } from "@/lib/ingest/providers/types";
import { prisma } from "@/lib/prisma";
import type { Candidate } from "@/lib/ingest/types";

/**
 * ProductSet.imageUrl (premium marketing image) and ProductSet.description
 * (free, signed-in) are the two fields no origin has to agree on -- they never
 * reach the gate, because there is no claim to reconcile, only a first origin
 * to supply one.
 *
 * The case that matters most here is the *second* run. `description` shipped
 * wired into createProductSet only, so it could reach a set exactly once, at
 * discovery -- and since every set in a mature catalogue was discovered by an
 * earlier run, it stayed null on every row in production forever. imageUrl
 * arrived later with the v2 providers and was dropped entirely. Both are now
 * filled by enrichProductSet on whichever run first sees a value, which is
 * what these tests pin down.
 */

const GAME_SLUG = `ingest-enrichment-test-${crypto.randomUUID()}`;
const NOW = new Date("2026-09-07T20:00:00.000Z");

const IMAGE = "https://svgs.example/sets/abc.svg";
const DESCRIPTION = "A 254-card expansion set.";

let installId: string;
let runCounter = 0;

type WireRow = { id: string; name: string; date: string; imageUrl?: string; description?: string };

const provider: Provider = {
  key: "enrichment-test-provider",
  origin: "bulbapedia",
  tier: "COMMUNITY",
  games: [GAME_SLUG],
  async fetch() {
    throw new Error("network access attempted by provider enrichment-test-provider");
  },
  parse(payload) {
    const rows = decodePayloadBody(payload) as WireRow[];
    return rows.map(
      (row): Candidate => ({
        origin: "bulbapedia",
        game: GAME_SLUG,
        externalIds: { bulbapedia: row.id },
        name: row.name,
        code: null,
        date: { kind: "EXACT", date: new Date(row.date) },
        region: "GLOBAL",
        type: "SHELF",
        url: `https://bulbapedia.example/${row.id}`,
        ...(row.imageUrl ? { imageUrl: row.imageUrl } : {}),
        ...(row.description ? { description: row.description } : {}),
      }),
    );
  },
};

async function runWith(rows: WireRow[]) {
  runCounter += 1;
  const at = new Date(NOW.getTime() + runCounter * 1000);

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
    data: { scanRunId: run.id, providerKey: provider.key, contentHash, body, fetchedAt: at },
  });
  await prisma.providerRun.create({
    data: {
      scanRunId: run.id,
      providerKey: provider.key,
      status: "OK",
      candidates: rows.length,
      startedAt: at,
      finishedAt: at,
    },
  });

  return runStagesFromPayloads({
    scanRunId: run.id,
    now: at,
    installs: [{ id: installId, package: { slug: GAME_SLUG } }],
  });
}

function setNamed(name: string) {
  return prisma.productSet.findFirstOrThrow({ where: { tcgProfileInstallId: installId, name } });
}

beforeAll(async () => {
  const pkg = await prisma.tcgProfilePackage.create({
    data: {
      slug: GAME_SLUG,
      name: "Ingest Enrichment Test",
      version: "1.0.0",
      discoveryConfig: {},
      sourceConfigs: {},
    },
  });
  const install = await prisma.tcgProfileInstall.create({
    data: { packageId: pkg.id, installedVersion: "1.0.0", enabled: true },
  });
  installId = install.id;

  registerProvider(provider);
});

afterAll(async () => {
  unregisterProvider(provider.key);
  await prisma.$disconnect();
});

describe("ProductSet image/description enrichment", () => {
  it("backfills a set that already existed before any origin supplied an image", async () => {
    // Run 1: the set is discovered with neither field, exactly as every set in
    // the production catalogue was.
    const first = await runWith([{ id: "w-1", name: "Backfilled Set", date: "2026-11-06T00:00:00.000Z" }]);
    expect(first.errors).toBe(0);
    expect(first.productSetsCreated).toBe(1);
    expect(first.productSetsEnriched).toBe(0);

    const created = await setNamed("Backfilled Set");
    expect(created.imageUrl).toBeNull();
    expect(created.description).toBeNull();

    // Run 2: the same origin now publishes both. The set is resolved, not
    // created -- so a create-time-only field would never reach it.
    const second = await runWith([
      {
        id: "w-1",
        name: "Backfilled Set",
        date: "2026-11-06T00:00:00.000Z",
        imageUrl: IMAGE,
        description: DESCRIPTION,
      },
    ]);
    expect(second.productSetsCreated).toBe(0);
    expect(second.productSetsEnriched).toBe(1);

    const enriched = await setNamed("Backfilled Set");
    expect(enriched.id).toBe(created.id);
    expect(enriched.imageUrl).toBe(IMAGE);
    expect(enriched.description).toBe(DESCRIPTION);
  });

  it("does not rewrite a set whose fields are already populated", async () => {
    const totals = await runWith([
      {
        id: "w-1",
        name: "Backfilled Set",
        date: "2026-11-06T00:00:00.000Z",
        imageUrl: IMAGE,
        description: DESCRIPTION,
      },
    ]);

    // The nightly run must settle at zero once every set is filled, or the
    // counter tells us nothing and the catalogue is rewritten every night.
    expect(totals.productSetsEnriched).toBe(0);
  });

  it("keeps the first value rather than letting a later origin overwrite it", async () => {
    const totals = await runWith([
      {
        id: "w-1",
        name: "Backfilled Set",
        date: "2026-11-06T00:00:00.000Z",
        imageUrl: "https://svgs.example/sets/DIFFERENT.svg",
        description: "A completely different description.",
      },
    ]);

    expect(totals.productSetsEnriched).toBe(0);
    const unchanged = await setNamed("Backfilled Set");
    expect(unchanged.imageUrl).toBe(IMAGE);
    expect(unchanged.description).toBe(DESCRIPTION);
  });

  it("populates a brand new set at creation time, without a second write", async () => {
    const totals = await runWith([
      {
        id: "w-2",
        name: "Freshly Discovered Set",
        date: "2026-12-04T00:00:00.000Z",
        imageUrl: IMAGE,
        description: DESCRIPTION,
      },
    ]);

    expect(totals.productSetsCreated).toBe(1);
    // Created with both fields already set, so enrichment finds nothing to do.
    expect(totals.productSetsEnriched).toBe(0);

    const created = await setNamed("Freshly Discovered Set");
    expect(created.imageUrl).toBe(IMAGE);
    expect(created.description).toBe(DESCRIPTION);
  });

  it("fills only the missing field when the other is already set", async () => {
    await runWith([{ id: "w-3", name: "Half Filled Set", date: "2027-01-08T00:00:00.000Z", imageUrl: IMAGE }]);

    const afterCreate = await setNamed("Half Filled Set");
    expect(afterCreate.imageUrl).toBe(IMAGE);
    expect(afterCreate.description).toBeNull();

    const totals = await runWith([
      {
        id: "w-3",
        name: "Half Filled Set",
        date: "2027-01-08T00:00:00.000Z",
        imageUrl: "https://svgs.example/sets/IGNORED.svg",
        description: DESCRIPTION,
      },
    ]);

    expect(totals.productSetsEnriched).toBe(1);
    const filled = await setNamed("Half Filled Set");
    expect(filled.description).toBe(DESCRIPTION);
    expect(filled.imageUrl).toBe(IMAGE); // not the "IGNORED" one
  });
});

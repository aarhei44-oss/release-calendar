import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodePayloadBody } from "@/lib/ingest/normalize";
import { packPayloadBody, runStagesFromPayloads } from "@/lib/ingest/orchestrate";
import { registerProvider, unregisterProvider } from "@/lib/ingest/providers/registry";
import type { Provider } from "@/lib/ingest/providers/types";
import { prisma } from "@/lib/prisma";
import type { Candidate } from "@/lib/ingest/types";

/**
 * ProductSet.code is NOT NULL (the former TODO(phase5)), but a code-less
 * origin (a wiki) can still be the first to see a brand new product -- no
 * source has published a code for it yet. orchestrate.ts invents one
 * (synthesizeProductSetCode) rather than blocking the run, and marks it
 * codeIsSynthetic so identity.ts's code tier never treats the invention as a
 * fact a source printed (see the "never matches a stored set's synthetic
 * code" case in ingestIdentity.test.ts for the matching-side guarantee).
 */

const GAME_SLUG = `ingest-synthetic-code-test-${crypto.randomUUID()}`;
const NOW = new Date("2026-09-04T20:00:00.000Z");

let installId: string;

type WireRow = { id: string; name: string; date: string };

const ROWS: WireRow[] = [{ id: "w-1", name: "Some Brand New Set", date: "2026-11-06T00:00:00.000Z" }];

const wikiProvider: Provider = {
  key: "synthetic-code-test-wiki",
  origin: "bulbapedia",
  tier: "COMMUNITY",
  games: [GAME_SLUG],
  async fetch() {
    throw new Error("network access attempted by provider synthetic-code-test-wiki");
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
      }),
    );
  },
};

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

  const { body, contentHash } = packPayloadBody(ROWS);
  await prisma.rawPayload.create({
    data: { scanRunId: run.id, providerKey: wikiProvider.key, contentHash, body, fetchedAt: NOW },
  });
  await prisma.providerRun.create({
    data: {
      scanRunId: run.id,
      providerKey: wikiProvider.key,
      status: "OK",
      candidates: ROWS.length,
      startedAt: NOW,
      finishedAt: NOW,
    },
  });

  return run.id;
}

beforeAll(async () => {
  const pkg = await prisma.tcgProfilePackage.create({
    data: {
      slug: GAME_SLUG,
      name: "Ingest Synthetic Code Test",
      version: "1.0.0",
      discoveryConfig: {},
      sourceConfigs: {},
    },
  });
  const install = await prisma.tcgProfileInstall.create({
    data: { packageId: pkg.id, installedVersion: "1.0.0", enabled: true },
  });
  installId = install.id;

  registerProvider(wikiProvider);
});

afterAll(async () => {
  unregisterProvider(wikiProvider.key);
  await prisma.$disconnect();
});

describe("ProductSet.code synthesis for code-less origins", () => {
  it("invents a code and marks it synthetic when the only candidate has none", async () => {
    const scanRunId = await seedRun();

    const totals = await runStagesFromPayloads({
      scanRunId,
      now: NOW,
      installs: [{ id: installId, package: { slug: GAME_SLUG } }],
    });

    expect(totals.parseErrors).toBe(0);
    expect(totals.errors).toBe(0);
    expect(totals.productSetsCreated).toBe(1);

    const productSet = await prisma.productSet.findFirstOrThrow({
      where: { tcgProfileInstallId: installId, name: "Some Brand New Set" },
    });
    expect(productSet.codeIsSynthetic).toBe(true);
    expect(productSet.code).toMatch(/^SYN-/);
  });

  it("resolves the same product by pinned id on a second run, without minting a second synthetic code", async () => {
    const before = await prisma.productSet.findFirstOrThrow({
      where: { tcgProfileInstallId: installId, name: "Some Brand New Set" },
    });

    const scanRunId = await seedRun();
    const totals = await runStagesFromPayloads({
      scanRunId,
      now: new Date(NOW.getTime() + 1000),
      installs: [{ id: installId, package: { slug: GAME_SLUG } }],
    });

    expect(totals.productSetsCreated).toBe(0);
    const after = await prisma.productSet.findFirstOrThrow({
      where: { tcgProfileInstallId: installId, name: "Some Brand New Set" },
    });
    expect(after.id).toBe(before.id);
    expect(after.code).toBe(before.code);
  });
});

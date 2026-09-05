import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodePayloadBody } from "@/lib/ingest/normalize";
import { packPayloadBody, runStagesFromPayloads } from "@/lib/ingest/orchestrate";
import { registerProvider, unregisterProvider } from "@/lib/ingest/providers/registry";
import type { Provider } from "@/lib/ingest/providers/types";
import { prisma } from "@/lib/prisma";
import type { Candidate } from "@/lib/ingest/types";

/**
 * ProviderRun.candidates was always 0: the Fetch stage's recordProviderRun
 * call (lib/ingest/orchestrate.ts's fetchProvider) runs before parsing, so it
 * could only ever write the default. Nothing updated it afterward with the
 * real count from Normalize, which defeated the admin System tab's per-
 * provider health column (its own doc comment: "0 with status OK is itself a
 * signal worth alerting on" -- true of every provider, always, by
 * construction, not because anything was actually wrong).
 *
 * Only surfaced by running the pipeline against real payloads in production
 * for the first time; every prior test seeded ProviderRun rows directly with
 * the "right" count already in them, which is why this went unnoticed.
 */

const GAME_SLUG = `ingest-candidate-count-test-${crypto.randomUUID()}`;
const NOW = new Date("2026-09-05T12:00:00.000Z");

let installId: string;

type WireRow = { id: string; name: string; date: string };

const ROWS: WireRow[] = [
  { id: "c-1", name: "Row One", date: "2026-11-06T00:00:00.000Z" },
  { id: "c-2", name: "Row Two", date: "2026-11-13T00:00:00.000Z" },
  { id: "c-3", name: "Row Three", date: "2026-11-20T00:00:00.000Z" },
];

const provider: Provider = {
  key: "candidate-count-test-provider",
  origin: "candidate-count-test-origin",
  tier: "COMMUNITY",
  games: [GAME_SLUG],
  async fetch() {
    throw new Error("network access attempted by provider candidate-count-test-provider");
  },
  parse(payload) {
    const rows = decodePayloadBody(payload) as WireRow[];
    return rows.map(
      (row): Candidate => ({
        origin: "candidate-count-test-origin",
        game: GAME_SLUG,
        externalIds: { "candidate-count-test-origin": row.id },
        name: row.name,
        code: `CC-${row.id}`,
        date: { kind: "EXACT", date: new Date(row.date) },
        region: "GLOBAL",
        type: "SHELF",
        url: `https://candidate-count-test.example/${row.id}`,
      }),
    );
  },
};

beforeAll(async () => {
  const pkg = await prisma.tcgProfilePackage.create({
    data: {
      slug: GAME_SLUG,
      name: "Ingest Candidate Count Test",
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

describe("ProviderRun.candidates", () => {
  it("is backfilled with the real parsed count, not left at fetchProvider's 0", async () => {
    const run = await prisma.scanRun.create({
      data: { scopeType: "INSTALL", scopeId: installId, trigger: "SCHEDULED", status: "SUCCEEDED", startedAt: NOW, finishedAt: NOW },
    });
    const { body, contentHash } = packPayloadBody(ROWS);
    await prisma.rawPayload.create({
      data: { scanRunId: run.id, providerKey: provider.key, contentHash, body, fetchedAt: NOW },
    });
    // Mirrors fetchProvider's real write: status known, candidates not yet --
    // parsing hasn't happened at fetch time, so it can only ever be 0 there.
    await prisma.providerRun.create({
      data: { scanRunId: run.id, providerKey: provider.key, status: "OK", candidates: 0, startedAt: NOW, finishedAt: NOW },
    });

    await runStagesFromPayloads({ scanRunId: run.id, now: NOW, installs: [{ id: installId, package: { slug: GAME_SLUG } }] });

    const providerRun = await prisma.providerRun.findUniqueOrThrow({
      where: { scanRunId_providerKey: { scanRunId: run.id, providerKey: provider.key } },
    });
    expect(providerRun.candidates).toBe(3);
  });
});

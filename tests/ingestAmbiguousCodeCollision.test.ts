import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodePayloadBody } from "@/lib/ingest/normalize";
import { packPayloadBody, runStagesFromPayloads } from "@/lib/ingest/orchestrate";
import { registerProvider, unregisterProvider } from "@/lib/ingest/providers/registry";
import type { Provider } from "@/lib/ingest/providers/types";
import { prisma } from "@/lib/prisma";
import type { Candidate } from "@/lib/ingest/types";

/**
 * Real production bug, found running v2 against real tcgcsv data for the
 * first time: TCGCSV hands the abbreviation "POP" to all nine Pokemon POP
 * Series sets (and "PR" to four unrelated promo sets). identity.ts's
 * ambiguousCodes guard correctly refuses to code-match on "POP" -- matching
 * would fuse nine different products into one -- so every one of those nine
 * candidates resolves "new". Before this fix, every one of them then tried to
 * write the literal string "POP" into ProductSet.code, which is unique on
 * (install, code): the first succeeded and the other eight threw, failing the
 * entire scan run for every other game batched into the same trigger.
 *
 * The fix (lib/ingest/orchestrate.ts's resolveInstallCandidates) treats an
 * ambiguous or already-claimed literal code the same way it already treats a
 * missing one: synthesize instead of writing the shared string raw.
 */

const GAME_SLUG = `ingest-ambiguous-code-test-${crypto.randomUUID()}`;
const NOW = new Date("2026-09-05T12:00:00.000Z");

let installId: string;

type WireRow = { id: string; name: string; code: string; date: string };

// Nine unrelated products, all sharing tcgcsv's real ambiguous "POP" abbreviation.
const ROWS: WireRow[] = Array.from({ length: 9 }, (_, i) => ({
  id: `pop-${i + 1}`,
  name: `POP Series ${i + 1}`,
  code: "POP",
  date: `2026-09-${String(6 + i).padStart(2, "0")}T00:00:00.000Z`,
}));

const provider: Provider = {
  key: "ambiguous-code-test-provider",
  origin: "ambiguous-code-test-origin",
  tier: "RETAILER",
  games: [GAME_SLUG],
  async fetch() {
    throw new Error("network access attempted by provider ambiguous-code-test-provider");
  },
  parse(payload) {
    const rows = decodePayloadBody(payload) as WireRow[];
    return rows.map(
      (row): Candidate => ({
        origin: "ambiguous-code-test-origin",
        game: GAME_SLUG,
        externalIds: { "ambiguous-code-test-origin": row.id },
        name: row.name,
        code: row.code,
        date: { kind: "EXACT", date: new Date(row.date) },
        region: "GLOBAL",
        type: "SHELF",
        url: `https://ambiguous-code-test.example/${row.id}`,
      }),
    );
  },
};

beforeAll(async () => {
  const pkg = await prisma.tcgProfilePackage.create({
    data: { slug: GAME_SLUG, name: "Ingest Ambiguous Code Test", version: "1.0.0", discoveryConfig: {}, sourceConfigs: {} },
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

describe("an ambiguous code shared by many products", () => {
  it("creates all nine sets instead of crashing on the DB's unique constraint", async () => {
    const run = await prisma.scanRun.create({
      data: { scopeType: "INSTALL", scopeId: installId, trigger: "SCHEDULED", status: "SUCCEEDED", startedAt: NOW, finishedAt: NOW },
    });
    const { body, contentHash } = packPayloadBody(ROWS);
    await prisma.rawPayload.create({
      data: { scanRunId: run.id, providerKey: provider.key, contentHash, body, fetchedAt: NOW },
    });
    await prisma.providerRun.create({
      data: { scanRunId: run.id, providerKey: provider.key, status: "OK", candidates: 0, startedAt: NOW, finishedAt: NOW },
    });

    const totals = await runStagesFromPayloads({ scanRunId: run.id, now: NOW, installs: [{ id: installId, package: { slug: GAME_SLUG } }] });

    expect(totals.errors).toBe(0);
    expect(totals.productSetsCreated).toBe(9);

    const sets = await prisma.productSet.findMany({ where: { tcgProfileInstallId: installId }, orderBy: { name: "asc" } });
    expect(sets).toHaveLength(9);
    // None of them kept the literal ambiguous code -- it isn't a fact any one
    // of these nine products actually owns, so none of them should look like
    // it is.
    expect(sets.every((set) => set.code !== "POP")).toBe(true);
    expect(sets.every((set) => set.codeIsSynthetic)).toBe(true);
    expect(new Set(sets.map((set) => set.code)).size).toBe(9);
  });
});

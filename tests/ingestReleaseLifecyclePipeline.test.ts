import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodePayloadBody } from "@/lib/ingest/normalize";
import { packPayloadBody, runStagesFromPayloads } from "@/lib/ingest/orchestrate";
import { registerProvider, unregisterProvider } from "@/lib/ingest/providers/registry";
import type { Provider } from "@/lib/ingest/providers/types";
import { prisma } from "@/lib/prisma";
import type { Candidate, RunDiffChange } from "@/lib/ingest/types";

/**
 * The release lifecycle inside the whole pipeline, on the hazard that motivated
 * the gate's "stay RELEASED" rule.
 *
 * Providers keep listing a product for 90 days after it ships. If the gate
 * re-scored such an event CONFIRMED on every run, the lifecycle pass would flip
 * it back to RELEASED each night, every run's diff would carry a status change,
 * and followers would be mailed a "status changed" alert nightly. These tests run
 * the real stages over stored payloads and assert at the database and the diff.
 */

const GAME_SLUG = "magic-the-gathering";
const SHELF_DATE = "2026-07-24T00:00:00.000Z"; // a Friday
const PRERELEASE_DATE = "2026-07-17T00:00:00.000Z";

let installId: string;

type WireRow = { id: string; name: string; date: string };

function makeProvider(key: string, origin: "wikipedia" | "tcgplayer"): Provider {
  return {
    key,
    origin,
    tier: origin === "wikipedia" ? "COMMUNITY" : "RETAILER",
    games: [GAME_SLUG],
    async fetch() {
      throw new Error(`network access attempted by provider ${key}`);
    },
    parse(payload) {
      return (decodePayloadBody(payload) as WireRow[]).map(
        (row): Candidate => ({
          origin,
          game: GAME_SLUG,
          externalIds: { [origin]: row.id },
          name: row.name,
          code: null,
          date: { kind: "EXACT", date: new Date(row.date) },
          region: "GLOBAL",
          type: "SHELF",
          url: `https://${origin}.example/${row.id}`,
          productKind: "expansion",
        }),
      );
    },
  };
}

const wikipedia = makeProvider("lifecycle-test-wikipedia", "wikipedia");
const retailer = makeProvider("lifecycle-test-retailer", "tcgplayer");

async function runAt(at: Date, rows: WireRow[]) {
  const run = await prisma.scanRun.create({
    data: { scopeType: "INSTALL", scopeId: installId, trigger: "SCHEDULED", status: "SUCCEEDED", startedAt: at, finishedAt: at },
  });
  for (const provider of [wikipedia, retailer]) {
    const { body, contentHash } = packPayloadBody(rows);
    await prisma.rawPayload.create({
      data: { scanRunId: run.id, providerKey: provider.key, contentHash, body, fetchedAt: at },
    });
    await prisma.providerRun.create({
      data: { scanRunId: run.id, providerKey: provider.key, status: "OK", candidates: rows.length, startedAt: at, finishedAt: at },
    });
  }
  const result = await runStagesFromPayloads({
    scanRunId: run.id,
    now: at,
    installs: [{ id: installId, package: { slug: GAME_SLUG } }],
  });
  const diff = await prisma.runDiff.findUnique({ where: { scanRunId: run.id } });
  return { result, changes: (diff?.changes ?? []) as unknown as RunDiffChange[] };
}

const setName = () => `Lifecycle Pipeline ${installId.slice(-6)}`;
const rowsFor = () => [{ id: `set-${installId}`, name: setName(), date: SHELF_DATE }];

beforeAll(async () => {
  const pkg = await prisma.tcgProfilePackage.upsert({
    where: { slug: GAME_SLUG },
    update: {},
    create: { slug: GAME_SLUG, name: "Magic: The Gathering", version: "1.0.0", discoveryConfig: {}, sourceConfigs: {} },
  });
  const install = await prisma.tcgProfileInstall.create({
    data: { packageId: pkg.id, installedVersion: "1.0.0", enabled: true },
  });
  installId = install.id;
  registerProvider(wikipedia);
  registerProvider(retailer);
});

afterAll(async () => {
  unregisterProvider(wikipedia.key);
  unregisterProvider(retailer.key);
  await prisma.$disconnect();
});

function shelfEvent() {
  return prisma.releaseEvent.findFirstOrThrow({
    where: { type: "SHELF", archivedAt: null, productSet: { tcgProfileInstallId: installId } },
  });
}

describe("a set that has shipped, run through the whole pipeline", () => {
  it("is published, then released, in the run that first sees it after its date", async () => {
    // 2026-07-26: two days after the Friday street date, well inside the notify window.
    const { result } = await runAt(new Date("2026-07-26T20:30:00.000Z"), rowsFor());

    expect((await shelfEvent()).status).toBe("RELEASED");
    expect(result.eventsReleased).toBeGreaterThanOrEqual(1);
    expect(result.releasedEvents.some((event) => event.type === "SHELF" && event.recent)).toBe(true);
  });

  it("stays released on the next run while sources still list it, with no status change in the diff", async () => {
    const before = await shelfEvent();
    const { result, changes } = await runAt(new Date("2026-07-27T20:30:00.000Z"), rowsFor());

    expect((await shelfEvent()).status).toBe("RELEASED");
    expect(result.eventsReleased).toBe(0);
    // A status flip in the diff is what fires the follower "status changed" email.
    const flips = changes.filter((change) => change.releaseEventId === before.id && change.statusBefore !== change.statusAfter);
    expect(flips).toEqual([]);
  });

  it("keeps the derived prerelease, released, rather than retracting it the night after its set ships", async () => {
    const shelf = await shelfEvent();
    const derived = await prisma.releaseEvent.findMany({
      where: { derivedFromEventId: shelf.id },
    });
    expect(derived).toHaveLength(1);
    expect(derived[0].archivedAt).toBeNull();
    expect(derived[0].dateExact?.toISOString()).toBe(PRERELEASE_DATE);
    expect(derived[0].status).toBe("RELEASED");
  });

  it("does not re-announce on a replay-style re-run of the same day", async () => {
    const { result } = await runAt(new Date("2026-07-27T21:00:00.000Z"), rowsFor());
    expect(result.eventsReleased).toBe(0);
    expect(result.releasedEvents).toEqual([]);
  });
});

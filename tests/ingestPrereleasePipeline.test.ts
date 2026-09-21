import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getFilteredEvents } from "@/data/calendar/calendarRepo";
import { decodePayloadBody } from "@/lib/ingest/normalize";
import { packPayloadBody, runStagesFromPayloads } from "@/lib/ingest/orchestrate";
import { registerProvider, unregisterProvider } from "@/lib/ingest/providers/registry";
import type { Provider } from "@/lib/ingest/providers/types";
import { prisma } from "@/lib/prisma";
import type { Candidate, RunDiffChange } from "@/lib/ingest/types";

/**
 * The whole pipeline, on the case that motivated gate rule G8.
 *
 * English Wikipedia's Magic set list states a "Pre-release date", and
 * `wikipedia` is the only origin that states one -- so G1 wanted an official
 * source, G2 wanted a second independent origin, G3 wanted a retailer, and none
 * of them fired. The event is therefore HELD on every run it ever has, and a
 * held verdict restates the published date -- which, now that
 * findOrCreateReleaseEvent creates a row dateless, is nothing at all. Without
 * G8 every Magic prerelease sits at TBD in the undated tab indefinitely.
 *
 * G8 makes the schedule the corroboration those events could never otherwise
 * get, turning them into ordinary published dates that re-evaluate every run.
 * These tests run the real stages over stored payloads and assert at the
 * database.
 */

const GAME_SLUG = "magic-the-gathering";
const NOW = new Date("2026-06-01T00:00:00.000Z");

// 2026-07-24 is a Friday; Magic's prerelease is the Friday before it.
const SHELF_DATE = "2026-07-24T00:00:00.000Z";
const PRERELEASE_DATE = "2026-07-17T00:00:00.000Z";

let installId: string;
let runCounter = 0;

type WireRow = { id: string; name: string; date: string; type: "SHELF" | "PRERELEASE" };

/** Two providers so the *shelf* date can reach CONFIRMED under G2; only one of them knows the prerelease. */
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
          type: row.type,
          url: `https://${origin}.example/${row.id}`,
          // What Scryfall's set_type supplies in production. Without a kind the
          // schedule treats the product as unclassified and derives nothing, which
          // is the behaviour under test in the "commander" case further down.
          productKind: "expansion",
        }),
      );
    },
  };
}

const wikipedia = makeProvider("prerelease-test-wikipedia", "wikipedia");
const retailer = makeProvider("prerelease-test-retailer", "tcgplayer");

async function runWith(payloads: Array<{ provider: Provider; rows: WireRow[] }>) {
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

  for (const { provider, rows } of payloads) {
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
  }

  const totals = await runStagesFromPayloads({
    scanRunId: run.id,
    now: at,
    installs: [{ id: installId, package: { slug: GAME_SLUG } }],
  });

  const diff = await prisma.runDiff.findUnique({ where: { scanRunId: run.id } });
  return { totals, changes: (diff?.changes ?? []) as unknown as RunDiffChange[] };
}

function eventsOfType(type: "SHELF" | "PRERELEASE") {
  return prisma.releaseEvent.findMany({
    where: { type, archivedAt: null, productSet: { tcgProfileInstallId: installId } },
    orderBy: { createdAt: "asc" },
  });
}

beforeAll(async () => {
  const pkg = await prisma.tcgProfilePackage.upsert({
    where: { slug: GAME_SLUG },
    update: {},
    create: {
      slug: GAME_SLUG,
      name: "Magic: The Gathering",
      version: "1.0.0",
      discoveryConfig: {},
      sourceConfigs: {},
    },
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

describe("a Wikipedia-only prerelease date", () => {
  it("publishes under G8 in the same run its shelf date is confirmed", async () => {
    const setName = `Edge of Eternities ${crypto.randomUUID().slice(0, 8)}`;
    const { changes } = await runWith([
      {
        provider: wikipedia,
        rows: [
          { id: setName, name: setName, date: SHELF_DATE, type: "SHELF" },
          { id: setName, name: setName, date: PRERELEASE_DATE, type: "PRERELEASE" },
        ],
      },
      { provider: retailer, rows: [{ id: setName, name: setName, date: SHELF_DATE, type: "SHELF" }] },
    ]);

    const shelf = (await eventsOfType("SHELF")).find((event) => event.dateExact !== null);
    expect(shelf?.status).toBe("CONFIRMED");

    const prerelease = (await eventsOfType("PRERELEASE")).find((event) => event.derivedFromEventId === null);
    expect(prerelease?.dateType).toBe("EXACT");
    expect(prerelease?.dateExact?.toISOString()).toBe(PRERELEASE_DATE);

    // The rule is recorded, so "why is this showing?" has the same kind of
    // answer every other date on the calendar has.
    const change = changes.find((c) => c.releaseEventId === prerelease?.id);
    expect(change?.action).toBe("PUBLISH");
    expect(change?.rule).toBe("G8");
    expect(change?.reason).toBe("SCHEDULE_CORROBORATED");
  });

  it("moves the date when the source corrects it, which a held event could never do", async () => {
    const setName = `Corrected ${crypto.randomUUID().slice(0, 8)}`;
    const rows = (prerelease: string): WireRow[] => [
      { id: setName, name: setName, date: SHELF_DATE, type: "SHELF" },
      { id: setName, name: setName, date: prerelease, type: "PRERELEASE" },
    ];
    const shelfOnly: WireRow[] = [{ id: setName, name: setName, date: SHELF_DATE, type: "SHELF" }];

    await runWith([
      { provider: wikipedia, rows: rows("2026-07-16T00:00:00.000Z") },
      { provider: retailer, rows: shelfOnly },
    ]);
    // Wikipedia is edited: the real prerelease is the Friday, not the Thursday.
    await runWith([{ provider: wikipedia, rows: rows(PRERELEASE_DATE) }, { provider: retailer, rows: shelfOnly }]);

    const set = await prisma.productSet.findFirstOrThrow({ where: { tcgProfileInstallId: installId, name: setName } });
    const prerelease = await prisma.releaseEvent.findFirstOrThrow({
      where: { productSetId: set.id, type: "PRERELEASE", derivedFromEventId: null },
    });
    expect(prerelease.dateExact?.toISOString()).toBe(PRERELEASE_DATE);
  });

  it("refuses to publish a prerelease date that misses the schedule, so G8 is a check and not a bypass", async () => {
    const setName = `Bad Parse ${crypto.randomUUID().slice(0, 8)}`;
    const { changes } = await runWith([
      {
        provider: wikipedia,
        rows: [
          { id: setName, name: setName, date: SHELF_DATE, type: "SHELF" },
          // A mis-read cell: nowhere near the Friday before the street date.
          { id: setName, name: setName, date: "2026-03-02T00:00:00.000Z", type: "PRERELEASE" },
        ],
      },
      { provider: retailer, rows: [{ id: setName, name: setName, date: SHELF_DATE, type: "SHELF" }] },
    ]);

    const set = await prisma.productSet.findFirstOrThrow({ where: { tcgProfileInstallId: installId, name: setName } });
    const prerelease = await prisma.releaseEvent.findFirstOrThrow({
      where: { productSetId: set.id, type: "PRERELEASE", derivedFromEventId: null },
    });

    const change = changes.find((c) => c.releaseEventId === prerelease.id);
    expect(change?.action).toBe("HOLD");
    expect(change?.rule).toBe("NONE");
    expect(prerelease.status).toBe("RUMORED");

    // And the bad date reaches nobody. findOrCreateReleaseEvent creates the row
    // dateless, so a held verdict has nothing to restate -- the mis-parse stays
    // on the claim, where it is auditable, and off the calendar.
    expect(prerelease.dateType).toBe("TBD");
    expect(prerelease.dateExact).toBeNull();

    // Derivation then fills the gap the failed check left, because
    // getSourcedPrereleaseDates only counts a *dated* sourced event as covering
    // a slot. So the set ends up with two rows: the unplaceable claim, and the
    // scheduled date.
    const all = await prisma.releaseEvent.findMany({
      where: { productSetId: set.id, type: "PRERELEASE", archivedAt: null },
    });
    expect(
      all.map((event) => ({ derived: event.derivedFromEventId !== null, date: event.dateExact?.toISOString() ?? null })),
    ).toEqual([
      { derived: false, date: null },
      { derived: true, date: PRERELEASE_DATE },
    ]);

    // Two rows in the database, one prerelease on the calendar: the dateless
    // claim is suppressed at display time by calendarRepo, so a reader never
    // sees the same prerelease twice across two tabs.
    const shown = (await getFilteredEvents({ installIds: [installId] })).filter(
      (event) => event.productSetId === set.id && event.type === "PRERELEASE",
    );
    expect(shown.map((event) => event.dateExact?.toISOString() ?? null)).toEqual([PRERELEASE_DATE]);
  });

  it("derives one instead when no source states a prerelease date at all", async () => {
    const setName = `No Wiki Row ${crypto.randomUUID().slice(0, 8)}`;
    const { totals } = await runWith([
      { provider: wikipedia, rows: [{ id: setName, name: setName, date: SHELF_DATE, type: "SHELF" }] },
      { provider: retailer, rows: [{ id: setName, name: setName, date: SHELF_DATE, type: "SHELF" }] },
    ]);

    expect(totals.prereleasesDerived).toBeGreaterThan(0);

    const set = await prisma.productSet.findFirstOrThrow({ where: { tcgProfileInstallId: installId, name: setName } });
    const derived = await prisma.releaseEvent.findFirstOrThrow({
      where: { productSetId: set.id, type: "PRERELEASE", derivedFromEventId: { not: null } },
    });
    expect(derived.dateExact?.toISOString()).toBe(PRERELEASE_DATE);
    expect(derived.archivedAt).toBeNull();
  });

  it("does not derive a second prerelease beside a sourced one", async () => {
    const setName = `Both Paths ${crypto.randomUUID().slice(0, 8)}`;
    await runWith([
      {
        provider: wikipedia,
        rows: [
          { id: setName, name: setName, date: SHELF_DATE, type: "SHELF" },
          { id: setName, name: setName, date: PRERELEASE_DATE, type: "PRERELEASE" },
        ],
      },
      { provider: retailer, rows: [{ id: setName, name: setName, date: SHELF_DATE, type: "SHELF" }] },
    ]);

    const set = await prisma.productSet.findFirstOrThrow({ where: { tcgProfileInstallId: installId, name: setName } });
    const prereleases = await prisma.releaseEvent.findMany({
      where: { productSetId: set.id, type: "PRERELEASE", archivedAt: null },
    });
    expect(prereleases).toHaveLength(1);
    expect(prereleases[0].derivedFromEventId).toBeNull();
  });
});

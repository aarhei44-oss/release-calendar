import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodePayloadBody } from "@/lib/ingest/normalize";
import { packPayloadBody, runStagesFromPayloads } from "@/lib/ingest/orchestrate";
import { registerProvider, unregisterProvider } from "@/lib/ingest/providers/registry";
import type { Provider } from "@/lib/ingest/providers/types";
import { prisma } from "@/lib/prisma";
import type { Candidate } from "@/lib/ingest/types";
import type { ProductImageKind } from "@/app/generated/prisma/client";

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

type WireRow = {
  id: string;
  name: string;
  date: string;
  imageUrl?: string;
  imageKind?: ProductImageKind;
  description?: string;
};

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
        // normalize.ts rejects a candidate carrying one without the other, so
        // a row that supplies a URL always gets a kind here too.
        ...(row.imageUrl ? { imageUrl: row.imageUrl, imageKind: row.imageKind ?? "SYMBOL" } : {}),
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
    // The kind rides along with the URL it describes: a URL stored without one
    // is an image the drawer declines to render at all.
    expect(enriched.imageKind).toBe("SYMBOL");
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

  /**
   * imageKind arrived after imageUrl, so a row can carry a URL that nothing
   * has classified. The migration backfilled the ones it could see; a set
   * enriched between that migration and this deploy is the gap, and it would
   * otherwise stay unclassified forever -- imageUrl is already populated, so
   * the "write only what's missing" rule above would never look at it again.
   * Exactly the shape of the create-time-only bug this whole module exists to
   * undo, which is why it gets a test rather than a shrug.
   */
  it("classifies a row that already carries a URL but no kind", async () => {
    await runWith([
      { id: "w-4", name: "Unclassified Set", date: "2027-02-05T00:00:00.000Z", imageUrl: IMAGE, imageKind: "ART" },
    ]);
    // Reproduce the pre-migration row: URL present, kind never written.
    await prisma.productSet.update({
      where: { id: (await setNamed("Unclassified Set")).id },
      data: { imageKind: null },
    });

    const totals = await runWith([
      { id: "w-4", name: "Unclassified Set", date: "2027-02-05T00:00:00.000Z", imageUrl: IMAGE, imageKind: "ART" },
    ]);

    expect(totals.productSetsEnriched).toBe(1);
    const classified = await setNamed("Unclassified Set");
    expect(classified.imageKind).toBe("ART");
    expect(classified.imageUrl).toBe(IMAGE);
  });

  it("refuses to classify a stored image using a different origin's URL", async () => {
    await runWith([
      { id: "w-5", name: "Contested Set", date: "2027-03-05T00:00:00.000Z", imageUrl: IMAGE, imageKind: "SYMBOL" },
    ]);
    await prisma.productSet.update({
      where: { id: (await setNamed("Contested Set")).id },
      data: { imageKind: null },
    });

    // A second origin publishing its own image of a different kind. Its ART
    // describes *its* URL, not the one already stored -- labelling the stored
    // symbol as art would put a 500x500 glyph back in the full-width slot,
    // which is the bug this column was added to fix.
    const totals = await runWith([
      {
        id: "w-5",
        name: "Contested Set",
        date: "2027-03-05T00:00:00.000Z",
        imageUrl: "https://images.example/sets/box-art.jpg",
        imageKind: "ART",
      },
    ]);

    expect(totals.productSetsEnriched).toBe(0);
    const untouched = await setNamed("Contested Set");
    expect(untouched.imageUrl).toBe(IMAGE);
    expect(untouched.imageKind).toBeNull();
  });
});

/**
 * The gap that made the whole feature invisible in production.
 *
 * Enrichment used to ride on the claim pipeline, so it only ever saw providers
 * whose payload had *changed*. A conditional GET coming back NOT_MODIFIED is
 * right to skip Normalize -- last run's claims still stand -- but a set's
 * artwork is not a claim, and "unchanged upstream" says nothing about whether
 * our own column is still null. YGOPRODeck publishes box art for every
 * Yu-Gi-Oh! set on the calendar and has emitted it since the providers shipped;
 * its index simply had not changed since before enrichment existed, so the art
 * had never once been offered to a run that could store it.
 */
describe("enrichment from providers that did not change", () => {
  /** A run in which this provider returned 304: a payload row with no body, exactly as notModifiedPayload writes it. */
  async function runNotModified() {
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
    await prisma.rawPayload.create({
      data: {
        scanRunId: run.id,
        providerKey: provider.key,
        contentHash: "unchanged",
        body: Buffer.alloc(0),
        fetchedAt: at,
      },
    });
    await prisma.providerRun.create({
      data: {
        scanRunId: run.id,
        providerKey: provider.key,
        status: "NOT_MODIFIED",
        candidates: 0,
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

  it("fills a null column from an unchanged provider's last stored payload", async () => {
    const ART = "https://images.example/sets/late-art.jpg";
    await runWith([
      { id: "w-late", name: "Late Art Set", date: "2027-05-05T00:00:00.000Z", imageUrl: ART, imageKind: "ART" },
    ]);

    // Stand-in for the production history: the payload carrying the art is on
    // disk and has been for weeks, but the column is null because nothing that
    // could store it had run by the time that payload was last parsed.
    const set = await setNamed("Late Art Set");
    await prisma.productSet.update({ where: { id: set.id }, data: { imageUrl: null, imageKind: null } });

    const totals = await runNotModified();

    expect(totals.candidates).toBe(0);
    expect(totals.productSetsEnriched).toBe(1);
    const filled = await setNamed("Late Art Set");
    expect(filled.imageUrl).toBe(ART);
    expect(filled.imageKind).toBe("ART");
  });

  it("writes nothing but presentational fields", async () => {
    // The backfill must never look like a run. It writes no claim, publishes no
    // date and reaches no verdict -- a stale payload getting a vote on what the
    // calendar says is exactly what NOT_MODIFIED exists to prevent.
    const before = await prisma.sourceClaim.count();
    const totals = await runNotModified();

    expect(await prisma.sourceClaim.count()).toBe(before);
    expect(totals.claimsWritten).toBe(0);
    expect(totals.eventsPublished).toBe(0);
    expect(totals.productSetsCreated).toBe(0);
  });

  it("never creates a set from a payload no current run corroborates", async () => {
    // A candidate that resolves to "new" is dropped rather than created, so a
    // stale payload can neither invent a product nor resurrect one a cleanup
    // sweep archived.
    await runWith([
      {
        id: "w-ghost",
        name: "Ghost Set",
        date: "2027-06-05T00:00:00.000Z",
        imageUrl: "https://images.example/sets/ghost.jpg",
        imageKind: "ART",
      },
    ]);
    const ghost = await setNamed("Ghost Set");
    await prisma.releaseEvent.deleteMany({ where: { productSetId: ghost.id } });
    await prisma.setIdentity.deleteMany({ where: { productSetId: ghost.id } });
    await prisma.productSet.delete({ where: { id: ghost.id } });

    const totals = await runNotModified();

    expect(totals.productSetsCreated).toBe(0);
    expect(
      await prisma.productSet.count({ where: { tcgProfileInstallId: installId, name: "Ghost Set" } }),
    ).toBe(0);
  });
});

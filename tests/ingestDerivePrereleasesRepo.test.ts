import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as ingestRepo from "@/data/ingest/ingestRepo";
import { derivePrereleaseEvents } from "@/lib/ingest/derivePrereleases";
import { prisma } from "@/lib/prisma";

/**
 * The derivation pass against the real repo and a real database.
 *
 * tests/ingestDerivePrereleases.test.ts already pins the reconciliation logic
 * against a fake, which is where the rules live. What can only be checked here
 * are the three properties that are claims about the *schema*:
 *
 *  - a derived row is invisible to the gate, so the absence sweep can never
 *    cancel a date the derivation pass is still maintaining;
 *  - retraction archives rather than deletes, so a user's follow survives a
 *    set slipping and coming back;
 *  - the (derivedFromEventId, derivedSlot) unique index really does make the
 *    upsert land on the same row instead of accumulating duplicates.
 *
 * Uses the real "magic-the-gathering" slug, because the schedule lookup is
 * keyed on it and a synthetic slug would silently derive nothing. The package
 * is upserted and never deleted; everything else is scoped to a fresh install.
 */

const NOW = new Date("2026-06-01T00:00:00.000Z");
// 2026-07-24 is a Friday, so the Magic prerelease is 2026-07-17.
const SHELF_DATE = new Date("2026-07-24T00:00:00.000Z");
const PRERELEASE_DATE = new Date("2026-07-17T00:00:00.000Z");

let installId: string;
let productSetId: string;
let shelfEventId: string;

async function makeShelfEvent(status: "CONFIRMED" | "ANNOUNCED") {
  return prisma.releaseEvent.create({
    data: {
      productSetId,
      type: "SHELF",
      dateType: "EXACT",
      dateExact: SHELF_DATE,
      region: "GLOBAL",
      status,
      confidence: 0.9,
    },
  });
}

function derivedRows() {
  return prisma.releaseEvent.findMany({
    where: { productSetId, type: "PRERELEASE" },
    orderBy: { createdAt: "asc" },
  });
}

function derive() {
  return derivePrereleaseEvents({ installIds: [installId], now: NOW }, ingestRepo);
}

beforeEach(async () => {
  const pkg = await prisma.tcgProfilePackage.upsert({
    where: { slug: "magic-the-gathering" },
    update: {},
    create: {
      slug: "magic-the-gathering",
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

  const set = await prisma.productSet.create({
    data: { tcgProfileInstallId: installId, code: `TST-${crypto.randomUUID().slice(0, 8)}`, name: "Test Expansion" },
  });
  productSetId = set.id;

  shelfEventId = (await makeShelfEvent("CONFIRMED")).id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("derived prerelease events, end to end", () => {
  it("creates one from a confirmed shelf date, on the Friday before it", async () => {
    const result = await derive();
    expect(result).toMatchObject({ written: 1, retracted: 0, errors: 0 });

    const rows = await derivedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].dateType).toBe("EXACT");
    expect(rows[0].dateExact?.toISOString()).toBe(PRERELEASE_DATE.toISOString());
    expect(rows[0].derivedFromEventId).toBe(shelfEventId);
    expect(rows[0].derivedSlot).toBe("friday-1");
    expect(rows[0].status).toBe("CONFIRMED");
    expect(rows[0].archivedAt).toBeNull();
  });

  it("writes the same row again rather than a second one, however many times it runs", async () => {
    await derive();
    await derive();
    await derive();
    expect(await derivedRows()).toHaveLength(1);
  });

  it("stays invisible to the gate: findOrCreateReleaseEvent will not adopt it", async () => {
    await derive();
    const derived = (await derivedRows())[0];

    // A sourced prerelease claim arriving later must get its *own* event, not
    // the derived row -- otherwise the gate starts writing verdicts onto a row
    // it has no claims for, and the absence sweep eventually cancels it.
    const forSource = await ingestRepo.findOrCreateReleaseEvent({
      productSetId,
      type: "PRERELEASE",
      region: "GLOBAL",
      date: { kind: "EXACT", date: PRERELEASE_DATE },
    });
    expect(forSource.id).not.toBe(derived.id);
    expect(forSource.derivedFromEventId).toBeNull();
  });

  it("stays out of the absence sweep, so G7 can never cancel it", async () => {
    await derive();
    const derived = (await derivedRows())[0];

    // Give it a claim it should never have had; the sweep must still skip it.
    const run = await prisma.scanRun.create({
      data: { scopeType: "INSTALL", scopeId: installId, trigger: "SCHEDULED", status: "SUCCEEDED" },
    });
    await prisma.sourceClaim.create({
      data: {
        releaseEventId: derived.id,
        scanRunId: run.id,
        origin: "wikipedia",
        tier: "COMMUNITY",
        disposition: "SUPPORTS",
        confidenceWeight: 0.8,
        url: "https://example.test/",
      },
    });

    const tracked = await ingestRepo.getIngestTrackedEvents([installId]);
    expect(tracked.map((event) => event.id)).not.toContain(derived.id);
  });

  it("moves with its anchor instead of leaving a stale duplicate behind", async () => {
    await derive();
    const before = (await derivedRows())[0];

    await prisma.releaseEvent.update({
      where: { id: shelfEventId },
      data: { dateExact: new Date("2026-07-31T00:00:00.000Z") },
    });
    await derive();

    const rows = await derivedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(before.id);
    expect(rows[0].dateExact?.toISOString()).toBe("2026-07-24T00:00:00.000Z");
  });
});

describe("retraction preserves what users attached to the event", () => {
  it("archives the row and keeps the follow, then restores the same row on re-confirmation", async () => {
    await derive();
    const derived = (await derivedRows())[0];

    const user = await prisma.user.create({ data: { email: `follower-${crypto.randomUUID()}@example.test` } });
    await prisma.eventFollow.create({ data: { userId: user.id, releaseEventId: derived.id } });
    await prisma.eventPersonalNote.create({
      data: { userId: user.id, releaseEventId: derived.id, content: "Booked a seat" },
    });

    // The publisher pulls the date back to merely announced.
    await prisma.releaseEvent.update({ where: { id: shelfEventId }, data: { status: "ANNOUNCED" } });
    const retracted = await derive();
    expect(retracted).toMatchObject({ written: 0, retracted: 1 });

    const archived = await prisma.releaseEvent.findUniqueOrThrow({ where: { id: derived.id } });
    expect(archived.archivedAt).not.toBeNull();
    // This is the whole reason retraction archives instead of deleting: a
    // delete cascades both of these away.
    expect(await prisma.eventFollow.count({ where: { releaseEventId: derived.id } })).toBe(1);
    expect(await prisma.eventPersonalNote.count({ where: { releaseEventId: derived.id } })).toBe(1);

    // And when the date firms up again, it is the same row that comes back.
    await prisma.releaseEvent.update({ where: { id: shelfEventId }, data: { status: "CONFIRMED" } });
    await derive();

    const restored = await prisma.releaseEvent.findUniqueOrThrow({ where: { id: derived.id } });
    expect(restored.archivedAt).toBeNull();
    expect(await prisma.eventFollow.count({ where: { releaseEventId: derived.id } })).toBe(1);
  });

  it("does not re-archive a row that is already archived", async () => {
    await derive();
    await prisma.releaseEvent.update({ where: { id: shelfEventId }, data: { status: "ANNOUNCED" } });
    expect(await derive()).toMatchObject({ retracted: 1 });
    expect(await derive()).toMatchObject({ retracted: 0 });
  });
});

describe("standing aside for a sourced prerelease", () => {
  it("derives nothing when a source already publishes that date", async () => {
    await prisma.releaseEvent.create({
      data: {
        productSetId,
        type: "PRERELEASE",
        dateType: "EXACT",
        dateExact: PRERELEASE_DATE,
        region: "GLOBAL",
        status: "CONFIRMED",
        confidence: 0.5,
      },
    });

    const result = await derive();
    expect(result.written).toBe(0);
    expect((await derivedRows()).filter((row) => row.derivedFromEventId !== null)).toEqual([]);
  });

  it("ignores a sourced prerelease that has no date, which is exactly the stranded Wikipedia case", async () => {
    // A Wikipedia-only prerelease the gate could not publish sits at TBD. It
    // must not suppress the derived date, or the fix would fix nothing.
    await prisma.releaseEvent.create({
      data: { productSetId, type: "PRERELEASE", dateType: "TBD", region: "GLOBAL", status: "RUMORED" },
    });

    const result = await derive();
    expect(result.written).toBe(1);
  });
});

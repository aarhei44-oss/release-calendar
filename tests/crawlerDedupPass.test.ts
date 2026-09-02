import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { runDedupPass } from "@/lib/crawler/dedupPass";

let installId: string;
let productSetId: string;

beforeEach(async () => {
  const pkg = await prisma.tcgProfilePackage.create({
    data: {
      slug: `dedup-pass-test-${crypto.randomUUID()}`,
      name: "Dedup Pass Test",
      version: "1.0.0",
      discoveryConfig: {},
      sourceConfigs: {},
    },
  });
  const install = await prisma.tcgProfileInstall.create({
    data: { packageId: pkg.id, installedVersion: "1.0.0", enabled: true },
  });
  installId = install.id;

  const productSet = await prisma.productSet.create({
    data: { tcgProfileInstallId: installId, code: "DP-1", name: "Dedup Pass Set" },
  });
  productSetId = productSet.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function createEvent(overrides: { dateExact?: Date; isManualOverride?: boolean } = {}) {
  return prisma.releaseEvent.create({
    data: {
      productSetId,
      type: "SHELF",
      dateType: "EXACT",
      dateExact: new Date("2026-05-01"),
      status: "ANNOUNCED",
      confidence: 0.3,
      ...overrides,
    },
  });
}

describe("runDedupPass", () => {
  it("merges two pre-existing duplicate events (same product set/type, close dates) into one", async () => {
    const a = await createEvent({ dateExact: new Date("2026-05-01") });
    const b = await createEvent({ dateExact: new Date("2026-05-03") });
    await prisma.sourceClaim.create({
      data: { releaseEventId: a.id, tier: "COMMUNITY", disposition: "SUPPORTS", confidenceWeight: 0.6, url: "https://a.example.com" },
    });
    await prisma.sourceClaim.create({
      data: { releaseEventId: b.id, tier: "RETAILER", disposition: "SUPPORTS", confidenceWeight: 0.6, url: "https://b.example.com" },
    });

    // runDedupPass scans the whole database, not just this test's fixtures,
    // so only assert on this test's own scoped data -- eventsMerged is a
    // global count that other tests' data could also contribute to.
    await runDedupPass();

    const remaining = await prisma.releaseEvent.findMany({ where: { productSetId }, include: { sourceClaims: true } });
    expect(remaining).toHaveLength(1);
    expect(remaining[0].sourceClaims).toHaveLength(2);
    // Confidence recomputed from both now-combined claims (higher than either alone).
    expect(remaining[0].confidence).toBeGreaterThan(0.3);
  });

  it("does not merge events that are outside the proximity window (genuinely different releases)", async () => {
    await createEvent({ dateExact: new Date("2026-05-01") });
    await createEvent({ dateExact: new Date("2026-11-01") });

    await runDedupPass();

    const remaining = await prisma.releaseEvent.findMany({ where: { productSetId } });
    expect(remaining).toHaveLength(2);
  });

  it("always keeps the manually-overridden event as the survivor", async () => {
    const overridden = await createEvent({ dateExact: new Date("2099-01-01"), isManualOverride: true });
    const discovered = await createEvent({ dateExact: new Date("2026-05-01") });

    await runDedupPass();

    const remaining = await prisma.releaseEvent.findMany({ where: { productSetId } });
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(overridden.id);
    expect(remaining[0].dateExact?.getTime()).toBe(new Date("2099-01-01").getTime());
    expect(await prisma.releaseEvent.findUnique({ where: { id: discovered.id } })).toBeNull();
  });

  it("is a no-op when there is only one event in a group", async () => {
    await createEvent();
    await runDedupPass();
    const remaining = await prisma.releaseEvent.findMany({ where: { productSetId } });
    expect(remaining).toHaveLength(1);
  });

  it("merges two ProductSets in the same install whose names are identical after normalization", async () => {
    // Created after the beforeEach ProductSet, so it's the later-created one
    // and should be treated as the duplicate (earliest-created survives).
    const duplicate = await prisma.productSet.create({
      data: {
        tcgProfileInstallId: installId,
        code: "DP-2",
        name: "DEDUP PASS SET (Reprint)!!",
      },
    });
    const event = await prisma.releaseEvent.create({
      data: {
        productSetId: duplicate.id,
        type: "SHELF",
        dateType: "EXACT",
        dateExact: new Date("2026-05-01"),
        status: "ANNOUNCED",
        confidence: 0.3,
      },
    });

    const result = await runDedupPass({ installIds: [installId] });

    expect(result.productSetsMerged).toBe(1);
    expect(await prisma.productSet.findUnique({ where: { id: duplicate.id } })).toBeNull();
    const survivor = await prisma.productSet.findUniqueOrThrow({ where: { id: productSetId } });
    expect(survivor.name).toBe("Dedup Pass Set");
    const movedEvent = await prisma.releaseEvent.findUnique({ where: { id: event.id } });
    expect(movedEvent?.productSetId).toBe(productSetId);
  });

  it("does not merge ProductSets with genuinely different normalized names", async () => {
    const other = await prisma.productSet.create({
      data: { tcgProfileInstallId: installId, code: "DP-2", name: "Dedup Pass Set 2" },
    });

    const result = await runDedupPass({ installIds: [installId] });

    expect(result.productSetsMerged).toBe(0);
    expect(await prisma.productSet.findUnique({ where: { id: other.id } })).not.toBeNull();
    expect(await prisma.productSet.findUnique({ where: { id: productSetId } })).not.toBeNull();
  });

  it("does not merge ProductSets with matching names across two different installs", async () => {
    const pkg2 = await prisma.tcgProfilePackage.create({
      data: {
        slug: `dedup-pass-test-2-${crypto.randomUUID()}`,
        name: "Dedup Pass Test 2",
        version: "1.0.0",
        discoveryConfig: {},
        sourceConfigs: {},
      },
    });
    const install2 = await prisma.tcgProfileInstall.create({
      data: { packageId: pkg2.id, installedVersion: "1.0.0", enabled: true },
    });
    const sameNameOtherInstall = await prisma.productSet.create({
      data: { tcgProfileInstallId: install2.id, code: "DP-1", name: "Dedup Pass Set" },
    });

    const result = await runDedupPass({ installIds: [installId, install2.id] });

    expect(result.productSetsMerged).toBe(0);
    expect(await prisma.productSet.findUnique({ where: { id: productSetId } })).not.toBeNull();
    expect(await prisma.productSet.findUnique({ where: { id: sameNameOtherInstall.id } })).not.toBeNull();
  });

  it("cascades a ProductSet merge into the existing event-proximity merge in the same pass", async () => {
    const duplicate = await prisma.productSet.create({
      data: { tcgProfileInstallId: installId, code: "DP-2", name: "dedup PASS set" },
    });
    await createEvent({ dateExact: new Date("2026-05-01") }); // on productSetId
    await prisma.releaseEvent.create({
      data: {
        productSetId: duplicate.id,
        type: "SHELF",
        dateType: "EXACT",
        dateExact: new Date("2026-05-03"), // within the 14-day proximity window
        status: "ANNOUNCED",
        confidence: 0.3,
      },
    });

    const result = await runDedupPass({ installIds: [installId] });

    expect(result.productSetsMerged).toBe(1);
    expect(result.eventsMerged).toBe(1);
    const remainingEvents = await prisma.releaseEvent.findMany({ where: { productSetId } });
    expect(remainingEvents).toHaveLength(1);
  });

  it("never merges ProductSets whose names normalize to an empty or too-short string", async () => {
    const a = await prisma.productSet.create({
      data: { tcgProfileInstallId: installId, code: "DP-A", name: "(2026)" },
    });
    const b = await prisma.productSet.create({
      data: { tcgProfileInstallId: installId, code: "DP-B", name: "??" },
    });

    const result = await runDedupPass({ installIds: [installId] });

    expect(result.productSetsMerged).toBe(0);
    expect(await prisma.productSet.findUnique({ where: { id: a.id } })).not.toBeNull();
    expect(await prisma.productSet.findUnique({ where: { id: b.id } })).not.toBeNull();
  });
});

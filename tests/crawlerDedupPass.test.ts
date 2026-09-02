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
});

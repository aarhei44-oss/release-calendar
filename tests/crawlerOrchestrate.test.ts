import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { runScan } from "@/lib/crawler/orchestrate";
import * as crawlerRepo from "@/data/crawler/crawlerRepo";
import type { Prisma } from "@/app/generated/prisma/client";
import type { SourceConfig } from "@/lib/crawler/adapters/types";

let installId: string;

const fixtureSourceConfig: SourceConfig = {
  url: "https://example.com/fixture-sets",
  tier: "COMMUNITY",
  parser: "fixture",
};

beforeAll(async () => {
  const pkg = await prisma.tcgProfilePackage.create({
    data: {
      slug: "crawler-orchestrate-test",
      name: "Crawler Orchestrate Test",
      version: "1.0.0",
      discoveryConfig: {},
      sourceConfigs: [fixtureSourceConfig] as unknown as Prisma.InputJsonValue,
    },
  });
  const install = await prisma.tcgProfileInstall.create({
    data: { packageId: pkg.id, installedVersion: "1.0.0", enabled: true },
  });
  installId = install.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("runScan (fixture adapter, end-to-end)", () => {
  it("fetches, parses, and persists DiscoveryHit/ProductSet/ReleaseEvent/SourceClaim from the fixture source", async () => {
    const result = await runScan({ scopeType: "INSTALL", scopeId: installId, trigger: "MANUAL" });

    expect(result.skipped).toBe(false);
    if (result.skipped) return;

    expect(result.totals.sourcesFetched).toBe(1);
    expect(result.totals.claimsCreated).toBe(3);
    expect(result.totals.eventsCreated).toBe(3);
    expect(result.totals.errors).toBe(0);

    const scanRun = await prisma.scanRun.findUniqueOrThrow({ where: { id: result.scanRunId } });
    expect(scanRun.status).toBe("SUCCEEDED");
    expect(scanRun.trigger).toBe("MANUAL");

    const hit = await prisma.discoveryHit.findUnique({
      where: { tcgProfileInstallId_url: { tcgProfileInstallId: installId, url: fixtureSourceConfig.url } },
    });
    expect(hit).not.toBeNull();

    const productSets = await prisma.productSet.findMany({ where: { tcgProfileInstallId: installId } });
    expect(productSets.map((p) => p.name).sort()).toEqual(
      ["Fixture Booster One", "Fixture Booster Three", "Fixture Booster Two"].sort(),
    );

    const exactEvent = await prisma.releaseEvent.findFirstOrThrow({
      where: { productSet: { name: "Fixture Booster One" } },
      include: { sourceClaims: true },
    });
    expect(exactEvent.dateType).toBe("EXACT");
    expect(exactEvent.dateExact).not.toBeNull();
    expect(exactEvent.sourceClaims).toHaveLength(1);
    expect(exactEvent.sourceClaims[0].tier).toBe("COMMUNITY");
    expect(exactEvent.sourceClaims[0].disposition).toBe("SUPPORTS");
    expect(exactEvent.confidence).toBeGreaterThan(0);
    expect(exactEvent.status).not.toBe("CANCELLED");

    const windowEvent = await prisma.releaseEvent.findFirstOrThrow({
      where: { productSet: { name: "Fixture Booster Two" } },
    });
    expect(windowEvent.dateType).toBe("WINDOW");
    expect(windowEvent.windowStart).not.toBeNull();

    const tbdEvent = await prisma.releaseEvent.findFirstOrThrow({
      where: { productSet: { name: "Fixture Booster Three" } },
    });
    expect(tbdEvent.dateType).toBe("TBD");
  });

  it("does not create duplicate product sets or events on a repeat scan (dedup)", async () => {
    await runScan({ scopeType: "INSTALL", scopeId: installId, trigger: "MANUAL" });

    const productSets = await prisma.productSet.findMany({ where: { tcgProfileInstallId: installId } });
    expect(productSets).toHaveLength(3);

    const exactEvent = await prisma.releaseEvent.findFirstOrThrow({
      where: { productSet: { name: "Fixture Booster One" } },
      include: { sourceClaims: true },
    });
    // Same event, but now with a second corroborating claim from the repeat scan.
    expect(exactEvent.sourceClaims).toHaveLength(2);

    const totalExactEvents = await prisma.releaseEvent.count({
      where: { productSet: { name: "Fixture Booster One" } },
    });
    expect(totalExactEvents).toBe(1);
  });

  it("does not overwrite the date on a manually-overridden event, but still records the claim", async () => {
    const productSet = await prisma.productSet.findFirstOrThrow({
      where: { tcgProfileInstallId: installId, name: "Fixture Booster One" },
    });
    const event = await prisma.releaseEvent.findFirstOrThrow({ where: { productSetId: productSet.id } });

    const overriddenDate = new Date("2099-01-01");
    await prisma.releaseEvent.update({
      where: { id: event.id },
      data: { isManualOverride: true, dateExact: overriddenDate },
    });

    await runScan({ scopeType: "INSTALL", scopeId: installId, trigger: "MANUAL" });

    const reloaded = await prisma.releaseEvent.findUniqueOrThrow({
      where: { id: event.id },
      include: { sourceClaims: true },
    });
    expect(reloaded.dateExact?.getTime()).toBe(overriddenDate.getTime());
    expect(reloaded.sourceClaims.length).toBeGreaterThanOrEqual(3);
  });

  it("skips a scan when the job lock for that install is already held (UC-19)", async () => {
    const lock = await crawlerRepo.acquireJobLock("crawler", installId, 60_000);
    expect(lock).not.toBeNull();

    const result = await runScan({ scopeType: "INSTALL", scopeId: installId, trigger: "MANUAL" });
    expect(result.skipped).toBe(true);

    await crawlerRepo.releaseJobLock("crawler", installId);
  });
});

describe("runScan (automatic post-scan dedup)", () => {
  let dedupInstallId: string;

  beforeAll(async () => {
    const pkg = await prisma.tcgProfilePackage.create({
      data: {
        slug: "crawler-orchestrate-dedup-test",
        name: "Crawler Orchestrate Dedup Test",
        version: "1.0.0",
        discoveryConfig: {},
        sourceConfigs: [fixtureSourceConfig] as unknown as Prisma.InputJsonValue,
      },
    });
    const install = await prisma.tcgProfileInstall.create({
      data: { packageId: pkg.id, installedVersion: "1.0.0", enabled: true },
    });
    dedupInstallId = install.id;
  });

  it("merges a pre-existing near-duplicate ProductSet automatically, with no separate triggerDedup() call", async () => {
    // Normalizes identically to the "Fixture Booster One" set the fixture
    // scan is about to create, and is created first, so it should survive
    // as the merge target (earliest-created wins).
    const preExisting = await prisma.productSet.create({
      data: {
        tcgProfileInstallId: dedupInstallId,
        code: "PRE-EXISTING",
        name: "Fixture Booster One (Reprint)",
      },
    });

    const result = await runScan({ scopeType: "INSTALL", scopeId: dedupInstallId, trigger: "MANUAL" });

    expect(result.skipped).toBe(false);
    if (result.skipped) return;
    expect(result.totals.productSetsMerged).toBe(1);

    const productSets = await prisma.productSet.findMany({ where: { tcgProfileInstallId: dedupInstallId } });
    expect(productSets.map((p) => p.name).sort()).toEqual(
      ["Fixture Booster One (Reprint)", "Fixture Booster Three", "Fixture Booster Two"].sort(),
    );

    const event = await prisma.releaseEvent.findFirstOrThrow({ where: { productSetId: preExisting.id } });
    expect(event.dateType).toBe("EXACT");
  });
});

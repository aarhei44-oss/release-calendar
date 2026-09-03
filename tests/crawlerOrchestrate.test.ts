import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { runScan } from "@/lib/crawler/orchestrate";
import * as crawlerRepo from "@/data/crawler/crawlerRepo";
import type { Prisma } from "@/app/generated/prisma/client";
import type { SourceConfig } from "@/lib/crawler/adapters/types";
import { createFixtureAdapter } from "@/lib/crawler/adapters/fixtureAdapter";
import { registerAdapter } from "@/lib/crawler/adapters/registry";

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
    // The fixture's EXACT date is a few days in the past (see
    // fixtureAdapter.ts), and the post-scan release lifecycle pass
    // (orchestrate.ts) should have caught it without needing a separate
    // triggerReleaseLifecycle() call.
    expect(exactEvent.status).toBe("RELEASED");
    expect(result.totals.eventsReleased).toBeGreaterThanOrEqual(1);

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

    const productSets = await prisma.productSet.findMany({
      where: { tcgProfileInstallId: dedupInstallId, archivedAt: null },
    });
    expect(productSets.map((p) => p.name).sort()).toEqual(
      ["Fixture Booster One (Reprint)", "Fixture Booster Three", "Fixture Booster Two"].sort(),
    );

    const event = await prisma.releaseEvent.findFirstOrThrow({ where: { productSetId: preExisting.id } });
    expect(event.dateType).toBe("EXACT");

    // The scan's own freshly-created "Fixture Booster One" ProductSet is
    // the duplicate here (later createdAt than the pre-existing one) --
    // archived, not deleted, and undoable (see tests/crawlerMergeUndo.test.ts).
    const archivedDuplicate = await prisma.productSet.findFirstOrThrow({
      where: { tcgProfileInstallId: dedupInstallId, name: "Fixture Booster One" },
    });
    expect(archivedDuplicate.archivedAt).not.toBeNull();
    expect(archivedDuplicate.mergedIntoId).toBe(preExisting.id);
  });

  it("does not re-match a scanned candidate to an archived (merged-away) duplicate event on a later scan", async () => {
    // Regression test: after an event-level merge archives a duplicate
    // ReleaseEvent, it still shares (productSetId, type) with the live
    // primary. Without excluding archived rows from
    // crawlerRepo.findEventsForProductSetType, a later scan's
    // findMatchingEvent could match a new claim to the frozen duplicate
    // instead of the live primary.
    const pkg = await prisma.tcgProfilePackage.create({
      data: {
        slug: "crawler-orchestrate-archived-match-test",
        name: "Crawler Orchestrate Archived Match Test",
        version: "1.0.0",
        discoveryConfig: {},
        sourceConfigs: [fixtureSourceConfig] as unknown as Prisma.InputJsonValue,
      },
    });
    const install = await prisma.tcgProfileInstall.create({
      data: { packageId: pkg.id, installedVersion: "1.0.0", enabled: true },
    });

    const productSet = await prisma.productSet.create({
      data: { tcgProfileInstallId: install.id, code: "ARCHIVED-MATCH-1", name: "Archived Match Set" },
    });
    const primary = await prisma.releaseEvent.create({
      data: { productSetId: productSet.id, type: "SHELF", dateType: "EXACT", dateExact: new Date("2026-05-01"), status: "ANNOUNCED", confidence: 0.3 },
    });
    const archivedDuplicate = await prisma.releaseEvent.create({
      data: {
        productSetId: productSet.id,
        type: "SHELF",
        dateType: "EXACT",
        dateExact: new Date("2026-05-03"),
        status: "ANNOUNCED",
        confidence: 0.3,
        archivedAt: new Date(),
        mergedIntoId: primary.id,
      },
    });

    const candidateEvents = await crawlerRepo.findEventsForProductSetType(productSet.id, "SHELF");
    expect(candidateEvents.map((e) => e.id)).toEqual([primary.id]);
    expect(candidateEvents.map((e) => e.id)).not.toContain(archivedDuplicate.id);
  });
});

describe("runScan (resolving a dateless TBD placeholder with a fresh dated candidate)", () => {
  // Regression test for a real production bug: e176e8c's bare-year date
  // parsing (dateParsing.ts) lets a candidate for a decades-old historical
  // product resolve to a real WINDOW/YEAR date instead of TBD, but
  // findMatchingEvent (dedup.ts) never matches a dated candidate against a
  // dateless existing event -- so the fresh candidate created a sibling
  // ReleaseEvent instead of updating the pre-existing TBD one, and that
  // sibling (dated decades in the past) was then immediately hard-deleted
  // by this same scan's own retention pass, before the resolved date was
  // ever visible. Verified live against production (see project memory)
  // before this fix.
  const HISTORICAL_FIXTURE_HTML = `
<html><body>
<table class="wikitable">
  <tr><th>Set No.</th><th>Name</th><th>Release date</th><th>Details</th></tr>
  <tr><td>1</td><td>Historical Fixture Set</td><td>1997</td><td>Bare-year historical date</td></tr>
</table>
</body></html>
`;
  const historicalSourceConfig: SourceConfig = {
    url: "https://example.com/historical-fixture-sets",
    tier: "COMMUNITY",
    parser: "fixture-tbd-resolve",
  };

  beforeAll(() => {
    registerAdapter(createFixtureAdapter(HISTORICAL_FIXTURE_HTML, "fixture-tbd-resolve"));
  });

  it("resolves the sole existing TBD event in place instead of creating (and same-scan-purging) a sibling, and excludes it from this scan's retention purge", async () => {
    const pkg = await prisma.tcgProfilePackage.create({
      data: {
        slug: "crawler-orchestrate-tbd-resolve-test",
        name: "Crawler Orchestrate TBD Resolve Test",
        version: "1.0.0",
        discoveryConfig: {},
        sourceConfigs: [historicalSourceConfig] as unknown as Prisma.InputJsonValue,
      },
    });
    const install = await prisma.tcgProfileInstall.create({
      data: { packageId: pkg.id, installedVersion: "1.0.0", enabled: true },
    });

    // Pre-seed exactly the TBD row a pre-fix crawl of this same source
    // would have left behind -- same productSetCode the fixture's adapter
    // will independently derive (SET-<slugified name>), so this scan's
    // candidate matches this ProductSet rather than creating a new one.
    const productSet = await prisma.productSet.create({
      data: { tcgProfileInstallId: install.id, code: "SET-HISTORICAL-FIXTURE-SET", name: "Historical Fixture Set" },
    });
    const tbdEvent = await prisma.releaseEvent.create({
      data: { productSetId: productSet.id, type: "SHELF", dateType: "TBD", status: "RUMORED", confidence: 0.1 },
    });

    const result = await runScan({ scopeType: "INSTALL", scopeId: install.id, trigger: "MANUAL" });
    expect(result.skipped).toBe(false);
    if (result.skipped) return;

    const events = await prisma.releaseEvent.findMany({ where: { productSetId: productSet.id } });
    // Resolved in place -- same row, not a new sibling -- and still
    // present despite its real date being decades past the 30-day
    // retention cutoff, since it was excluded from this scan's own
    // retention pass.
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe(tbdEvent.id);
    expect(events[0].dateType).toBe("WINDOW");
    expect(events[0].windowGranularity).toBe("YEAR");
    expect(events[0].windowStart?.getUTCFullYear()).toBe(1997);
    expect(events[0].windowEnd?.getUTCFullYear()).toBe(1997);
    expect(result.totals.eventsDeleted).toBe(0);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { getFilteredEvents, getEventDetail, listEnabledInstallsForFilters, getLandingStats } from "@/data/calendar/calendarRepo";

let pokemonInstallId: string;
let mtgInstallId: string;
let exactEventId: string;
let rangeEventId: string;
let windowEventId: string;
let tbdEventId: string;

beforeAll(async () => {
  const pokemonPackage = await prisma.tcgProfilePackage.create({
    data: {
      slug: "test-pokemon",
      name: "Test Pokemon",
      version: "1.0.0",
      discoveryConfig: {},
      sourceConfigs: {},
    },
  });
  const mtgPackage = await prisma.tcgProfilePackage.create({
    data: {
      slug: "test-mtg",
      name: "Test MTG",
      version: "1.0.0",
      discoveryConfig: {},
      sourceConfigs: {},
    },
  });

  const pokemonInstall = await prisma.tcgProfileInstall.create({
    data: { packageId: pokemonPackage.id, installedVersion: "1.0.0", enabled: true },
  });
  const mtgInstall = await prisma.tcgProfileInstall.create({
    data: { packageId: mtgPackage.id, installedVersion: "1.0.0", enabled: true },
  });
  pokemonInstallId = pokemonInstall.id;
  mtgInstallId = mtgInstall.id;

  const pokemonSet = await prisma.productSet.create({
    data: { tcgProfileInstallId: pokemonInstall.id, code: "PKM-1", name: "Scarlet Skies" },
  });
  const mtgSet = await prisma.productSet.create({
    data: { tcgProfileInstallId: mtgInstall.id, code: "MTG-1", name: "Aether Drift" },
  });

  const exactEvent = await prisma.releaseEvent.create({
    data: {
      productSetId: pokemonSet.id,
      type: "SHELF",
      dateType: "EXACT",
      dateExact: new Date("2026-03-15"),
      status: "CONFIRMED",
      confidence: 0.9,
    },
  });
  const rangeEvent = await prisma.releaseEvent.create({
    data: {
      productSetId: pokemonSet.id,
      type: "PRERELEASE",
      dateType: "RANGE",
      dateStart: new Date("2026-02-25"),
      dateEnd: new Date("2026-03-05"),
      status: "ANNOUNCED",
      confidence: 0.5,
    },
  });
  const windowEvent = await prisma.releaseEvent.create({
    data: {
      productSetId: mtgSet.id,
      type: "SHELF",
      dateType: "WINDOW",
      windowGranularity: "QUARTER",
      windowStart: new Date("2026-04-01"),
      windowEnd: new Date("2026-06-30"),
      status: "RUMORED",
      confidence: 0.2,
    },
  });
  const tbdEvent = await prisma.releaseEvent.create({
    data: {
      productSetId: mtgSet.id,
      type: "PROMO",
      dateType: "TBD",
      status: "RUMORED",
      confidence: 0.1,
    },
  });

  exactEventId = exactEvent.id;
  rangeEventId = rangeEvent.id;
  windowEventId = windowEvent.id;
  tbdEventId = tbdEvent.id;

  await prisma.sourceClaim.create({
    data: {
      releaseEventId: exactEvent.id,
      tier: "OFFICIAL",
      disposition: "SUPPORTS",
      confidenceWeight: 0.9,
      url: "https://example.com/announcement",
    },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("getFilteredEvents", () => {
  it("returns all seeded events with no filters", async () => {
    const events = await getFilteredEvents();
    const ids = events.map((e) => e.id);
    expect(ids).toEqual(expect.arrayContaining([exactEventId, rangeEventId, windowEventId, tbdEventId]));
  });

  it("filters by installId", async () => {
    const events = await getFilteredEvents({ installIds: [pokemonInstallId] });
    expect(events.map((e) => e.id).sort()).toEqual([exactEventId, rangeEventId].sort());
  });

  it("filters by event type", async () => {
    const events = await getFilteredEvents({
      installIds: [pokemonInstallId, mtgInstallId],
      types: ["PROMO"],
    });
    expect(events.map((e) => e.id)).toEqual([tbdEventId]);
  });

  it("filters by status", async () => {
    const events = await getFilteredEvents({
      installIds: [pokemonInstallId, mtgInstallId],
      statuses: ["CONFIRMED"],
    });
    expect(events.map((e) => e.id)).toEqual([exactEventId]);
  });

  it("filters by free-text search against product set name/code", async () => {
    const events = await getFilteredEvents({ search: "Aether" });
    expect(events.map((e) => e.id).sort()).toEqual([windowEventId, tbdEventId].sort());
  });

  it("combines installId + type filters (AND semantics)", async () => {
    const events = await getFilteredEvents({ installIds: [mtgInstallId], types: ["SHELF"] });
    expect(events.map((e) => e.id)).toEqual([windowEventId]);
  });

  it("excludes an archived (merged-away) event even when it matches every other filter", async () => {
    const pokemonSet = await prisma.productSet.findFirstOrThrow({ where: { tcgProfileInstallId: pokemonInstallId } });
    const archivedEvent = await prisma.releaseEvent.create({
      data: {
        productSetId: pokemonSet.id,
        type: "SHELF",
        dateType: "EXACT",
        dateExact: new Date("2026-03-15"),
        status: "CONFIRMED",
        confidence: 0.9,
        archivedAt: new Date(),
        mergedIntoId: exactEventId,
      },
    });

    const events = await getFilteredEvents({ installIds: [pokemonInstallId] });
    expect(events.map((e) => e.id)).not.toContain(archivedEvent.id);
  });

  it("includes EXACT/RANGE/WINDOW events overlapping a date range, and excludes TBD from a range that doesn't span today", async () => {
    // 2026-03 is fixed in the past relative to whenever this suite actually
    // runs -- a TBD event (no date of its own) must not appear on a range
    // that doesn't include "now", or a years-old undated crawl artifact
    // would resurface on every past/future month a visitor navigates to.
    const events = await getFilteredEvents({
      installIds: [pokemonInstallId, mtgInstallId],
      from: new Date("2026-03-01"),
      to: new Date("2026-03-31"),
    });
    const ids = events.map((e) => e.id).sort();
    expect(ids).toEqual([exactEventId, rangeEventId].sort());
    expect(ids).not.toContain(windowEventId);
    expect(ids).not.toContain(tbdEventId);
  });

  it("includes a TBD event only when the queried range spans today", async () => {
    const now = new Date();
    const from = new Date(now.getFullYear(), now.getMonth(), 1);
    const to = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

    const events = await getFilteredEvents({ installIds: [mtgInstallId], from, to });
    expect(events.map((e) => e.id)).toContain(tbdEventId);
  });
});

describe("getEventDetail", () => {
  it("returns the event with its product set, install, package, and source claims", async () => {
    const detail = await getEventDetail(exactEventId);
    expect(detail).not.toBeNull();
    expect(detail?.productSet.install.package.slug).toBe("test-pokemon");
    expect(detail?.sourceClaims).toHaveLength(1);
    expect(detail?.sourceClaims[0]?.url).toBe("https://example.com/announcement");
  });

  it("returns null for an unknown event id", async () => {
    const detail = await getEventDetail("does-not-exist");
    expect(detail).toBeNull();
  });
});

describe("getLandingStats", () => {
  it("counts non-terminal, non-archived events and enabled installs", async () => {
    const stats = await getLandingStats();
    expect(stats.releasesTracked).toBeGreaterThanOrEqual(2); // at least exactEvent + rangeEvent (CONFIRMED/ANNOUNCED)
    expect(stats.gamesTracked).toBeGreaterThanOrEqual(2); // at least the two seeded enabled installs
  });

  it("excludes RELEASED/CANCELLED and archived events from the count", async () => {
    const pokemonSet = await prisma.productSet.findFirstOrThrow({ where: { tcgProfileInstallId: pokemonInstallId } });
    const before = await getLandingStats();

    await prisma.releaseEvent.create({
      data: { productSetId: pokemonSet.id, type: "SHELF", dateType: "EXACT", dateExact: new Date("2020-01-01"), status: "RELEASED", confidence: 0.9 },
    });
    await prisma.releaseEvent.create({
      data: {
        productSetId: pokemonSet.id,
        type: "SHELF",
        dateType: "EXACT",
        dateExact: new Date("2026-05-01"),
        status: "ANNOUNCED",
        confidence: 0.4,
        archivedAt: new Date(),
        mergedIntoId: exactEventId,
      },
    });

    const after = await getLandingStats();
    expect(after.releasesTracked).toBe(before.releasesTracked);
  });
});

describe("listEnabledInstallsForFilters", () => {
  it("includes enabled installs with their package name", async () => {
    const installs = await listEnabledInstallsForFilters();
    const ids = installs.map((i) => i.id);
    expect(ids).toContain(pokemonInstallId);
    expect(ids).toContain(mtgInstallId);
    const pokemon = installs.find((i) => i.id === pokemonInstallId);
    expect(pokemon?.package.name).toBe("Test Pokemon");
  });

  it("excludes disabled installs", async () => {
    const pkg = await prisma.tcgProfilePackage.create({
      data: { slug: "test-disabled-pkg", name: "Disabled Pkg", version: "1.0.0", discoveryConfig: {}, sourceConfigs: {} },
    });
    const disabledInstall = await prisma.tcgProfileInstall.create({
      data: { packageId: pkg.id, installedVersion: "1.0.0", enabled: false },
    });

    const installs = await listEnabledInstallsForFilters();
    expect(installs.map((i) => i.id)).not.toContain(disabledInstall.id);
  });
});

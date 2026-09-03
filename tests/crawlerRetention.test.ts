import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { runRetentionCleanupPass } from "@/lib/crawler/retention";

let installId: string;
let productSetId: string;

beforeEach(async () => {
  const pkg = await prisma.tcgProfilePackage.create({
    data: {
      slug: `retention-test-${crypto.randomUUID()}`,
      name: "Retention Test",
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
    data: { tcgProfileInstallId: installId, code: "RT-1", name: "Retention Test Set" },
  });
  productSetId = productSet.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

const OLD = new Date("2020-01-01"); // far more than 30 days ago
const FUTURE = new Date("2099-01-01");

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

describe("runRetentionCleanupPass", () => {
  it("permanently deletes an EXACT-date event more than 30 days past its date", async () => {
    const event = await prisma.releaseEvent.create({
      data: { productSetId, type: "SHELF", dateType: "EXACT", dateExact: OLD, status: "RELEASED", confidence: 0.9 },
    });

    const result = await runRetentionCleanupPass({ installIds: [installId] });

    expect(result.eventsDeleted).toBe(1);
    expect(await prisma.releaseEvent.findUnique({ where: { id: event.id } })).toBeNull();
  });

  it("cascade-deletes SourceClaims and UserNotes with the event", async () => {
    const event = await prisma.releaseEvent.create({
      data: { productSetId, type: "SHELF", dateType: "EXACT", dateExact: OLD, status: "RELEASED", confidence: 0.9 },
    });
    const claim = await prisma.sourceClaim.create({
      data: { releaseEventId: event.id, tier: "OFFICIAL", disposition: "SUPPORTS", confidenceWeight: 0.9, url: "https://example.com" },
    });

    await runRetentionCleanupPass({ installIds: [installId] });

    expect(await prisma.sourceClaim.findUnique({ where: { id: claim.id } })).toBeNull();
  });

  it("does not delete an event within the last 30 days", async () => {
    const event = await prisma.releaseEvent.create({
      data: { productSetId, type: "SHELF", dateType: "EXACT", dateExact: daysAgo(10), status: "RELEASED", confidence: 0.9 },
    });

    const result = await runRetentionCleanupPass({ installIds: [installId] });

    expect(result.eventsDeleted).toBe(0);
    expect(await prisma.releaseEvent.findUnique({ where: { id: event.id } })).not.toBeNull();
  });

  it("does not delete a future-dated event", async () => {
    const event = await prisma.releaseEvent.create({
      data: { productSetId, type: "SHELF", dateType: "EXACT", dateExact: FUTURE, status: "ANNOUNCED", confidence: 0.4 },
    });

    const result = await runRetentionCleanupPass({ installIds: [installId] });

    expect(result.eventsDeleted).toBe(0);
    expect(await prisma.releaseEvent.findUnique({ where: { id: event.id } })).not.toBeNull();
  });

  it("deletes an old RANGE event by its end date", async () => {
    const event = await prisma.releaseEvent.create({
      data: { productSetId, type: "SHELF", dateType: "RANGE", dateStart: new Date("2019-12-01"), dateEnd: OLD, status: "RELEASED", confidence: 0.9 },
    });

    const result = await runRetentionCleanupPass({ installIds: [installId] });

    expect(result.eventsDeleted).toBe(1);
    expect(await prisma.releaseEvent.findUnique({ where: { id: event.id } })).toBeNull();
  });

  it("deletes an old WINDOW event by its windowEnd", async () => {
    const event = await prisma.releaseEvent.create({
      data: {
        productSetId,
        type: "SHELF",
        dateType: "WINDOW",
        windowGranularity: "MONTH",
        windowStart: new Date("2019-12-01"),
        windowEnd: OLD,
        status: "RELEASED",
        confidence: 0.9,
      },
    });

    const result = await runRetentionCleanupPass({ installIds: [installId] });

    expect(result.eventsDeleted).toBe(1);
    expect(await prisma.releaseEvent.findUnique({ where: { id: event.id } })).toBeNull();
  });

  it("never deletes a TBD event, no matter how old it was created", async () => {
    const event = await prisma.releaseEvent.create({
      data: { productSetId, type: "SHELF", dateType: "TBD", status: "RUMORED", confidence: 0.1, createdAt: OLD },
    });

    const result = await runRetentionCleanupPass({ installIds: [installId] });

    expect(result.eventsDeleted).toBe(0);
    expect(await prisma.releaseEvent.findUnique({ where: { id: event.id } })).not.toBeNull();
  });

  it("deletes an old event regardless of status -- not just RELEASED/CANCELLED", async () => {
    const event = await prisma.releaseEvent.create({
      data: { productSetId, type: "SHELF", dateType: "EXACT", dateExact: OLD, status: "ANNOUNCED", confidence: 0.4 },
    });

    const result = await runRetentionCleanupPass({ installIds: [installId] });

    expect(result.eventsDeleted).toBe(1);
    expect(await prisma.releaseEvent.findUnique({ where: { id: event.id } })).toBeNull();
  });

  it("deletes an old event even if it's currently archived as a merge duplicate -- 'merged or not'", async () => {
    const survivor = await prisma.releaseEvent.create({
      data: { productSetId, type: "SHELF", dateType: "EXACT", dateExact: OLD, status: "RELEASED", confidence: 0.9 },
    });
    const mergedDuplicate = await prisma.releaseEvent.create({
      data: {
        productSetId,
        type: "SHELF",
        dateType: "EXACT",
        dateExact: OLD,
        status: "RELEASED",
        confidence: 0.9,
        archivedAt: new Date(),
        mergedIntoId: survivor.id,
      },
    });

    const result = await runRetentionCleanupPass({ installIds: [installId] });

    expect(result.eventsDeleted).toBe(2);
    expect(await prisma.releaseEvent.findUnique({ where: { id: mergedDuplicate.id } })).toBeNull();
    expect(await prisma.releaseEvent.findUnique({ where: { id: survivor.id } })).toBeNull();
  });

  it("does not delete events belonging to installs outside the given scope", async () => {
    const pkg2 = await prisma.tcgProfilePackage.create({
      data: {
        slug: `retention-test-2-${crypto.randomUUID()}`,
        name: "Retention Test 2",
        version: "1.0.0",
        discoveryConfig: {},
        sourceConfigs: {},
      },
    });
    const install2 = await prisma.tcgProfileInstall.create({
      data: { packageId: pkg2.id, installedVersion: "1.0.0", enabled: true },
    });
    const productSet2 = await prisma.productSet.create({
      data: { tcgProfileInstallId: install2.id, code: "RT-2", name: "Other Install Set" },
    });
    const event = await prisma.releaseEvent.create({
      data: { productSetId: productSet2.id, type: "SHELF", dateType: "EXACT", dateExact: OLD, status: "RELEASED", confidence: 0.9 },
    });

    const result = await runRetentionCleanupPass({ installIds: [installId] });

    expect(result.eventsDeleted).toBe(0);
    expect(await prisma.releaseEvent.findUnique({ where: { id: event.id } })).not.toBeNull();
  });

  it("purges a ProductSet archived (merged) more than 30 days ago", async () => {
    const survivor = await prisma.productSet.create({
      data: { tcgProfileInstallId: installId, code: "RT-SURVIVOR", name: "Survivor Set" },
    });
    const staleArchived = await prisma.productSet.create({
      data: {
        tcgProfileInstallId: installId,
        code: "RT-STALE",
        name: "Stale Archived Set",
        archivedAt: OLD,
        mergedIntoId: survivor.id,
      },
    });

    const result = await runRetentionCleanupPass({ installIds: [installId] });

    expect(result.productSetsPurged).toBe(1);
    expect(await prisma.productSet.findUnique({ where: { id: staleArchived.id } })).toBeNull();
    expect(await prisma.productSet.findUnique({ where: { id: survivor.id } })).not.toBeNull();
  });

  it("does not purge a ProductSet archived within the last 30 days", async () => {
    const survivor = await prisma.productSet.create({
      data: { tcgProfileInstallId: installId, code: "RT-SURVIVOR2", name: "Survivor Set 2" },
    });
    const recentlyArchived = await prisma.productSet.create({
      data: {
        tcgProfileInstallId: installId,
        code: "RT-RECENT",
        name: "Recently Archived Set",
        archivedAt: daysAgo(5),
        mergedIntoId: survivor.id,
      },
    });

    const result = await runRetentionCleanupPass({ installIds: [installId] });

    expect(result.productSetsPurged).toBe(0);
    expect(await prisma.productSet.findUnique({ where: { id: recentlyArchived.id } })).not.toBeNull();
  });

  it("does not purge a ProductSet that was never archived", async () => {
    const result = await runRetentionCleanupPass({ installIds: [installId] });

    expect(result.productSetsPurged).toBe(0);
    expect(await prisma.productSet.findUnique({ where: { id: productSetId } })).not.toBeNull();
  });
});

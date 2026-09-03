import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import * as crawlerRepo from "@/data/crawler/crawlerRepo";
import { undoProductSetMergeAndRecompute, undoReleaseEventMergeAndRecompute } from "@/lib/crawler/mergeUndo";

let installId: string;

beforeEach(async () => {
  const pkg = await prisma.tcgProfilePackage.create({
    data: {
      slug: `merge-undo-test-${crypto.randomUUID()}`,
      name: "Merge Undo Test",
      version: "1.0.0",
      discoveryConfig: {},
      sourceConfigs: {},
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

describe("undoProductSetMerge", () => {
  it("restores a merged-away ProductSet and moves its events back", async () => {
    const primary = await prisma.productSet.create({
      data: { tcgProfileInstallId: installId, code: "PS-1", name: "Primary Set" },
    });
    const duplicate = await prisma.productSet.create({
      data: { tcgProfileInstallId: installId, code: "PS-2", name: "Duplicate Set" },
    });
    const event = await prisma.releaseEvent.create({
      data: { productSetId: duplicate.id, type: "SHELF", dateType: "EXACT", dateExact: new Date("2026-05-01"), status: "ANNOUNCED", confidence: 0.3 },
    });

    await crawlerRepo.mergeProductSets(primary.id, duplicate.id);
    const merged = await prisma.productSet.findUniqueOrThrow({ where: { id: duplicate.id } });
    expect(merged.archivedAt).not.toBeNull();

    const result = await undoProductSetMergeAndRecompute(duplicate.id);
    expect(result.movedEventIds).toEqual([event.id]);

    const restored = await prisma.productSet.findUniqueOrThrow({ where: { id: duplicate.id } });
    expect(restored.archivedAt).toBeNull();
    expect(restored.mergedIntoId).toBeNull();

    const movedBackEvent = await prisma.releaseEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(movedBackEvent.productSetId).toBe(duplicate.id);
    expect(movedBackEvent.movedFromProductSetId).toBeNull();
  });

  it("throws when the ProductSet was never merged", async () => {
    const productSet = await prisma.productSet.create({
      data: { tcgProfileInstallId: installId, code: "PS-1", name: "Never Merged" },
    });

    await expect(undoProductSetMergeAndRecompute(productSet.id)).rejects.toThrow(/not currently merged/i);
  });

  it("pulls an event back from wherever it currently lives after a chained merge (D -> P1 -> P2)", async () => {
    const p2 = await prisma.productSet.create({
      data: { tcgProfileInstallId: installId, code: "PS-P2", name: "P2" },
    });
    const p1 = await prisma.productSet.create({
      data: { tcgProfileInstallId: installId, code: "PS-P1", name: "P1" },
    });
    const d = await prisma.productSet.create({
      data: { tcgProfileInstallId: installId, code: "PS-D", name: "D" },
    });
    const event = await prisma.releaseEvent.create({
      data: { productSetId: d.id, type: "SHELF", dateType: "EXACT", dateExact: new Date("2026-05-01"), status: "ANNOUNCED", confidence: 0.3 },
    });

    await crawlerRepo.mergeProductSets(p1.id, d.id); // D -> P1
    await crawlerRepo.mergeProductSets(p2.id, p1.id); // P1 -> P2

    const beforeUndo = await prisma.releaseEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(beforeUndo.productSetId).toBe(p2.id);
    expect(beforeUndo.movedFromProductSetId).toBe(d.id);

    await undoProductSetMergeAndRecompute(d.id);

    const afterUndo = await prisma.releaseEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(afterUndo.productSetId).toBe(d.id);
    expect(afterUndo.movedFromProductSetId).toBeNull();
  });
});

describe("undoReleaseEventMerge", () => {
  async function createEvent(productSetId: string, overrides: { confidence?: number } = {}) {
    return prisma.releaseEvent.create({
      data: {
        productSetId,
        type: "SHELF",
        dateType: "EXACT",
        dateExact: new Date("2026-05-01"),
        status: "ANNOUNCED",
        confidence: overrides.confidence ?? 0.3,
      },
    });
  }

  it("restores a merged-away event's claims/notes and recomputes confidence on both sides", async () => {
    const productSet = await prisma.productSet.create({
      data: { tcgProfileInstallId: installId, code: "PS-1", name: "Set" },
    });
    const primary = await createEvent(productSet.id);
    const duplicate = await createEvent(productSet.id);
    await prisma.sourceClaim.create({
      data: { releaseEventId: duplicate.id, tier: "OFFICIAL", disposition: "SUPPORTS", confidenceWeight: 0.9, url: "https://a.example.com" },
    });
    const user = await prisma.user.create({ data: { email: `undo-test-${crypto.randomUUID()}@example.com` } });
    await prisma.userNote.create({ data: { userId: user.id, releaseEventId: duplicate.id, content: "note" } });

    // crawlerRepo.mergeReleaseEvents is the conservative, raw data-layer
    // merge -- it moves claims/notes and archives the duplicate but does not
    // itself recompute confidence (that's dedupPass.ts's job when it calls
    // this). Undo's own recompute step is what's under test here.
    await crawlerRepo.mergeReleaseEvents(primary.id, duplicate.id);

    const result = await undoReleaseEventMergeAndRecompute(duplicate.id);
    expect(result.recomputedEventIds).toEqual([primary.id]);

    const restoredDuplicate = await prisma.releaseEvent.findUniqueOrThrow({
      where: { id: duplicate.id },
      include: { sourceClaims: true, userNotes: true },
    });
    expect(restoredDuplicate.archivedAt).toBeNull();
    expect(restoredDuplicate.mergedIntoId).toBeNull();
    expect(restoredDuplicate.sourceClaims).toHaveLength(1);
    expect(restoredDuplicate.userNotes).toHaveLength(1);
    expect(restoredDuplicate.confidence).toBeGreaterThan(0); // recomputed from its restored OFFICIAL claim

    const restoredPrimary = await prisma.releaseEvent.findUniqueOrThrow({ where: { id: primary.id } });
    expect(restoredPrimary.confidence).toBe(0); // no claims of its own -- back to its pre-merge state
  });

  it("throws when the event was never merged", async () => {
    const productSet = await prisma.productSet.create({
      data: { tcgProfileInstallId: installId, code: "PS-1", name: "Set" },
    });
    const event = await createEvent(productSet.id);

    await expect(undoReleaseEventMergeAndRecompute(event.id)).rejects.toThrow(/not currently merged/i);
  });

  it("does not pull back a claim recorded directly on the primary after the merge (precision check)", async () => {
    const productSet = await prisma.productSet.create({
      data: { tcgProfileInstallId: installId, code: "PS-1", name: "Set" },
    });
    const primary = await createEvent(productSet.id);
    const duplicate = await createEvent(productSet.id);
    await prisma.sourceClaim.create({
      data: { releaseEventId: duplicate.id, tier: "COMMUNITY", disposition: "SUPPORTS", confidenceWeight: 0.5, url: "https://dup.example.com" },
    });

    await crawlerRepo.mergeReleaseEvents(primary.id, duplicate.id);

    // A claim recorded directly on the primary *after* the merge -- never
    // stamped with movedFromReleaseEventId, so undo must not touch it.
    const newClaim = await crawlerRepo.recordSourceClaim({
      releaseEventId: primary.id,
      tier: "OFFICIAL",
      disposition: "SUPPORTS",
      confidenceWeight: 0.9,
      url: "https://new.example.com",
    });

    await undoReleaseEventMergeAndRecompute(duplicate.id);

    const primaryAfterUndo = await prisma.releaseEvent.findUniqueOrThrow({
      where: { id: primary.id },
      include: { sourceClaims: true },
    });
    expect(primaryAfterUndo.sourceClaims.map((c) => c.id)).toEqual([newClaim.id]);
    expect(primaryAfterUndo.confidence).toBeGreaterThan(0); // still reflects the new claim

    const duplicateAfterUndo = await prisma.releaseEvent.findUniqueOrThrow({
      where: { id: duplicate.id },
      include: { sourceClaims: true },
    });
    expect(duplicateAfterUndo.sourceClaims).toHaveLength(1);
    expect(duplicateAfterUndo.sourceClaims[0].url).toBe("https://dup.example.com");
  });

  it("pulls claims back from wherever they currently live after a chained merge (D -> P1 -> P2)", async () => {
    const productSet = await prisma.productSet.create({
      data: { tcgProfileInstallId: installId, code: "PS-1", name: "Set" },
    });
    const p2 = await createEvent(productSet.id);
    const p1 = await createEvent(productSet.id);
    const d = await createEvent(productSet.id);
    await prisma.sourceClaim.create({
      data: { releaseEventId: d.id, tier: "OFFICIAL", disposition: "SUPPORTS", confidenceWeight: 0.9, url: "https://d.example.com" },
    });

    await crawlerRepo.mergeReleaseEvents(p1.id, d.id); // D -> P1
    await crawlerRepo.mergeReleaseEvents(p2.id, p1.id); // P1 -> P2

    const result = await undoReleaseEventMergeAndRecompute(d.id);
    expect(result.recomputedEventIds).toEqual([p2.id]);

    const restoredD = await prisma.releaseEvent.findUniqueOrThrow({
      where: { id: d.id },
      include: { sourceClaims: true },
    });
    expect(restoredD.sourceClaims).toHaveLength(1);
    expect(restoredD.sourceClaims[0].url).toBe("https://d.example.com");

    const p2AfterUndo = await prisma.releaseEvent.findUniqueOrThrow({
      where: { id: p2.id },
      include: { sourceClaims: true },
    });
    expect(p2AfterUndo.sourceClaims).toHaveLength(0);
  });
});

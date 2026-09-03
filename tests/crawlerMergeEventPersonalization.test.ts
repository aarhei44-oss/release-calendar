import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import * as crawlerRepo from "@/data/crawler/crawlerRepo";

let productSetId: string;
let primaryId: string;
let duplicateId: string;
let userId: string;

beforeEach(async () => {
  const pkg = await prisma.tcgProfilePackage.create({
    data: {
      slug: `merge-personalization-test-${crypto.randomUUID()}`,
      name: "Merge Personalization Test",
      version: "1.0.0",
      discoveryConfig: {},
      sourceConfigs: {},
    },
  });
  const install = await prisma.tcgProfileInstall.create({
    data: { packageId: pkg.id, installedVersion: "1.0.0", enabled: true },
  });
  const productSet = await prisma.productSet.create({
    data: { tcgProfileInstallId: install.id, code: "MP-1", name: "Merge Personalization Test Set" },
  });
  productSetId = productSet.id;

  const primary = await prisma.releaseEvent.create({
    data: { productSetId, type: "SHELF", dateType: "EXACT", dateExact: new Date("2026-05-01"), status: "ANNOUNCED", confidence: 0.3 },
  });
  const duplicate = await prisma.releaseEvent.create({
    data: { productSetId, type: "SHELF", dateType: "EXACT", dateExact: new Date("2026-05-02"), status: "ANNOUNCED", confidence: 0.3 },
  });
  primaryId = primary.id;
  duplicateId = duplicate.id;

  const user = await prisma.user.create({ data: { email: `merge-personalization-${crypto.randomUUID()}@example.com` } });
  userId = user.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("mergeReleaseEvents: EventFollow reassignment", () => {
  it("moves a follow from the duplicate onto the primary, stamped with movedFromReleaseEventId", async () => {
    await prisma.eventFollow.create({ data: { userId, releaseEventId: duplicateId } });

    await crawlerRepo.mergeReleaseEvents(primaryId, duplicateId);

    const follows = await prisma.eventFollow.findMany({ where: { userId } });
    expect(follows).toHaveLength(1);
    expect(follows[0].releaseEventId).toBe(primaryId);
    expect(follows[0].movedFromReleaseEventId).toBe(duplicateId);
  });

  it("drops the duplicate's follow (not both) when the user already follows the primary too", async () => {
    await prisma.eventFollow.create({ data: { userId, releaseEventId: primaryId } });
    await prisma.eventFollow.create({ data: { userId, releaseEventId: duplicateId } });

    await expect(crawlerRepo.mergeReleaseEvents(primaryId, duplicateId)).resolves.not.toThrow();

    const follows = await prisma.eventFollow.findMany({ where: { userId } });
    expect(follows).toHaveLength(1);
    expect(follows[0].releaseEventId).toBe(primaryId);
  });
});

describe("mergeReleaseEvents: EventDismissal reassignment", () => {
  it("moves a dismissal from the duplicate onto the primary", async () => {
    await prisma.eventDismissal.create({ data: { userId, releaseEventId: duplicateId } });

    await crawlerRepo.mergeReleaseEvents(primaryId, duplicateId);

    const dismissals = await prisma.eventDismissal.findMany({ where: { userId } });
    expect(dismissals).toHaveLength(1);
    expect(dismissals[0].releaseEventId).toBe(primaryId);
  });

  it("does not throw when the user dismissed both the primary and duplicate", async () => {
    await prisma.eventDismissal.create({ data: { userId, releaseEventId: primaryId } });
    await prisma.eventDismissal.create({ data: { userId, releaseEventId: duplicateId } });

    await expect(crawlerRepo.mergeReleaseEvents(primaryId, duplicateId)).resolves.not.toThrow();

    const dismissals = await prisma.eventDismissal.findMany({ where: { userId } });
    expect(dismissals).toHaveLength(1);
  });
});

describe("mergeReleaseEvents: EventPersonalNote reassignment", () => {
  it("moves a personal note from the duplicate onto the primary", async () => {
    await prisma.eventPersonalNote.create({ data: { userId, releaseEventId: duplicateId, content: "duplicate-side note" } });

    await crawlerRepo.mergeReleaseEvents(primaryId, duplicateId);

    const notes = await prisma.eventPersonalNote.findMany({ where: { userId } });
    expect(notes).toHaveLength(1);
    expect(notes[0].releaseEventId).toBe(primaryId);
    expect(notes[0].content).toBe("duplicate-side note");
  });

  it("preserves both notes' content by appending, rather than silently dropping one, when the user has a note on each side", async () => {
    await prisma.eventPersonalNote.create({ data: { userId, releaseEventId: primaryId, content: "primary note" } });
    await prisma.eventPersonalNote.create({ data: { userId, releaseEventId: duplicateId, content: "duplicate note" } });

    await crawlerRepo.mergeReleaseEvents(primaryId, duplicateId);

    const notes = await prisma.eventPersonalNote.findMany({ where: { userId } });
    expect(notes).toHaveLength(1);
    expect(notes[0].releaseEventId).toBe(primaryId);
    expect(notes[0].content).toContain("primary note");
    expect(notes[0].content).toContain("duplicate note");
  });
});

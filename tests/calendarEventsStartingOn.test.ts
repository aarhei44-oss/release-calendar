import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { getEventsStartingOn } from "@/data/calendar/calendarRepo";

let installId: string;
let productSetId: string;

beforeEach(async () => {
  const pkg = await prisma.tcgProfilePackage.create({
    data: { slug: `starting-on-test-${crypto.randomUUID()}`, name: "Starting On Test", version: "1.0.0", discoveryConfig: {}, sourceConfigs: {} },
  });
  const install = await prisma.tcgProfileInstall.create({
    data: { packageId: pkg.id, installedVersion: "1.0.0", enabled: true },
  });
  installId = install.id;

  const productSet = await prisma.productSet.create({
    data: { tcgProfileInstallId: installId, code: "SO-1", name: "Starting On Test Set" },
  });
  productSetId = productSet.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

const TARGET_DAY = new Date("2026-06-15");

describe("getEventsStartingOn", () => {
  it("matches an EXACT event whose date falls on the target day", async () => {
    const event = await prisma.releaseEvent.create({
      data: { productSetId, type: "SHELF", dateType: "EXACT", dateExact: TARGET_DAY, status: "CONFIRMED", confidence: 0.9 },
    });
    const events = await getEventsStartingOn({ installIds: [installId], day: TARGET_DAY });
    expect(events.map((e) => e.id)).toEqual([event.id]);
  });

  it("does not match an EXACT event on a different day", async () => {
    await prisma.releaseEvent.create({
      data: { productSetId, type: "SHELF", dateType: "EXACT", dateExact: new Date("2026-06-16"), status: "CONFIRMED", confidence: 0.9 },
    });
    const events = await getEventsStartingOn({ installIds: [installId], day: TARGET_DAY });
    expect(events).toHaveLength(0);
  });

  it("matches a RANGE event whose *start* falls on the target day, even mid-way through a multi-week span", async () => {
    const event = await prisma.releaseEvent.create({
      data: {
        productSetId,
        type: "PRERELEASE",
        dateType: "RANGE",
        dateStart: TARGET_DAY,
        dateEnd: new Date("2026-06-30"),
        status: "ANNOUNCED",
        confidence: 0.5,
      },
    });
    const events = await getEventsStartingOn({ installIds: [installId], day: TARGET_DAY });
    expect(events.map((e) => e.id)).toEqual([event.id]);
  });

  it("does not match a RANGE event on a day within its span but after its start", async () => {
    await prisma.releaseEvent.create({
      data: {
        productSetId,
        type: "PRERELEASE",
        dateType: "RANGE",
        dateStart: new Date("2026-06-01"),
        dateEnd: new Date("2026-06-30"),
        status: "ANNOUNCED",
        confidence: 0.5,
      },
    });
    const events = await getEventsStartingOn({ installIds: [installId], day: TARGET_DAY });
    expect(events).toHaveLength(0);
  });

  it("matches a WINDOW event whose windowStart falls on the target day", async () => {
    const event = await prisma.releaseEvent.create({
      data: {
        productSetId,
        type: "SHELF",
        dateType: "WINDOW",
        windowGranularity: "MONTH",
        windowStart: TARGET_DAY,
        windowEnd: new Date("2026-06-30"),
        status: "RUMORED",
        confidence: 0.2,
      },
    });
    const events = await getEventsStartingOn({ installIds: [installId], day: TARGET_DAY });
    expect(events.map((e) => e.id)).toEqual([event.id]);
  });

  it("never matches a TBD event", async () => {
    await prisma.releaseEvent.create({
      data: { productSetId, type: "PROMO", dateType: "TBD", status: "RUMORED", confidence: 0.1 },
    });
    const events = await getEventsStartingOn({ installIds: [installId], day: TARGET_DAY });
    expect(events).toHaveLength(0);
  });

  it("excludes events outside the given installIds", async () => {
    const otherPkg = await prisma.tcgProfilePackage.create({
      data: { slug: `starting-on-other-${crypto.randomUUID()}`, name: "Other", version: "1.0.0", discoveryConfig: {}, sourceConfigs: {} },
    });
    const otherInstall = await prisma.tcgProfileInstall.create({
      data: { packageId: otherPkg.id, installedVersion: "1.0.0", enabled: true },
    });
    const otherSet = await prisma.productSet.create({
      data: { tcgProfileInstallId: otherInstall.id, code: "SO-OTHER", name: "Other Set" },
    });
    await prisma.releaseEvent.create({
      data: { productSetId: otherSet.id, type: "SHELF", dateType: "EXACT", dateExact: TARGET_DAY, status: "CONFIRMED", confidence: 0.9 },
    });

    const events = await getEventsStartingOn({ installIds: [installId], day: TARGET_DAY });
    expect(events).toHaveLength(0);
  });
});

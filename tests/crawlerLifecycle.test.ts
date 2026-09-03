import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { runReleaseLifecyclePass } from "@/lib/crawler/lifecycle";

let installId: string;
let productSetId: string;

beforeEach(async () => {
  const pkg = await prisma.tcgProfilePackage.create({
    data: {
      slug: `lifecycle-test-${crypto.randomUUID()}`,
      name: "Lifecycle Test",
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
    data: { tcgProfileInstallId: installId, code: "LC-1", name: "Lifecycle Test Set" },
  });
  productSetId = productSet.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

const PAST = new Date("2020-01-01");
const FUTURE = new Date("2099-01-01");

describe("runReleaseLifecyclePass", () => {
  it("transitions an EXACT-date event whose date has passed to RELEASED", async () => {
    const event = await prisma.releaseEvent.create({
      data: { productSetId, type: "SHELF", dateType: "EXACT", dateExact: PAST, status: "CONFIRMED", confidence: 0.9 },
    });

    const result = await runReleaseLifecyclePass({ installIds: [installId] });

    expect(result.eventsReleased).toBe(1);
    const reloaded = await prisma.releaseEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(reloaded.status).toBe("RELEASED");
  });

  it("does not touch an EXACT-date event whose date is in the future", async () => {
    const event = await prisma.releaseEvent.create({
      data: { productSetId, type: "SHELF", dateType: "EXACT", dateExact: FUTURE, status: "CONFIRMED", confidence: 0.9 },
    });

    const result = await runReleaseLifecyclePass({ installIds: [installId] });

    expect(result.eventsReleased).toBe(0);
    const reloaded = await prisma.releaseEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(reloaded.status).toBe("CONFIRMED");
  });

  it("releases a RANGE event once its end date has passed, even if it's still RUMORED", async () => {
    const event = await prisma.releaseEvent.create({
      data: {
        productSetId,
        type: "SHELF",
        dateType: "RANGE",
        dateStart: new Date("2019-12-01"),
        dateEnd: PAST,
        status: "RUMORED",
        confidence: 0.1,
      },
    });

    const result = await runReleaseLifecyclePass({ installIds: [installId] });

    expect(result.eventsReleased).toBe(1);
    const reloaded = await prisma.releaseEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(reloaded.status).toBe("RELEASED");
  });

  it("does not release a RANGE event whose start has passed but end has not", async () => {
    const event = await prisma.releaseEvent.create({
      data: {
        productSetId,
        type: "SHELF",
        dateType: "RANGE",
        dateStart: PAST,
        dateEnd: FUTURE,
        status: "ANNOUNCED",
        confidence: 0.4,
      },
    });

    const result = await runReleaseLifecyclePass({ installIds: [installId] });

    expect(result.eventsReleased).toBe(0);
    const reloaded = await prisma.releaseEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(reloaded.status).toBe("ANNOUNCED");
  });

  it("releases a WINDOW event once windowEnd has passed", async () => {
    const event = await prisma.releaseEvent.create({
      data: {
        productSetId,
        type: "SHELF",
        dateType: "WINDOW",
        windowGranularity: "MONTH",
        windowStart: new Date("2019-12-01"),
        windowEnd: PAST,
        status: "CONFIRMED",
        confidence: 0.7,
      },
    });

    const result = await runReleaseLifecyclePass({ installIds: [installId] });

    expect(result.eventsReleased).toBe(1);
    const reloaded = await prisma.releaseEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(reloaded.status).toBe("RELEASED");
  });

  it("never releases a TBD event, no matter how old", async () => {
    const event = await prisma.releaseEvent.create({
      data: { productSetId, type: "SHELF", dateType: "TBD", status: "RUMORED", confidence: 0.1, createdAt: PAST },
    });

    const result = await runReleaseLifecyclePass({ installIds: [installId] });

    expect(result.eventsReleased).toBe(0);
    const reloaded = await prisma.releaseEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(reloaded.status).toBe("RUMORED");
  });

  it("does not re-touch an event that is already RELEASED or CANCELLED", async () => {
    const released = await prisma.releaseEvent.create({
      data: { productSetId, type: "SHELF", dateType: "EXACT", dateExact: PAST, status: "RELEASED", confidence: 0.9 },
    });
    const cancelled = await prisma.releaseEvent.create({
      data: { productSetId, type: "PROMO", dateType: "EXACT", dateExact: PAST, status: "CANCELLED", confidence: 0.9 },
    });

    const result = await runReleaseLifecyclePass({ installIds: [installId] });

    expect(result.eventsReleased).toBe(0);
    expect((await prisma.releaseEvent.findUniqueOrThrow({ where: { id: released.id } })).status).toBe("RELEASED");
    expect((await prisma.releaseEvent.findUniqueOrThrow({ where: { id: cancelled.id } })).status).toBe("CANCELLED");
  });

  it("releases a manually-overridden event too, since RELEASED reflects the date, not the source of truth for it", async () => {
    const event = await prisma.releaseEvent.create({
      data: {
        productSetId,
        type: "SHELF",
        dateType: "EXACT",
        dateExact: PAST,
        status: "CONFIRMED",
        confidence: 0.9,
        isManualOverride: true,
      },
    });

    const result = await runReleaseLifecyclePass({ installIds: [installId] });

    expect(result.eventsReleased).toBe(1);
    const reloaded = await prisma.releaseEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(reloaded.status).toBe("RELEASED");
    expect(reloaded.dateExact?.getTime()).toBe(PAST.getTime());
  });

  it("does not release events belonging to installs outside the given scope", async () => {
    const pkg2 = await prisma.tcgProfilePackage.create({
      data: {
        slug: `lifecycle-test-2-${crypto.randomUUID()}`,
        name: "Lifecycle Test 2",
        version: "1.0.0",
        discoveryConfig: {},
        sourceConfigs: {},
      },
    });
    const install2 = await prisma.tcgProfileInstall.create({
      data: { packageId: pkg2.id, installedVersion: "1.0.0", enabled: true },
    });
    const productSet2 = await prisma.productSet.create({
      data: { tcgProfileInstallId: install2.id, code: "LC-2", name: "Other Install Set" },
    });
    const event = await prisma.releaseEvent.create({
      data: { productSetId: productSet2.id, type: "SHELF", dateType: "EXACT", dateExact: PAST, status: "CONFIRMED", confidence: 0.9 },
    });

    const result = await runReleaseLifecyclePass({ installIds: [installId] });

    expect(result.eventsReleased).toBe(0);
    const reloaded = await prisma.releaseEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(reloaded.status).toBe("CONFIRMED");
  });
});

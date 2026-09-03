import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { runLeadTimeReminderPass } from "@/lib/notifications/leadTimeScheduler";
import { getLeadTimeReminderSubscribers } from "@/data/notifications/notificationsRepo";

let installId: string;
let productSetId: string;

beforeEach(async () => {
  await prisma.user.deleteMany({ where: { email: { contains: "leadtime-" } } });

  const pkg = await prisma.tcgProfilePackage.create({
    data: { slug: `leadtime-test-${crypto.randomUUID()}`, name: "Lead Time Test", version: "1.0.0", discoveryConfig: {}, sourceConfigs: {} },
  });
  const install = await prisma.tcgProfileInstall.create({
    data: { packageId: pkg.id, installedVersion: "1.0.0", enabled: true },
  });
  installId = install.id;

  const productSet = await prisma.productSet.create({
    data: { tcgProfileInstallId: installId, code: "LT-1", name: "Lead Time Test Set" },
  });
  productSetId = productSet.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function createSubscriber(days: number) {
  const user = await prisma.user.create({
    data: { email: `leadtime-${crypto.randomUUID()}@example.com`, isPremium: true, leadTimeReminderDays: days },
  });
  await prisma.subscription.create({ data: { userId: user.id, tcgProfileInstallId: installId } });
  return user;
}

describe("getLeadTimeReminderSubscribers", () => {
  it("excludes a non-premium user even with days configured", async () => {
    const user = await prisma.user.create({
      data: { email: `leadtime-${crypto.randomUUID()}@example.com`, isPremium: false, leadTimeReminderDays: 7 },
    });
    const subscribers = await getLeadTimeReminderSubscribers();
    expect(subscribers.map((s) => s.userId)).not.toContain(user.id);
  });

  it("excludes a premium user with no days configured", async () => {
    const user = await prisma.user.create({
      data: { email: `leadtime-${crypto.randomUUID()}@example.com`, isPremium: true, leadTimeReminderDays: null },
    });
    const subscribers = await getLeadTimeReminderSubscribers();
    expect(subscribers.map((s) => s.userId)).not.toContain(user.id);
  });
});

const NOW = new Date("2026-06-01T16:00:00.000Z");

describe("runLeadTimeReminderPass", () => {
  it("sends a reminder when a subscribed event starts exactly N days out", async () => {
    await createSubscriber(7);
    await prisma.releaseEvent.create({
      data: {
        productSetId,
        type: "SHELF",
        dateType: "EXACT",
        dateExact: new Date(NOW.getTime() + 7 * 24 * 60 * 60 * 1000),
        status: "CONFIRMED",
        confidence: 0.9,
      },
    });

    const result = await runLeadTimeReminderPass(NOW);
    expect(result.sent).toBe(1);
    expect(result.skipped).toBe(0);
  });

  it("skips a subscriber whose event isn't exactly N days out", async () => {
    await createSubscriber(7);
    await prisma.releaseEvent.create({
      data: {
        productSetId,
        type: "SHELF",
        dateType: "EXACT",
        dateExact: new Date(NOW.getTime() + 3 * 24 * 60 * 60 * 1000),
        status: "CONFIRMED",
        confidence: 0.9,
      },
    });

    const result = await runLeadTimeReminderPass(NOW);
    expect(result.sent).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it("skips a subscriber with no subscriptions", async () => {
    await prisma.user.create({
      data: { email: `leadtime-${crypto.randomUUID()}@example.com`, isPremium: true, leadTimeReminderDays: 7 },
    });

    const result = await runLeadTimeReminderPass(NOW);
    expect(result.sent).toBe(0);
    expect(result.skipped).toBe(1);
  });
});

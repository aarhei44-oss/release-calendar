import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { getRecentActivityForSubscriptions, getUpcomingForSubscriptions } from "@/data/subscriptions/subscriptionsRepo";
import { dismissEvent } from "@/data/events/eventPersonalizationRepo";

let installId: string;
let productSetId: string;
let userId: string;

beforeEach(async () => {
  const pkg = await prisma.tcgProfilePackage.create({
    data: { slug: `subs-repo-test-${crypto.randomUUID()}`, name: "Subs Repo Test", version: "1.0.0", discoveryConfig: {}, sourceConfigs: {} },
  });
  const install = await prisma.tcgProfileInstall.create({
    data: { packageId: pkg.id, installedVersion: "1.0.0", enabled: true },
  });
  installId = install.id;

  const productSet = await prisma.productSet.create({
    data: { tcgProfileInstallId: installId, code: "SR-1", name: "Subs Repo Test Set" },
  });
  productSetId = productSet.id;

  const user = await prisma.user.create({ data: { email: `subs-repo-${crypto.randomUUID()}@example.com` } });
  userId = user.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function createEvent(overrides: { status?: "RUMORED" | "ANNOUNCED" | "CONFIRMED"; updatedAt?: Date; archivedAt?: Date } = {}) {
  const event = await prisma.releaseEvent.create({
    data: {
      productSetId,
      type: "SHELF",
      dateType: "EXACT",
      dateExact: new Date("2026-05-01"),
      status: overrides.status ?? "ANNOUNCED",
      confidence: 0.4,
      archivedAt: overrides.archivedAt,
    },
  });
  if (overrides.updatedAt) {
    // updatedAt is @updatedAt-managed, so it must be set via a raw update, not the create above.
    await prisma.releaseEvent.update({ where: { id: event.id }, data: { updatedAt: overrides.updatedAt } });
  }
  return event;
}

describe("getRecentActivityForSubscriptions", () => {
  it("returns an empty list for a user with no subscriptions", async () => {
    await createEvent();
    const result = await getRecentActivityForSubscriptions(userId, 7);
    expect(result).toEqual([]);
  });

  it("returns events updated within the window for a subscribed install, most recent first", async () => {
    await prisma.subscription.create({ data: { userId, tcgProfileInstallId: installId } });
    const older = await createEvent({ updatedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) });
    const newer = await createEvent({ updatedAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000) });

    const result = await getRecentActivityForSubscriptions(userId, 7);
    expect(result.map((e) => e.id)).toEqual([newer.id, older.id]);
  });

  it("excludes events updated outside the window", async () => {
    await prisma.subscription.create({ data: { userId, tcgProfileInstallId: installId } });
    const stale = await createEvent({ updatedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) });

    const result = await getRecentActivityForSubscriptions(userId, 7);
    expect(result.map((e) => e.id)).not.toContain(stale.id);
  });

  it("excludes events from installs the user is not subscribed to", async () => {
    const otherPkg = await prisma.tcgProfilePackage.create({
      data: { slug: `subs-repo-other-${crypto.randomUUID()}`, name: "Other", version: "1.0.0", discoveryConfig: {}, sourceConfigs: {} },
    });
    const otherInstall = await prisma.tcgProfileInstall.create({
      data: { packageId: otherPkg.id, installedVersion: "1.0.0", enabled: true },
    });
    const otherProductSet = await prisma.productSet.create({
      data: { tcgProfileInstallId: otherInstall.id, code: "SR-OTHER", name: "Other Set" },
    });
    const otherEvent = await prisma.releaseEvent.create({
      data: { productSetId: otherProductSet.id, type: "SHELF", dateType: "EXACT", dateExact: new Date("2026-05-01"), status: "ANNOUNCED", confidence: 0.4 },
    });

    await prisma.subscription.create({ data: { userId, tcgProfileInstallId: installId } }); // subscribed to installId, not otherInstall

    const result = await getRecentActivityForSubscriptions(userId, 7);
    expect(result.map((e) => e.id)).not.toContain(otherEvent.id);
  });

  it("excludes archived (merged-away) events", async () => {
    await prisma.subscription.create({ data: { userId, tcgProfileInstallId: installId } });
    const archived = await createEvent({ archivedAt: new Date() });

    const result = await getRecentActivityForSubscriptions(userId, 7);
    expect(result.map((e) => e.id)).not.toContain(archived.id);
  });

  it("excludes an event this user dismissed ('not interested')", async () => {
    await prisma.subscription.create({ data: { userId, tcgProfileInstallId: installId } });
    const event = await createEvent({ updatedAt: new Date() });
    await dismissEvent(userId, event.id);

    const result = await getRecentActivityForSubscriptions(userId, 7);
    expect(result.map((e) => e.id)).not.toContain(event.id);
  });

  it("does not exclude an event a different user dismissed", async () => {
    await prisma.subscription.create({ data: { userId, tcgProfileInstallId: installId } });
    const event = await createEvent({ updatedAt: new Date() });
    const otherUser = await prisma.user.create({ data: { email: `subs-repo-other-${crypto.randomUUID()}@example.com` } });
    await dismissEvent(otherUser.id, event.id);

    const result = await getRecentActivityForSubscriptions(userId, 7);
    expect(result.map((e) => e.id)).toContain(event.id);
  });
});

async function createUpcomingEvent() {
  const inFuture = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  return prisma.releaseEvent.create({
    data: { productSetId, type: "SHELF", dateType: "EXACT", dateExact: inFuture, status: "ANNOUNCED", confidence: 0.4 },
  });
}

describe("getUpcomingForSubscriptions", () => {
  it("returns an empty list for a user with no subscriptions", async () => {
    await createUpcomingEvent();
    const result = await getUpcomingForSubscriptions(userId, 90);
    expect(result).toEqual([]);
  });

  it("returns upcoming events for a subscribed install", async () => {
    await prisma.subscription.create({ data: { userId, tcgProfileInstallId: installId } });
    const event = await createUpcomingEvent();

    const result = await getUpcomingForSubscriptions(userId, 90);
    expect(result.map((e) => e.id)).toContain(event.id);
  });

  it("excludes an event this user dismissed", async () => {
    await prisma.subscription.create({ data: { userId, tcgProfileInstallId: installId } });
    const event = await createUpcomingEvent();
    await dismissEvent(userId, event.id);

    const result = await getUpcomingForSubscriptions(userId, 90);
    expect(result.map((e) => e.id)).not.toContain(event.id);
  });
});

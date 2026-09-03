import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-auth")>();
  return { ...actual, getServerSession: vi.fn() };
});

import { getServerSession } from "next-auth";
import { prisma } from "@/lib/prisma";
import { subscribe, unsubscribe, getMySubscriptions, getMySubscriptionsUpcoming } from "@/app/subscriptions/actions";

const mockGetServerSession = vi.mocked(getServerSession);

function sessionFor(userId: string, overrides: { isPremium?: boolean } = {}) {
  return {
    user: { id: userId, role: "USER" as const, active: true, isPremium: overrides.isPremium ?? false },
    expires: new Date(Date.now() + 60_000).toISOString(),
  };
}

let installId: string;
let user: { id: string };

beforeAll(async () => {
  const pkg = await prisma.tcgProfilePackage.create({
    data: { slug: "subs-test", name: "Subs Test", version: "1.0.0", discoveryConfig: {}, sourceConfigs: {} },
  });
  const install = await prisma.tcgProfileInstall.create({
    data: { packageId: pkg.id, installedVersion: "1.0.0", enabled: true },
  });
  installId = install.id;

  const productSet = await prisma.productSet.create({
    data: { tcgProfileInstallId: install.id, code: "SUB-1", name: "Subs Test Set" },
  });
  const soon = new Date();
  soon.setDate(soon.getDate() + 10);
  await prisma.releaseEvent.create({
    data: {
      productSetId: productSet.id,
      type: "SHELF",
      dateType: "EXACT",
      dateExact: soon,
      status: "ANNOUNCED",
    },
  });

  user = await prisma.user.create({ data: { email: "subscriber@example.com" } });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("subscribe/unsubscribe", () => {
  it("requires a signed-in user", async () => {
    mockGetServerSession.mockResolvedValueOnce(null);
    await expect(subscribe(installId)).rejects.toThrow();
  });

  it("is idempotent -- subscribing twice does not create two rows", async () => {
    mockGetServerSession.mockResolvedValueOnce(sessionFor(user.id));
    await subscribe(installId);
    mockGetServerSession.mockResolvedValueOnce(sessionFor(user.id));
    await subscribe(installId);

    const rows = await prisma.subscription.findMany({
      where: { userId: user.id, tcgProfileInstallId: installId },
    });
    expect(rows).toHaveLength(1);
  });

  it("is reflected immediately in the upcoming view", async () => {
    mockGetServerSession.mockResolvedValueOnce(sessionFor(user.id));
    const upcoming = await getMySubscriptionsUpcoming();
    expect(upcoming.some((e) => e.productSet.tcgProfileInstallId === installId)).toBe(true);

    mockGetServerSession.mockResolvedValueOnce(sessionFor(user.id));
    const subs = await getMySubscriptions();
    expect(subs.map((s) => s.tcgProfileInstallId)).toContain(installId);
  });

  it("unsubscribing removes it from the upcoming view", async () => {
    mockGetServerSession.mockResolvedValueOnce(sessionFor(user.id));
    await unsubscribe(installId);

    mockGetServerSession.mockResolvedValueOnce(sessionFor(user.id));
    const upcoming = await getMySubscriptionsUpcoming();
    expect(upcoming.some((e) => e.productSet.tcgProfileInstallId === installId)).toBe(false);

    const rows = await prisma.subscription.findMany({
      where: { userId: user.id, tcgProfileInstallId: installId },
    });
    expect(rows).toHaveLength(0);
  });

  it("unsubscribing twice is a no-op, not an error", async () => {
    mockGetServerSession.mockResolvedValueOnce(sessionFor(user.id));
    await expect(unsubscribe(installId)).resolves.not.toThrow();
  });
});

describe("getMySubscriptionsUpcoming: premium image gating", () => {
  it("never sends the real marketing image URL to a non-premium caller, even via this action directly", async () => {
    const pkg = await prisma.tcgProfilePackage.create({
      data: { slug: `subs-image-test-${crypto.randomUUID()}`, name: "Subs Image Test", version: "1.0.0", discoveryConfig: {}, sourceConfigs: {} },
    });
    const install = await prisma.tcgProfileInstall.create({
      data: { packageId: pkg.id, installedVersion: "1.0.0", enabled: true },
    });
    const productSet = await prisma.productSet.create({
      data: { tcgProfileInstallId: install.id, code: "SI-1", name: "Subs Image Test Set", imageUrl: "https://example.com/secret.png" },
    });
    const soon = new Date();
    soon.setDate(soon.getDate() + 10);
    await prisma.releaseEvent.create({
      data: { productSetId: productSet.id, type: "SHELF", dateType: "EXACT", dateExact: soon, status: "ANNOUNCED" },
    });
    const imageUser = await prisma.user.create({ data: { email: `subs-image-${crypto.randomUUID()}@example.com` } });
    await prisma.subscription.create({ data: { userId: imageUser.id, tcgProfileInstallId: install.id } });

    mockGetServerSession.mockResolvedValueOnce(sessionFor(imageUser.id, { isPremium: false }));
    const nonPremiumResult = await getMySubscriptionsUpcoming();
    const nonPremiumEvent = nonPremiumResult.find((e) => e.productSetId === productSet.id);
    expect(nonPremiumEvent?.productSet.imageUrl).toBeNull();

    mockGetServerSession.mockResolvedValueOnce(sessionFor(imageUser.id, { isPremium: true }));
    const premiumResult = await getMySubscriptionsUpcoming();
    const premiumEvent = premiumResult.find((e) => e.productSetId === productSet.id);
    expect(premiumEvent?.productSet.imageUrl).toBe("https://example.com/secret.png");
  });
});

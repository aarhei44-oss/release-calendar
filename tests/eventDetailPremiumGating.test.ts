import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-auth")>();
  return { ...actual, getServerSession: vi.fn() };
});

import { getServerSession } from "next-auth";
import { prisma } from "@/lib/prisma";
import { getEventDetail, getFilteredEvents } from "@/app/calendar/actions";

const mockGetServerSession = vi.mocked(getServerSession);

function sessionFor(overrides: { isPremium?: boolean } = {}) {
  return {
    user: { id: "session-user", role: "USER" as const, active: true, isPremium: overrides.isPremium ?? false },
    expires: new Date(Date.now() + 60_000).toISOString(),
  };
}

let eventWithImageId: string;
let eventWithoutImageId: string;

beforeAll(async () => {
  const pkg = await prisma.tcgProfilePackage.create({
    data: { slug: `event-detail-gating-test-${crypto.randomUUID()}`, name: "Event Detail Gating Test", version: "1.0.0", discoveryConfig: {}, sourceConfigs: {} },
  });
  const install = await prisma.tcgProfileInstall.create({
    data: { packageId: pkg.id, installedVersion: "1.0.0", enabled: true },
  });
  const setWithImage = await prisma.productSet.create({
    data: { tcgProfileInstallId: install.id, code: "EDG-1", name: "Set With Image", imageUrl: "https://example.com/secret-marketing-image.png" },
  });
  const setWithoutImage = await prisma.productSet.create({
    data: { tcgProfileInstallId: install.id, code: "EDG-2", name: "Set Without Image" },
  });
  const eventWithImage = await prisma.releaseEvent.create({
    data: { productSetId: setWithImage.id, type: "SHELF", dateType: "TBD", status: "RUMORED" },
  });
  const eventWithoutImage = await prisma.releaseEvent.create({
    data: { productSetId: setWithoutImage.id, type: "SHELF", dateType: "TBD", status: "RUMORED" },
  });
  eventWithImageId = eventWithImage.id;
  eventWithoutImageId = eventWithoutImage.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("getEventDetail premium gating on productSet.imageUrl", () => {
  it("never sends the real imageUrl to an anonymous (signed-out) caller", async () => {
    mockGetServerSession.mockResolvedValueOnce(null);
    const detail = await getEventDetail(eventWithImageId);
    expect(detail?.productSet.imageUrl).toBeNull();
    expect(detail?.productSet.hasMarketingImage).toBe(true);
  });

  it("never sends the real imageUrl to a signed-in, non-premium caller", async () => {
    mockGetServerSession.mockResolvedValueOnce(sessionFor({ isPremium: false }));
    const detail = await getEventDetail(eventWithImageId);
    expect(detail?.productSet.imageUrl).toBeNull();
    expect(detail?.productSet.hasMarketingImage).toBe(true);
  });

  it("sends the real imageUrl only to a premium caller", async () => {
    mockGetServerSession.mockResolvedValueOnce(sessionFor({ isPremium: true }));
    const detail = await getEventDetail(eventWithImageId);
    expect(detail?.productSet.imageUrl).toBe("https://example.com/secret-marketing-image.png");
    expect(detail?.productSet.hasMarketingImage).toBe(true);
  });

  it("reports hasMarketingImage: false when the set genuinely has no image, for any caller", async () => {
    mockGetServerSession.mockResolvedValueOnce(sessionFor({ isPremium: true }));
    const detail = await getEventDetail(eventWithoutImageId);
    expect(detail?.productSet.hasMarketingImage).toBe(false);
    expect(detail?.productSet.imageUrl).toBeNull();
  });
});

describe("getFilteredEvents premium gating on productSet.imageUrl (list view)", () => {
  it("never sends real imageUrls to an anonymous caller browsing the public calendar", async () => {
    mockGetServerSession.mockResolvedValueOnce(null);
    const events = await getFilteredEvents({});
    const withImage = events.find((e) => e.id === eventWithImageId);
    expect(withImage?.productSet.imageUrl).toBeNull();
  });

  it("never sends real imageUrls to a signed-in, non-premium caller", async () => {
    mockGetServerSession.mockResolvedValueOnce(sessionFor({ isPremium: false }));
    const events = await getFilteredEvents({});
    const withImage = events.find((e) => e.id === eventWithImageId);
    expect(withImage?.productSet.imageUrl).toBeNull();
  });

  it("sends real imageUrls to a premium caller", async () => {
    mockGetServerSession.mockResolvedValueOnce(sessionFor({ isPremium: true }));
    const events = await getFilteredEvents({});
    const withImage = events.find((e) => e.id === eventWithImageId);
    expect(withImage?.productSet.imageUrl).toBe("https://example.com/secret-marketing-image.png");
  });
});

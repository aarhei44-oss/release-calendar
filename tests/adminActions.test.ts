import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-auth")>();
  return { ...actual, getServerSession: vi.fn() };
});

import { getServerSession } from "next-auth";
import { prisma } from "@/lib/prisma";
import {
  listPackagesWithInstalls,
  toggleInstallEnabled,
  enableAndSeedInstall,
  listUsers,
  setUserRole,
  setUserActive,
  listScanRuns,
  triggerRescan,
  triggerDedup,
  triggerReleaseLifecycle,
  listContradictedEvents,
} from "@/app/admin/actions";

const mockGetServerSession = vi.mocked(getServerSession);

function sessionFor(user: { id: string; role?: "USER" | "ADMIN"; active?: boolean }) {
  return {
    user: { id: user.id, role: user.role ?? "USER", active: user.active ?? true },
    expires: new Date(Date.now() + 60_000).toISOString(),
  };
}

let adminUser: { id: string };
let plainUser: { id: string };
let installId: string;

beforeAll(async () => {
  adminUser = await prisma.user.create({ data: { email: "admin-actions-admin@example.com", role: "ADMIN" } });
  plainUser = await prisma.user.create({ data: { email: "admin-actions-user@example.com" } });

  const pkg = await prisma.tcgProfilePackage.create({
    data: { slug: "admin-actions-test", name: "Admin Actions Test", version: "1.0.0", discoveryConfig: {}, sourceConfigs: {} },
  });
  const install = await prisma.tcgProfileInstall.create({
    data: { packageId: pkg.id, installedVersion: "1.0.0", enabled: false },
  });
  installId = install.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("admin Server Actions -- authorization", () => {
  const unauthenticatedCases: [string, () => Promise<unknown>][] = [
    ["listPackagesWithInstalls", () => listPackagesWithInstalls()],
    ["toggleInstallEnabled", () => toggleInstallEnabled(installId, true)],
    ["enableAndSeedInstall", () => enableAndSeedInstall(installId)],
    ["listUsers", () => listUsers()],
    ["setUserRole", () => setUserRole(plainUser.id, "ADMIN")],
    ["setUserActive", () => setUserActive(plainUser.id, false)],
    ["listScanRuns", () => listScanRuns()],
    ["triggerRescan", () => triggerRescan(installId)],
    ["triggerDedup", () => triggerDedup()],
    ["triggerReleaseLifecycle", () => triggerReleaseLifecycle()],
    ["listContradictedEvents", () => listContradictedEvents()],
  ];

  for (const [name, call] of unauthenticatedCases) {
    it(`${name} rejects an unauthenticated caller`, async () => {
      mockGetServerSession.mockResolvedValueOnce(null);
      await expect(call()).rejects.toThrow();
    });

    it(`${name} rejects a signed-in non-admin caller`, async () => {
      mockGetServerSession.mockResolvedValueOnce(sessionFor(plainUser));
      await expect(call()).rejects.toThrow();
    });
  }
});

describe("enableAndSeedInstall", () => {
  it("enables the install and creates a placeholder product set when it has none", async () => {
    mockGetServerSession.mockResolvedValueOnce(sessionFor(adminUser));
    await enableAndSeedInstall(installId);

    const install = await prisma.tcgProfileInstall.findUniqueOrThrow({
      where: { id: installId },
      include: { productSets: true },
    });
    expect(install.enabled).toBe(true);
    expect(install.productSets.length).toBeGreaterThan(0);
  });

  it("does not create a second placeholder if product sets already exist", async () => {
    mockGetServerSession.mockResolvedValueOnce(sessionFor(adminUser));
    await enableAndSeedInstall(installId);

    const install = await prisma.tcgProfileInstall.findUniqueOrThrow({
      where: { id: installId },
      include: { productSets: true },
    });
    expect(install.productSets).toHaveLength(1);
  });
});

describe("triggerRescan / triggerDedup (System tab)", () => {
  it("lets an admin run a rescan (this test install has no sourceConfigs, so it's network-free)", async () => {
    mockGetServerSession.mockResolvedValueOnce(sessionFor(adminUser));
    const result = await triggerRescan(installId);
    expect(result.skipped).toBe(false);
    if (!result.skipped) {
      expect(result.totals.sourcesFetched).toBe(0);
    }
  });

  it("lets an admin run a dedup pass", async () => {
    mockGetServerSession.mockResolvedValueOnce(sessionFor(adminUser));
    const result = await triggerDedup();
    expect(result.groupsChecked).toBeGreaterThanOrEqual(0);
  });

  it("lets an admin run a release lifecycle pass", async () => {
    mockGetServerSession.mockResolvedValueOnce(sessionFor(adminUser));
    const result = await triggerReleaseLifecycle();
    expect(result.eventsReleased).toBeGreaterThanOrEqual(0);
  });
});

describe("listContradictedEvents (Review tab)", () => {
  let productSetId: string;

  beforeAll(async () => {
    const productSet = await prisma.productSet.create({
      data: { tcgProfileInstallId: installId, code: "REVIEW-1", name: "Review Test Set" },
    });
    productSetId = productSet.id;
  });

  async function createEvent(overrides: { status?: "ANNOUNCED" | "RELEASED" | "CANCELLED"; isManualOverride?: boolean } = {}) {
    return prisma.releaseEvent.create({
      data: {
        productSetId,
        type: "SHELF",
        dateType: "EXACT",
        dateExact: new Date("2026-05-01"),
        status: "ANNOUNCED",
        confidence: 0.4,
        ...overrides,
      },
    });
  }

  it("surfaces an event with a high-tier CONTRADICTS claim", async () => {
    const event = await createEvent();
    await prisma.sourceClaim.create({
      data: {
        releaseEventId: event.id,
        tier: "OFFICIAL",
        disposition: "CONTRADICTS",
        confidenceWeight: 0.6,
        url: "https://official.example.com",
      },
    });

    mockGetServerSession.mockResolvedValueOnce(sessionFor(adminUser));
    const results = await listContradictedEvents();

    expect(results.map((e) => e.id)).toContain(event.id);
  });

  it("does not surface an event whose only contradiction is low-tier", async () => {
    const event = await createEvent();
    await prisma.sourceClaim.create({
      data: {
        releaseEventId: event.id,
        tier: "SPECULATIVE",
        disposition: "CONTRADICTS",
        confidenceWeight: 0.3,
        url: "https://speculative.example.com",
      },
    });

    mockGetServerSession.mockResolvedValueOnce(sessionFor(adminUser));
    const results = await listContradictedEvents();

    expect(results.map((e) => e.id)).not.toContain(event.id);
  });

  it("does not surface an already manually-overridden event", async () => {
    const event = await createEvent({ isManualOverride: true });
    await prisma.sourceClaim.create({
      data: {
        releaseEventId: event.id,
        tier: "RETAILER",
        disposition: "CONTRADICTS",
        confidenceWeight: 0.6,
        url: "https://retailer.example.com",
      },
    });

    mockGetServerSession.mockResolvedValueOnce(sessionFor(adminUser));
    const results = await listContradictedEvents();

    expect(results.map((e) => e.id)).not.toContain(event.id);
  });

  it("does not surface a RELEASED or CANCELLED event", async () => {
    const released = await createEvent({ status: "RELEASED" });
    const cancelled = await createEvent({ status: "CANCELLED" });
    for (const event of [released, cancelled]) {
      await prisma.sourceClaim.create({
        data: {
          releaseEventId: event.id,
          tier: "OFFICIAL",
          disposition: "CONTRADICTS",
          confidenceWeight: 0.6,
          url: "https://official.example.com",
        },
      });
    }

    mockGetServerSession.mockResolvedValueOnce(sessionFor(adminUser));
    const results = await listContradictedEvents();

    expect(results.map((e) => e.id)).not.toContain(released.id);
    expect(results.map((e) => e.id)).not.toContain(cancelled.id);
  });
});

describe("self-protection on user management", () => {
  it("prevents an admin from removing their own admin role", async () => {
    mockGetServerSession.mockResolvedValueOnce(sessionFor({ id: adminUser.id, role: "ADMIN" }));
    await expect(setUserRole(adminUser.id, "USER")).rejects.toThrow(/cannot remove your own admin role/i);
  });

  it("prevents an admin from deactivating their own account", async () => {
    mockGetServerSession.mockResolvedValueOnce(sessionFor({ id: adminUser.id, role: "ADMIN" }));
    await expect(setUserActive(adminUser.id, false)).rejects.toThrow(/cannot deactivate your own account/i);
  });

  it("still allows an admin to change another user's role/active flag", async () => {
    mockGetServerSession.mockResolvedValueOnce(sessionFor({ id: adminUser.id, role: "ADMIN" }));
    await setUserRole(plainUser.id, "ADMIN");

    const updated = await prisma.user.findUniqueOrThrow({ where: { id: plainUser.id } });
    expect(updated.role).toBe("ADMIN");
  });
});

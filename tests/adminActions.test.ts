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

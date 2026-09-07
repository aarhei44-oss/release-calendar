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
  triggerRetentionCleanup,
  listIngestRunHealth,
  listProviderHealth,
  replayIngestRun,
  retryIngestRun,
  triggerFreshnessCheck,
  listReviewQueue,
  countOpenReviewItems,
  resolveReviewItem,
} from "@/app/admin/actions";

const mockGetServerSession = vi.mocked(getServerSession);

/** Polls for the ScanRun a background (fire-and-forget) triggerRescan writes, instead of a fixed sleep. */
async function waitForScanRun(scopeId: string, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await prisma.scanRun.findFirst({
      where: { scopeId, status: { not: "RUNNING" } },
      orderBy: { createdAt: "desc" },
    });
    if (run) return run;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`no completed ScanRun for scopeId ${scopeId} within ${timeoutMs}ms`);
}

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
    data: { slug: "admin-actions-test", name: "Admin Actions Test", version: "1.0.0", discoveryConfig: {}, sourceConfigs: [] },
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
    ["triggerRetentionCleanup", () => triggerRetentionCleanup()],
    ["listIngestRunHealth", () => listIngestRunHealth()],
    ["listProviderHealth", () => listProviderHealth()],
    ["replayIngestRun", () => replayIngestRun("no-such-run")],
    ["retryIngestRun", () => retryIngestRun("no-such-run")],
    ["triggerFreshnessCheck", () => triggerFreshnessCheck()],
    ["listReviewQueue", () => listReviewQueue()],
    ["countOpenReviewItems", () => countOpenReviewItems()],
    ["resolveReviewItem", () => resolveReviewItem("no-such-item", { kind: "dismiss" })],
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

describe("triggerRescan (System tab)", () => {
  it("lets an admin start a rescan (this test install has no providers configured, so it's network-free)", async () => {
    mockGetServerSession.mockResolvedValueOnce(sessionFor(adminUser));
    const result = await triggerRescan(installId);
    expect(result).toEqual({ started: true });

    // triggerRescan fires the scan in the background rather than awaiting
    // it (a real scan can take too long for the Server Action's caller to
    // wait on) -- poll for the ScanRun it writes instead of a fixed sleep.
    const scanRun = await waitForScanRun(installId);
    expect(scanRun.status).toBe("SUCCEEDED");
  });
});

describe("triggerRetentionCleanup (System tab)", () => {
  it("lets an admin run a retention cleanup pass", async () => {
    mockGetServerSession.mockResolvedValueOnce(sessionFor(adminUser));
    const result = await triggerRetentionCleanup();
    expect(result.eventsDeleted).toBeGreaterThanOrEqual(0);
    expect(result.productSetsPurged).toBeGreaterThanOrEqual(0);
  });
});

describe("v2 ingest admin actions (System tab / Review tab)", () => {
  it("reports provider health classified OK/PARTIAL/FAILED across a run's providers", async () => {
    const run = await prisma.scanRun.create({
      data: { scopeType: "ALL", trigger: "SCHEDULED", status: "SUCCEEDED", startedAt: new Date(), finishedAt: new Date() },
    });
    await prisma.providerRun.create({
      data: { scanRunId: run.id, providerKey: "admin-actions-ok", status: "OK", candidates: 3, startedAt: new Date(), finishedAt: new Date() },
    });
    await prisma.providerRun.create({
      data: { scanRunId: run.id, providerKey: "admin-actions-failed", status: "FAILED", error: "timeout", candidates: 0, startedAt: new Date(), finishedAt: new Date() },
    });

    mockGetServerSession.mockResolvedValueOnce(sessionFor(adminUser));
    const health = await listIngestRunHealth();

    const row = health.find((r) => r.id === run.id);
    expect(row?.providerHealth).toBe("PARTIAL");
    expect(row?.hasFailedProviders).toBe(true);
  });

  it("lists per-provider freshness including a standing alarm", async () => {
    const providerKey = `admin-actions-freshness-${crypto.randomUUID()}`;
    await prisma.providerRun.create({
      data: { scanRunId: crypto.randomUUID(), providerKey, status: "OK", startedAt: new Date(0), finishedAt: new Date(0) },
    });
    await prisma.providerAlarm.create({
      data: { providerKey, openedAt: new Date(0), notifiedAt: new Date(0) },
    });

    mockGetServerSession.mockResolvedValueOnce(sessionFor(adminUser));
    const health = await listProviderHealth();

    const row = health.find((r) => r.providerKey === providerKey);
    expect(row?.stale).toBe(true);
    expect(row?.alarm).not.toBeNull();
  });

  it("rejects replaying/retrying an unknown run id", async () => {
    mockGetServerSession.mockResolvedValueOnce(sessionFor(adminUser));
    await expect(replayIngestRun("no-such-run")).rejects.toThrow(/No such run/);

    mockGetServerSession.mockResolvedValueOnce(sessionFor(adminUser));
    await expect(retryIngestRun("no-such-run")).rejects.toThrow();
  });

  it("lets an admin run a freshness check on demand", async () => {
    mockGetServerSession.mockResolvedValueOnce(sessionFor(adminUser));
    const result = await triggerFreshnessCheck();
    expect(result.checked).toBeGreaterThanOrEqual(0);
  });
});

describe("review queue resolution (Review tab)", () => {
  let productSetId: string;

  beforeAll(async () => {
    const productSet = await prisma.productSet.create({
      data: { tcgProfileInstallId: installId, code: "REVIEWQ-1", name: "Review Queue Test Set" },
    });
    productSetId = productSet.id;
  });

  async function createReviewItem() {
    const event = await prisma.releaseEvent.create({
      data: {
        productSetId,
        type: "SHELF",
        dateType: "EXACT",
        dateExact: new Date("2026-06-01"),
        status: "ANNOUNCED",
        confidence: 0.4,
      },
    });
    const item = await prisma.reviewItem.create({
      data: {
        releaseEventId: event.id,
        reason: "CONFLICT",
        detail: {
          publishedDate: { kind: "EXACT", date: "2026-06-01T00:00:00.000Z" },
          proposedDate: { kind: "EXACT", date: "2026-06-10T00:00:00.000Z" },
          gapDays: 9,
          claims: [
            {
              origin: "test-origin-a",
              tier: "RETAILER",
              date: { kind: "EXACT", date: "2026-06-01T00:00:00.000Z" },
              consecutiveRuns: 1,
              seenInCurrentRun: true,
              lastSeenAt: "2026-06-01T00:00:00.000Z",
            },
            {
              origin: "test-origin-b",
              tier: "RETAILER",
              date: { kind: "EXACT", date: "2026-06-10T00:00:00.000Z" },
              consecutiveRuns: 1,
              seenInCurrentRun: true,
              lastSeenAt: "2026-06-01T00:00:00.000Z",
            },
          ],
        },
      },
    });
    return { event, item };
  }

  it("lists an open review item with its claims", async () => {
    const { item, event } = await createReviewItem();

    mockGetServerSession.mockResolvedValueOnce(sessionFor(adminUser));
    const queue = await listReviewQueue();

    const row = queue.find((r) => r.id === item.id);
    expect(row?.eventId).toBe(event.id);
    expect(row?.claims).toHaveLength(2);

    mockGetServerSession.mockResolvedValueOnce(sessionFor(adminUser));
    await expect(countOpenReviewItems()).resolves.toBeGreaterThanOrEqual(1);
  });

  it("accepting a claim writes its date onto the event and pins isManualOverride", async () => {
    const { item, event } = await createReviewItem();

    mockGetServerSession.mockResolvedValueOnce(sessionFor(adminUser));
    await resolveReviewItem(item.id, { kind: "accept", claimIndex: 1, note: "trusting origin b" });

    const updated = await prisma.releaseEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(updated.isManualOverride).toBe(true);
    expect(updated.dateExact?.toISOString()).toBe("2026-06-10T00:00:00.000Z");
    expect(updated.manualNotes).toBe("trusting origin b");

    const resolved = await prisma.reviewItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(resolved.resolvedAt).not.toBeNull();

    mockGetServerSession.mockResolvedValueOnce(sessionFor(adminUser));
    const queue = await listReviewQueue();
    expect(queue.map((r) => r.id)).not.toContain(item.id);
  });

  it("keeping the current value closes the item without touching the event", async () => {
    const { item, event } = await createReviewItem();
    const before = await prisma.releaseEvent.findUniqueOrThrow({ where: { id: event.id } });

    mockGetServerSession.mockResolvedValueOnce(sessionFor(adminUser));
    await resolveReviewItem(item.id, { kind: "keep" });

    const after = await prisma.releaseEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(after.isManualOverride).toBe(before.isManualOverride);
    expect(after.dateExact?.toISOString()).toBe(before.dateExact?.toISOString());

    const resolved = await prisma.reviewItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(resolved.resolvedAt).not.toBeNull();
  });

  it("dismissing closes the item without touching the event", async () => {
    const { item, event } = await createReviewItem();

    mockGetServerSession.mockResolvedValueOnce(sessionFor(adminUser));
    await resolveReviewItem(item.id, { kind: "dismiss" });

    const after = await prisma.releaseEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(after.isManualOverride).toBe(false);

    const resolved = await prisma.reviewItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(resolved.resolvedAt).not.toBeNull();
  });

  it("rejects resolving an already-resolved item", async () => {
    const { item } = await createReviewItem();
    mockGetServerSession.mockResolvedValueOnce(sessionFor(adminUser));
    await resolveReviewItem(item.id, { kind: "dismiss" });

    mockGetServerSession.mockResolvedValueOnce(sessionFor(adminUser));
    await expect(resolveReviewItem(item.id, { kind: "dismiss" })).rejects.toThrow();
  });

  it("rejects an out-of-range claimIndex on accept", async () => {
    const { item } = await createReviewItem();
    mockGetServerSession.mockResolvedValueOnce(sessionFor(adminUser));
    await expect(resolveReviewItem(item.id, { kind: "accept", claimIndex: 99 })).rejects.toThrow(
      /no longer part of this review item/,
    );
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

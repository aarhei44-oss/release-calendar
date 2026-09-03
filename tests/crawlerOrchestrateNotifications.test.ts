import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/app/generated/prisma/client";
import type { SourceConfig } from "@/lib/crawler/adapters/types";
import type { ScanChange } from "@/lib/notifications/types";

const dispatchScanChangeNotifications = vi.fn<(changes: ScanChange[]) => Promise<void>>().mockResolvedValue(undefined);
vi.mock("@/lib/notifications/dispatch", () => ({
  dispatchScanChangeNotifications: (...args: [ScanChange[]]) => dispatchScanChangeNotifications(...args),
}));

const fixtureSourceConfig: SourceConfig = {
  url: "https://example.com/fixture-sets-notifications",
  tier: "COMMUNITY",
  parser: "fixture",
};

let installId: string;

beforeAll(async () => {
  const pkg = await prisma.tcgProfilePackage.create({
    data: {
      slug: "crawler-orchestrate-notifications-test",
      name: "Crawler Orchestrate Notifications Test",
      version: "1.0.0",
      discoveryConfig: {},
      sourceConfigs: [fixtureSourceConfig] as unknown as Prisma.InputJsonValue,
    },
  });
  const install = await prisma.tcgProfileInstall.create({
    data: { packageId: pkg.id, installedVersion: "1.0.0", enabled: true },
  });
  installId = install.id;
});

afterEach(() => {
  dispatchScanChangeNotifications.mockClear();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("runScan notification collection", () => {
  it("dispatches a 'created' change for every brand-new event from a fixture scan", async () => {
    const { runScan } = await import("@/lib/crawler/orchestrate");

    const result = await runScan({ scopeType: "INSTALL", scopeId: installId, trigger: "MANUAL" });
    expect(result.skipped).toBe(false);

    expect(dispatchScanChangeNotifications).toHaveBeenCalledTimes(1);
    const changes = dispatchScanChangeNotifications.mock.calls[0][0];

    const created = changes.filter((c) => c.kind === "created" && c.installId === installId);
    expect(created.map((c) => c.productSetName).sort()).toEqual(
      ["Fixture Booster One", "Fixture Booster Three", "Fixture Booster Two"].sort(),
    );
    for (const change of created) {
      expect(change.gameName).toBe("Crawler Orchestrate Notifications Test");
    }

    // The fixture's EXACT-date event is already past-due, so the same scan's
    // post-scan lifecycle pass releases it too -- that's a second, distinct
    // "released" change for that event, not a bug (see orchestrate.ts).
    const released = changes.filter((c) => c.kind === "released");
    expect(released.length).toBeGreaterThanOrEqual(1);
  });

  it("does not re-report a 'created' change for an unchanged event on a repeat scan", async () => {
    const { runScan } = await import("@/lib/crawler/orchestrate");
    dispatchScanChangeNotifications.mockClear();

    await runScan({ scopeType: "INSTALL", scopeId: installId, trigger: "MANUAL" });

    const changes = dispatchScanChangeNotifications.mock.calls[0][0];
    expect(changes.some((c) => c.kind === "created")).toBe(false);
  });
});

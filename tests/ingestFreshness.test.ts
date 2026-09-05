import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { evaluateFreshness, FRESHNESS_THRESHOLDS, type ProviderRunTimestamps } from "@/lib/ingest/freshness";

const dispatchAdminAlarm = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/notifications/dispatch", () => ({
  dispatchAdminAlarm: (...args: unknown[]) => dispatchAdminAlarm(...args),
}));

const NOW = new Date("2026-09-10T00:00:00.000Z");
const HOUR = 60 * 60 * 1000;

/**
 * evaluateFreshness is pure (no clock, no database), so the 48-hour boundary
 * itself is asserted here rather than through a real ProviderRun history.
 */
describe("evaluateFreshness", () => {
  it("is not stale just under the threshold", () => {
    const rows: ProviderRunTimestamps[] = [
      { providerKey: "p", lastOkAt: new Date(NOW.getTime() - (48 * HOUR - 1)), firstSeenAt: new Date(0) },
    ];
    const [result] = evaluateFreshness(rows, NOW);
    expect(result.stale).toBe(false);
  });

  it("is stale exactly at the threshold", () => {
    const rows: ProviderRunTimestamps[] = [
      { providerKey: "p", lastOkAt: new Date(NOW.getTime() - 48 * HOUR), firstSeenAt: new Date(0) },
    ];
    const [result] = evaluateFreshness(rows, NOW);
    expect(result.stale).toBe(true);
  });

  it("respects a custom threshold override", () => {
    const rows: ProviderRunTimestamps[] = [
      { providerKey: "p", lastOkAt: new Date(NOW.getTime() - 10 * HOUR), firstSeenAt: new Date(0) },
    ];
    const [result] = evaluateFreshness(rows, NOW, 8);
    expect(result.stale).toBe(true);
  });

  it("treats a provider that has never succeeded as silent since its first attempt, not as fresh", () => {
    const firstSeenAt = new Date(NOW.getTime() - 72 * HOUR);
    const rows: ProviderRunTimestamps[] = [{ providerKey: "p", lastOkAt: null, firstSeenAt }];
    const [result] = evaluateFreshness(rows, NOW);
    expect(result.stale).toBe(true);
    expect(result.silentSince).toEqual(firstSeenAt);
  });

  it("treats a provider with no run history at all as not stale", () => {
    const rows: ProviderRunTimestamps[] = [{ providerKey: "p", lastOkAt: null, firstSeenAt: null }];
    const [result] = evaluateFreshness(rows, NOW);
    expect(result.stale).toBe(false);
    expect(result.hoursSinceOk).toBeNull();
  });

  it("uses FRESHNESS_THRESHOLDS.staleAfterHours as the default", () => {
    const rows: ProviderRunTimestamps[] = [
      { providerKey: "p", lastOkAt: new Date(NOW.getTime() - FRESHNESS_THRESHOLDS.staleAfterHours * HOUR), firstSeenAt: new Date(0) },
    ];
    const [result] = evaluateFreshness(rows, NOW);
    expect(result.stale).toBe(true);
  });
});

describe("runProviderFreshnessAlarmPass", () => {
  const staleProviderKey = `freshness-test-stale-${crypto.randomUUID()}`;
  const freshProviderKey = `freshness-test-fresh-${crypto.randomUUID()}`;

  beforeEach(async () => {
    dispatchAdminAlarm.mockClear();
    await prisma.providerAlarm.deleteMany({ where: { providerKey: { in: [staleProviderKey, freshProviderKey] } } });
    await prisma.providerRun.deleteMany({ where: { providerKey: { in: [staleProviderKey, freshProviderKey] } } });
  });

  afterEach(async () => {
    await prisma.providerAlarm.deleteMany({ where: { providerKey: { in: [staleProviderKey, freshProviderKey] } } });
    await prisma.providerRun.deleteMany({ where: { providerKey: { in: [staleProviderKey, freshProviderKey] } } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function seedRun(providerKey: string, status: "OK" | "FAILED", startedAt: Date) {
    await prisma.providerRun.create({
      data: { scanRunId: crypto.randomUUID(), providerKey, status, startedAt, finishedAt: startedAt },
    });
  }

  it("alarms a newly-stale provider and dispatches one notification", async () => {
    const { runProviderFreshnessAlarmPass } = await import("@/lib/ingest/freshness");
    await seedRun(staleProviderKey, "OK", new Date(NOW.getTime() - 72 * HOUR));
    await seedRun(freshProviderKey, "OK", new Date(NOW.getTime() - 1 * HOUR));

    const result = await runProviderFreshnessAlarmPass({ now: NOW });

    expect(result.stale).toContain(staleProviderKey);
    expect(result.alarmed).toContain(staleProviderKey);
    expect(result.stale).not.toContain(freshProviderKey);
    expect(dispatchAdminAlarm).toHaveBeenCalledTimes(1);

    const alarm = await prisma.providerAlarm.findUnique({ where: { providerKey: staleProviderKey } });
    expect(alarm?.clearedAt).toBeNull();
  });

  it("does not re-notify for a standing alarm inside the repeat window", async () => {
    const { runProviderFreshnessAlarmPass } = await import("@/lib/ingest/freshness");
    await seedRun(staleProviderKey, "OK", new Date(NOW.getTime() - 72 * HOUR));

    await runProviderFreshnessAlarmPass({ now: NOW });
    dispatchAdminAlarm.mockClear();

    const result = await runProviderFreshnessAlarmPass({ now: new Date(NOW.getTime() + 1 * HOUR) });

    expect(result.suppressed).toContain(staleProviderKey);
    expect(result.alarmed).not.toContain(staleProviderKey);
    expect(dispatchAdminAlarm).not.toHaveBeenCalled();
  });

  it("re-notifies once the repeat window has elapsed, keeping the original openedAt", async () => {
    const { runProviderFreshnessAlarmPass } = await import("@/lib/ingest/freshness");
    await seedRun(staleProviderKey, "OK", new Date(NOW.getTime() - 72 * HOUR));

    await runProviderFreshnessAlarmPass({ now: NOW });
    const firstAlarm = await prisma.providerAlarm.findUniqueOrThrow({ where: { providerKey: staleProviderKey } });
    dispatchAdminAlarm.mockClear();

    const later = new Date(NOW.getTime() + (FRESHNESS_THRESHOLDS.repeatAfterHours + 1) * HOUR);
    const result = await runProviderFreshnessAlarmPass({ now: later });

    expect(result.alarmed).toContain(staleProviderKey);
    expect(dispatchAdminAlarm).toHaveBeenCalledTimes(1);

    const secondAlarm = await prisma.providerAlarm.findUniqueOrThrow({ where: { providerKey: staleProviderKey } });
    expect(secondAlarm.openedAt).toEqual(firstAlarm.openedAt);
    expect(secondAlarm.notifiedAt.getTime()).toBeGreaterThan(firstAlarm.notifiedAt.getTime());
  });

  it("clears a standing alarm and dispatches a recovery notice once the provider is fresh again", async () => {
    const { runProviderFreshnessAlarmPass } = await import("@/lib/ingest/freshness");
    await seedRun(staleProviderKey, "OK", new Date(NOW.getTime() - 72 * HOUR));
    await runProviderFreshnessAlarmPass({ now: NOW });
    dispatchAdminAlarm.mockClear();

    // Provider comes back.
    await seedRun(staleProviderKey, "OK", new Date(NOW.getTime() + 1 * HOUR));

    const result = await runProviderFreshnessAlarmPass({ now: new Date(NOW.getTime() + 2 * HOUR) });

    expect(result.recovered).toContain(staleProviderKey);
    expect(dispatchAdminAlarm).toHaveBeenCalledTimes(1);
    expect(dispatchAdminAlarm).toHaveBeenCalledWith(expect.objectContaining({ subject: expect.stringContaining("recovered") }));

    const alarm = await prisma.providerAlarm.findUniqueOrThrow({ where: { providerKey: staleProviderKey } });
    expect(alarm.clearedAt).not.toBeNull();
  });

  it("does nothing for a provider with no run history", async () => {
    const { runProviderFreshnessAlarmPass } = await import("@/lib/ingest/freshness");
    const result = await runProviderFreshnessAlarmPass({ now: NOW });
    expect(result.stale).not.toContain("no-such-provider");
  });

  it("is idempotent: calling it repeatedly in immediate succession sends exactly one notification", async () => {
    const { runProviderFreshnessAlarmPass } = await import("@/lib/ingest/freshness");
    await seedRun(staleProviderKey, "OK", new Date(NOW.getTime() - 72 * HOUR));

    await runProviderFreshnessAlarmPass({ now: NOW });
    await runProviderFreshnessAlarmPass({ now: NOW });
    await runProviderFreshnessAlarmPass({ now: NOW });

    expect(dispatchAdminAlarm).toHaveBeenCalledTimes(1);
  });
});

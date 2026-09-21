import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as ingestRepo from "@/data/ingest/ingestRepo";
import { RELEASE_NOTIFY_WINDOW_DAYS, runReleaseLifecycle, type ReleaseLifecycleDeps } from "@/lib/ingest/releaseLifecycle";
import { isPastDate, type CandidateDate } from "@/lib/ingest/types";
import { prisma } from "@/lib/prisma";

/**
 * The release lifecycle pass. Before it existed every event stayed CONFIRMED
 * (or ANNOUNCED, or RUMORED) forever: 81 of 161 production events were dated in
 * the past on 2026-09-20 and none was RELEASED.
 *
 * The rules are covered against a fake of the two repo functions the pass uses,
 * and then once against the real database for the two claims that are about the
 * schema (the population it may touch, and that it never overwrites a status it
 * did not read).
 */

const NOW = new Date("2026-09-20T20:30:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function exact(iso: string): CandidateDate {
  return { kind: "EXACT", date: new Date(iso) };
}

describe("isPastDate", () => {
  it("is false for today: the day is not over until it is over", () => {
    expect(isPastDate(exact("2026-09-20T00:00:00.000Z"), NOW)).toBe(false);
  });

  it("is true from the first instant of the following day", () => {
    expect(isPastDate(exact("2026-09-19T00:00:00.000Z"), new Date("2026-09-20T00:00:00.000Z"))).toBe(true);
    expect(isPastDate(exact("2026-09-19T00:00:00.000Z"), new Date("2026-09-19T23:59:59.999Z"))).toBe(false);
  });

  it("uses a range's last day, not its first", () => {
    const range: CandidateDate = {
      kind: "RANGE",
      start: new Date("2026-09-10T00:00:00.000Z"),
      end: new Date("2026-09-22T00:00:00.000Z"),
    };
    expect(isPastDate(range, NOW)).toBe(false);
    expect(isPastDate({ ...range, end: new Date("2026-09-19T00:00:00.000Z") }, NOW)).toBe(true);
  });

  it("refuses a window, which never named a day, and a missing or TBD date", () => {
    const window: CandidateDate = {
      kind: "WINDOW",
      granularity: "MONTH",
      start: new Date("2026-07-01T00:00:00.000Z"),
      end: new Date("2026-07-31T00:00:00.000Z"),
    };
    expect(isPastDate(window, NOW)).toBe(false);
    expect(isPastDate({ kind: "TBD" }, NOW)).toBe(false);
    expect(isPastDate(null, NOW)).toBe(false);
    expect(isPastDate(undefined, NOW)).toBe(false);
  });
});

type Candidate = Awaited<ReturnType<ReleaseLifecycleDeps["getReleaseLifecycleCandidates"]>>[number];

function fakeDeps(candidates: Candidate[], options: { fail?: boolean } = {}) {
  const marked: string[][] = [];
  const deps = {
    getReleaseLifecycleCandidates: async () => {
      if (options.fail) throw new Error("db down");
      return candidates;
    },
    markEventsReleased: async (ids: string[]) => {
      marked.push(ids);
      return { count: ids.length };
    },
  } as unknown as ReleaseLifecycleDeps;
  return { deps, marked };
}

function event(id: string, iso: string, overrides: Partial<Candidate> = {}): Candidate {
  return { id, type: "SHELF", status: "CONFIRMED", date: exact(iso), ...overrides };
}

describe("runReleaseLifecycle", () => {
  it("marks only events whose date is over", async () => {
    const { deps, marked } = fakeDeps([
      event("past", "2026-06-26T00:00:00.000Z"),
      event("today", "2026-09-20T00:00:00.000Z"),
      event("future", "2026-10-02T00:00:00.000Z"),
    ]);
    const result = await runReleaseLifecycle({ installIds: ["i"], now: NOW }, deps);

    expect(marked).toEqual([["past"]]);
    expect(result.released.map((r) => r.id)).toEqual(["past"]);
    expect(result.errors).toBe(0);
  });

  it("does nothing, and writes nothing, when nothing is due", async () => {
    const { deps, marked } = fakeDeps([event("future", "2026-10-02T00:00:00.000Z")]);
    const result = await runReleaseLifecycle({ installIds: ["i"], now: NOW }, deps);
    expect(result.released).toEqual([]);
    expect(marked).toEqual([]);
  });

  it("does nothing for no installs", async () => {
    const { deps, marked } = fakeDeps([event("past", "2026-06-26T00:00:00.000Z")]);
    expect((await runReleaseLifecycle({ installIds: [], now: NOW }, deps)).released).toEqual([]);
    expect(marked).toEqual([]);
  });

  it("flags a release as recent only inside the notification window", async () => {
    const dayAfter = (days: number) => new Date(NOW.getTime() - days * DAY_MS).toISOString().slice(0, 10) + "T00:00:00.000Z";
    const { deps } = fakeDeps([
      event("yesterday", dayAfter(1)),
      event("edge-in", dayAfter(RELEASE_NOTIFY_WINDOW_DAYS - 1)),
      event("edge-out", dayAfter(RELEASE_NOTIFY_WINDOW_DAYS + 1)),
      event("june", "2026-06-26T00:00:00.000Z"),
    ]);
    const { released } = await runReleaseLifecycle({ installIds: ["i"], now: NOW }, deps);
    const recent = Object.fromEntries(released.map((r) => [r.id, r.recent]));
    // The first run after this shipped marks months of history; none of it is news.
    expect(recent).toEqual({ yesterday: true, "edge-in": true, "edge-out": false, june: false });
  });

  it("records what status each event had, so an alert can say what changed", async () => {
    const { deps } = fakeDeps([event("a", "2026-06-26T00:00:00.000Z", { status: "ANNOUNCED", type: "PRERELEASE" })]);
    const { released } = await runReleaseLifecycle({ installIds: ["i"], now: NOW }, deps);
    expect(released[0]).toMatchObject({ statusBefore: "ANNOUNCED", type: "PRERELEASE" });
  });

  it("handles a RANGE by its last day", async () => {
    const range: CandidateDate = {
      kind: "RANGE",
      start: new Date("2026-09-10T00:00:00.000Z"),
      end: new Date("2026-09-25T00:00:00.000Z"),
    };
    const { deps, marked } = fakeDeps([event("range", "x", { date: range })]);
    await runReleaseLifecycle({ installIds: ["i"], now: NOW }, deps);
    expect(marked).toEqual([]);
  });

  it("reports a failure instead of throwing, so it cannot fail a run that produced good dates", async () => {
    const { deps } = fakeDeps([], { fail: true });
    const result = await runReleaseLifecycle({ installIds: ["i"], now: NOW }, deps);
    expect(result).toEqual({ released: [], errors: 1 });
  });
});

// ---------------------------------------------------------------------------
// Against the real database
// ---------------------------------------------------------------------------

let installId: string;
let productSetId: string;

async function makeEvent(data: {
  status: "RUMORED" | "ANNOUNCED" | "CONFIRMED" | "RELEASED" | "CANCELLED";
  iso: string | null;
  dateType?: "EXACT" | "WINDOW" | "TBD";
  isManualOverride?: boolean;
  archivedAt?: Date | null;
  type?: "SHELF" | "PRERELEASE";
}) {
  const dateType = data.dateType ?? (data.iso ? "EXACT" : "TBD");
  return prisma.releaseEvent.create({
    data: {
      productSetId,
      type: data.type ?? "SHELF",
      dateType,
      dateExact: dateType === "EXACT" && data.iso ? new Date(data.iso) : null,
      ...(dateType === "WINDOW"
        ? { windowGranularity: "MONTH", windowStart: new Date("2026-06-01Z"), windowEnd: new Date("2026-06-30Z") }
        : {}),
      region: "GLOBAL",
      status: data.status,
      confidence: 0.8,
      isManualOverride: data.isManualOverride ?? false,
      archivedAt: data.archivedAt ?? null,
    },
  });
}

async function statusOf(id: string) {
  return (await prisma.releaseEvent.findUniqueOrThrow({ where: { id } })).status;
}

beforeEach(async () => {
  const pkg = await prisma.tcgProfilePackage.upsert({
    where: { slug: "magic-the-gathering" },
    update: {},
    create: {
      slug: "magic-the-gathering",
      name: "Magic: The Gathering",
      version: "1.0.0",
      discoveryConfig: {},
      sourceConfigs: {},
    },
  });
  const install = await prisma.tcgProfileInstall.create({
    data: { packageId: pkg.id, installedVersion: "1.0.0", enabled: true },
  });
  installId = install.id;
  const set = await prisma.productSet.create({
    data: { tcgProfileInstallId: installId, code: `TST-${crypto.randomUUID().slice(0, 8)}`, name: "Lifecycle Set" },
  });
  productSetId = set.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("release lifecycle against the database", () => {
  it("releases past CONFIRMED and ANNOUNCED events and leaves everything else alone", async () => {
    const confirmed = await makeEvent({ status: "CONFIRMED", iso: "2026-06-26T00:00:00.000Z" });
    const announced = await makeEvent({ status: "ANNOUNCED", iso: "2026-07-10T00:00:00.000Z" });
    const rumored = await makeEvent({ status: "RUMORED", iso: "2026-06-26T00:00:00.000Z" });
    const cancelled = await makeEvent({ status: "CANCELLED", iso: "2026-06-26T00:00:00.000Z" });
    const future = await makeEvent({ status: "CONFIRMED", iso: "2026-12-01T00:00:00.000Z" });
    const today = await makeEvent({ status: "CONFIRMED", iso: "2026-09-20T00:00:00.000Z" });
    const undated = await makeEvent({ status: "ANNOUNCED", iso: null });
    const windowed = await makeEvent({ status: "CONFIRMED", iso: null, dateType: "WINDOW" });
    const pinned = await makeEvent({ status: "CONFIRMED", iso: "2026-06-26T00:00:00.000Z", isManualOverride: true });
    const archived = await makeEvent({ status: "CONFIRMED", iso: "2026-06-26T00:00:00.000Z", archivedAt: NOW });

    const result = await runReleaseLifecycle({ installIds: [installId], now: NOW }, ingestRepo);

    expect(result.errors).toBe(0);
    expect(result.released.map((r) => r.id).sort()).toEqual([confirmed.id, announced.id].sort());
    expect(await statusOf(confirmed.id)).toBe("RELEASED");
    expect(await statusOf(announced.id)).toBe("RELEASED");
    // RUMORED was never endorsed; CANCELLED is a stronger statement; a human pinned one.
    expect(await statusOf(rumored.id)).toBe("RUMORED");
    expect(await statusOf(cancelled.id)).toBe("CANCELLED");
    expect(await statusOf(pinned.id)).toBe("CONFIRMED");
    expect(await statusOf(archived.id)).toBe("CONFIRMED");
    // Not over yet, or never named a day.
    expect(await statusOf(future.id)).toBe("CONFIRMED");
    expect(await statusOf(today.id)).toBe("CONFIRMED");
    expect(await statusOf(undated.id)).toBe("ANNOUNCED");
    expect(await statusOf(windowed.id)).toBe("CONFIRMED");
  });

  it("is idempotent: a second run finds nothing to do", async () => {
    await makeEvent({ status: "CONFIRMED", iso: "2026-06-26T00:00:00.000Z" });
    expect((await runReleaseLifecycle({ installIds: [installId], now: NOW }, ingestRepo)).released).toHaveLength(1);
    expect((await runReleaseLifecycle({ installIds: [installId], now: NOW }, ingestRepo)).released).toHaveLength(0);
  });

  it("never touches another install's events", async () => {
    const mine = await makeEvent({ status: "CONFIRMED", iso: "2026-06-26T00:00:00.000Z" });
    const pkg = await prisma.tcgProfilePackage.findUniqueOrThrow({ where: { slug: "magic-the-gathering" } });
    const other = await prisma.tcgProfileInstall.create({
      data: { packageId: pkg.id, installedVersion: "1.0.0", enabled: true },
    });
    const otherSet = await prisma.productSet.create({
      data: { tcgProfileInstallId: other.id, code: `OTH-${crypto.randomUUID().slice(0, 8)}`, name: "Other" },
    });
    const theirs = await prisma.releaseEvent.create({
      data: {
        productSetId: otherSet.id,
        type: "SHELF",
        dateType: "EXACT",
        dateExact: new Date("2026-06-26T00:00:00.000Z"),
        region: "GLOBAL",
        status: "CONFIRMED",
        confidence: 0.8,
      },
    });

    await runReleaseLifecycle({ installIds: [installId], now: NOW }, ingestRepo);
    expect(await statusOf(mine.id)).toBe("RELEASED");
    expect(await statusOf(theirs.id)).toBe("CONFIRMED");
  });

  it("will not overwrite a status a concurrent verdict changed after the read", async () => {
    const event = await makeEvent({ status: "CONFIRMED", iso: "2026-06-26T00:00:00.000Z" });
    await prisma.releaseEvent.update({ where: { id: event.id }, data: { status: "CANCELLED" } });
    // The stale id list a slow caller might still be holding.
    await ingestRepo.markEventsReleased([event.id]);
    expect(await statusOf(event.id)).toBe("CANCELLED");
  });
});

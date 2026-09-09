import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getFilteredEvents, getRecentlyUpdatedEvents } from "@/data/calendar/calendarRepo";
import { prisma } from "@/lib/prisma";
import type { Region, ReleaseEventType } from "@/app/generated/prisma/client";

/**
 * A set can carry two PRERELEASE rows: a sourced one the gate refused to date
 * (rule G8 declining a claim that misses the game's schedule) and a derived one
 * carrying the scheduled date. Both rows are right, but to a reader they are
 * one prerelease listed twice -- once in the undated tab, once on the calendar.
 *
 * The dateless one is dropped at display time. These tests fix the exact scope
 * of that suppression, because the failure mode of getting it wrong is silent:
 * an over-broad rule hides a real, genuinely unplaceable prerelease and nobody
 * notices it is missing.
 */

const INSTALL_SLUG = `superseded-prerelease-${crypto.randomUUID()}`;

let installId: string;
let setCounter = 0;

async function makeSet(name: string) {
  setCounter += 1;
  return prisma.productSet.create({
    data: { tcgProfileInstallId: installId, code: `SUP-${setCounter}`, name },
  });
}

async function makeEvent(params: {
  productSetId: string;
  type: ReleaseEventType;
  region?: Region;
  date?: Date;
  archived?: boolean;
  status?: "RUMORED" | "CONFIRMED";
}) {
  return prisma.releaseEvent.create({
    data: {
      productSetId: params.productSetId,
      type: params.type,
      region: params.region ?? "GLOBAL",
      dateType: params.date ? "EXACT" : "TBD",
      dateExact: params.date ?? null,
      status: params.status ?? (params.date ? "CONFIRMED" : "RUMORED"),
      confidence: 0.5,
      ...(params.archived ? { archivedAt: new Date() } : {}),
    },
  });
}

/** Everything this install has, undated rows included -- the widest view the repo offers. */
function allForInstall() {
  return getFilteredEvents({ installIds: [installId] });
}

beforeAll(async () => {
  const pkg = await prisma.tcgProfilePackage.create({
    data: {
      slug: INSTALL_SLUG,
      name: "Superseded Prerelease Test",
      version: "1.0.0",
      discoveryConfig: {},
      sourceConfigs: {},
    },
  });
  const install = await prisma.tcgProfileInstall.create({
    data: { packageId: pkg.id, installedVersion: "1.0.0", enabled: true },
  });
  installId = install.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("a dateless prerelease superseded by a dated one", () => {
  it("is hidden, while the dated one stays", async () => {
    const set = await makeSet("Both Rows");
    const dateless = await makeEvent({ productSetId: set.id, type: "PRERELEASE" });
    const dated = await makeEvent({ productSetId: set.id, type: "PRERELEASE", date: new Date("2026-07-17") });

    const ids = (await allForInstall()).map((event) => event.id);
    expect(ids).toContain(dated.id);
    expect(ids).not.toContain(dateless.id);
  });

  it("is hidden from the undated tab specifically, which is where it showed", async () => {
    const set = await makeSet("Undated Tab");
    const dateless = await makeEvent({ productSetId: set.id, type: "PRERELEASE" });
    await makeEvent({ productSetId: set.id, type: "PRERELEASE", date: new Date("2026-07-17") });

    const undated = await getFilteredEvents({ installIds: [installId], dateTypes: ["TBD"] });
    expect(undated.map((event) => event.id)).not.toContain(dateless.id);
  });

  it("stays hidden even when the dated row is filtered out of the same result", async () => {
    const set = await makeSet("Filtered Sibling");
    const dateless = await makeEvent({ productSetId: set.id, type: "PRERELEASE", status: "RUMORED" });
    await makeEvent({ productSetId: set.id, type: "PRERELEASE", date: new Date("2026-07-17"), status: "CONFIRMED" });

    // Filtering to RUMORED excludes the dated row, but the dateless one does
    // not reappear: suppression that flickered with a status chip would be
    // harder to explain than a row that is consistently absent.
    const rumored = await getFilteredEvents({ installIds: [installId], statuses: ["RUMORED"] });
    expect(rumored.map((event) => event.id)).not.toContain(dateless.id);
  });

  it("is hidden from the dashboard's recently-updated feed too", async () => {
    const set = await makeSet("Recent Feed");
    const dateless = await makeEvent({ productSetId: set.id, type: "PRERELEASE" });
    const dated = await makeEvent({ productSetId: set.id, type: "PRERELEASE", date: new Date("2026-07-17") });

    const recent = await getRecentlyUpdatedEvents({
      installIds: [installId],
      updatedSince: new Date(Date.now() - 60_000),
    });
    const ids = recent.map((event) => event.id);
    expect(ids).toContain(dated.id);
    expect(ids).not.toContain(dateless.id);
  });
});

describe("what suppression must not touch", () => {
  it("keeps a dateless prerelease that nothing supersedes", async () => {
    const set = await makeSet("Genuinely Unplaceable");
    const dateless = await makeEvent({ productSetId: set.id, type: "PRERELEASE" });

    // The whole point of the undated tab: we know a prerelease exists and
    // cannot place it. Hiding this would lose the fact entirely.
    const ids = (await allForInstall()).map((event) => event.id);
    expect(ids).toContain(dateless.id);
  });

  it("keeps a dateless prerelease in another region", async () => {
    const set = await makeSet("Two Regions");
    const globalDateless = await makeEvent({ productSetId: set.id, type: "PRERELEASE", region: "GLOBAL" });
    const jpDated = await makeEvent({
      productSetId: set.id,
      type: "PRERELEASE",
      region: "JP",
      date: new Date("2026-07-17"),
    });

    // A dated Japanese prerelease says nothing about an undated global one.
    const ids = (await allForInstall()).map((event) => event.id);
    expect(ids).toContain(globalDateless.id);
    expect(ids).toContain(jpDated.id);
  });

  it("keeps a dateless prerelease whose only dated sibling is archived", async () => {
    const set = await makeSet("Archived Sibling");
    const dateless = await makeEvent({ productSetId: set.id, type: "PRERELEASE" });
    await makeEvent({ productSetId: set.id, type: "PRERELEASE", date: new Date("2026-07-17"), archived: true });

    // An archived row is off the calendar, so it supersedes nothing.
    const ids = (await allForInstall()).map((event) => event.id);
    expect(ids).toContain(dateless.id);
  });

  it("leaves other event types alone", async () => {
    const set = await makeSet("Other Types");
    const datelessShelf = await makeEvent({ productSetId: set.id, type: "SHELF" });
    await makeEvent({ productSetId: set.id, type: "SHELF", date: new Date("2026-07-24") });
    const datelessPromo = await makeEvent({ productSetId: set.id, type: "PROMO" });
    await makeEvent({ productSetId: set.id, type: "PROMO", date: new Date("2026-07-24") });

    // PRERELEASE is the only type this pipeline writes a parallel derived row
    // for; two SHELF rows for one product mean something else entirely.
    const ids = (await allForInstall()).map((event) => event.id);
    expect(ids).toContain(datelessShelf.id);
    expect(ids).toContain(datelessPromo.id);
  });

  it("does not let one product's dated prerelease hide another's", async () => {
    const covered = await makeSet("Covered Product");
    await makeEvent({ productSetId: covered.id, type: "PRERELEASE" });
    await makeEvent({ productSetId: covered.id, type: "PRERELEASE", date: new Date("2026-07-17") });

    const uncovered = await makeSet("Uncovered Product");
    const lonely = await makeEvent({ productSetId: uncovered.id, type: "PRERELEASE" });

    const ids = (await allForInstall()).map((event) => event.id);
    expect(ids).toContain(lonely.id);
  });
});

import { describe, expect, it } from "vitest";
import { derivePrereleaseEvents, type DerivePrereleaseDeps } from "@/lib/ingest/derivePrereleases";
import type { CandidateDate } from "@/lib/ingest/types";

/**
 * The derivation pass reconciles derived prerelease rows against the shelf
 * dates that imply them, so what matters is not any single write but the
 * *convergence*: for a given set of anchors the pass must always leave the same
 * rows in place, whatever it did last run.
 *
 * Tested against a hand-written fake of the five repo functions it uses (the
 * same seam apply.ts uses), so every case here is a pure statement about the
 * reconciliation rather than about Prisma.
 */

const NOW = new Date("2026-06-01T00:00:00.000Z");
const INSTALLS = ["install-1"];

// 2026-07-24 is a Friday.
const SHELF_FRIDAY = new Date("2026-07-24T00:00:00.000Z");

function exact(date: Date | string): CandidateDate {
  return { kind: "EXACT", date: typeof date === "string" ? new Date(date) : date };
}

type Anchor = Awaited<ReturnType<DerivePrereleaseDeps["getShelfAnchors"]>>[number];
type Sourced = Awaited<ReturnType<DerivePrereleaseDeps["getSourcedPrereleaseDates"]>>[number];
type Derived = Awaited<ReturnType<DerivePrereleaseDeps["getDerivedPrereleaseEvents"]>>[number];
type Upsert = Parameters<DerivePrereleaseDeps["upsertDerivedPrereleaseEvent"]>[0];

function anchor(overrides: Partial<Anchor> = {}): Anchor {
  return {
    id: "shelf-1",
    productSetId: "set-1",
    region: "GLOBAL",
    status: "CONFIRMED",
    confidence: 0.82,
    game: "magic-the-gathering",
    date: exact(SHELF_FRIDAY),
    ...overrides,
  };
}

function derivedRow(overrides: Partial<Derived> = {}): Derived {
  return {
    id: "derived-1",
    productSetId: "set-1",
    region: "GLOBAL",
    status: "CONFIRMED",
    archivedAt: null,
    derivedFromEventId: "shelf-1",
    derivedSlot: "friday-1",
    date: exact("2026-07-17T00:00:00.000Z"),
    ...overrides,
  };
}

type Recorded = { upserts: Upsert[]; archived: Array<{ id: string; now: Date }> };

function fakeDeps(state: { anchors?: Anchor[]; sourced?: Sourced[]; derived?: Derived[]; failUpsert?: boolean }): {
  deps: DerivePrereleaseDeps;
  recorded: Recorded;
} {
  const recorded: Recorded = { upserts: [], archived: [] };
  const deps = {
    getShelfAnchors: async () => state.anchors ?? [],
    getSourcedPrereleaseDates: async () => state.sourced ?? [],
    getDerivedPrereleaseEvents: async () => state.derived ?? [],
    upsertDerivedPrereleaseEvent: async (params: Upsert) => {
      if (state.failUpsert) throw new Error("write failed");
      recorded.upserts.push(params);
      return {} as never;
    },
    archiveDerivedPrereleaseEvent: async (id: string, now: Date) => {
      recorded.archived.push({ id, now });
      return {} as never;
    },
  } as unknown as DerivePrereleaseDeps;
  return { deps, recorded };
}

function isoOf(date: CandidateDate): string {
  if (date.kind !== "EXACT") throw new Error(`expected EXACT, got ${date.kind}`);
  return date.date.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------

describe("deriving from a confirmed shelf date", () => {
  it("writes one row per schedule slot", () => {
    return (async () => {
      const { deps, recorded } = fakeDeps({ anchors: [anchor({ game: "pokemon-tcg" })] });
      const result = await derivePrereleaseEvents({ installIds: INSTALLS, now: NOW }, deps);

      expect(result.written).toBe(2);
      expect(recorded.upserts.map((u) => [u.derivedSlot, isoOf(u.date)])).toEqual([
        ["friday-1", "2026-07-17"],
        ["friday-2", "2026-07-10"],
      ]);
    })();
  });

  it("keys each row on its anchor event and slot, which is what stops slot two overwriting slot one", async () => {
    const { deps, recorded } = fakeDeps({ anchors: [anchor({ game: "yugioh-tcg" })] });
    await derivePrereleaseEvents({ installIds: INSTALLS, now: NOW }, deps);

    const keys = recorded.upserts.map((u) => `${u.derivedFromEventId}/${u.derivedSlot}`);
    expect(keys).toEqual(["shelf-1/saturday-1", "shelf-1/sunday-1"]);
    expect(new Set(keys).size).toBe(2);
  });

  it("inherits the anchor's region and confidence rather than inventing its own", async () => {
    const { deps, recorded } = fakeDeps({ anchors: [anchor({ region: "JP", confidence: 0.41 })] });
    await derivePrereleaseEvents({ installIds: INSTALLS, now: NOW }, deps);

    expect(recorded.upserts[0].region).toBe("JP");
    expect(recorded.upserts[0].confidence).toBe(0.41);
    expect(recorded.upserts[0].status).toBe("CONFIRMED");
  });

  it("records why the date exists, so a derived row is never mistaken for a sourced one", async () => {
    const { deps, recorded } = fakeDeps({ anchors: [anchor()] });
    await derivePrereleaseEvents({ installIds: INSTALLS, now: NOW }, deps);

    expect(recorded.upserts[0].sourceSummary).toContain("derived from the confirmed release date");
    expect(recorded.upserts[0].sourceSummary).toContain("Prerelease weekend");
  });
});

describe("what does not anchor a prerelease", () => {
  it("declines a shelf date that is not CONFIRMED", async () => {
    for (const status of ["RUMORED", "ANNOUNCED", "CANCELLED"] as const) {
      const { deps, recorded } = fakeDeps({ anchors: [anchor({ status })] });
      await derivePrereleaseEvents({ installIds: INSTALLS, now: NOW }, deps);
      expect(recorded.upserts, `status ${status}`).toEqual([]);
    }
  });

  it("declines a shelf date that is only a month window", async () => {
    const { deps, recorded } = fakeDeps({
      anchors: [
        anchor({
          date: {
            kind: "WINDOW",
            granularity: "MONTH",
            start: new Date("2026-07-01T00:00:00.000Z"),
            end: new Date("2026-07-31T00:00:00.000Z"),
          },
        }),
      ],
    });
    await derivePrereleaseEvents({ installIds: INSTALLS, now: NOW }, deps);
    expect(recorded.upserts).toEqual([]);
  });

  it("declines a game with no schedule, even with a perfectly confirmed date", async () => {
    const { deps, recorded } = fakeDeps({ anchors: [anchor({ game: "riftbound" })] });
    await derivePrereleaseEvents({ installIds: INSTALLS, now: NOW }, deps);
    expect(recorded.upserts).toEqual([]);
  });

  it("does nothing at all when no installs are in scope", async () => {
    const { deps, recorded } = fakeDeps({ anchors: [anchor()] });
    const result = await derivePrereleaseEvents({ installIds: [], now: NOW }, deps);
    expect(result).toEqual({ written: 0, retracted: 0, errors: 0 });
    expect(recorded.upserts).toEqual([]);
  });
});

describe("standing aside for a real source", () => {
  it("skips a slot a sourced prerelease already covers", async () => {
    const { deps, recorded } = fakeDeps({
      anchors: [anchor()],
      sourced: [{ id: "sourced-1", productSetId: "set-1", region: "GLOBAL", date: exact("2026-07-17T00:00:00.000Z") }],
    });
    await derivePrereleaseEvents({ installIds: INSTALLS, now: NOW }, deps);
    expect(recorded.upserts).toEqual([]);
  });

  it("uses the gate's agreement window to decide 'already covered'", async () => {
    // Two days out: same event, stated slightly differently. Stand aside.
    const near = fakeDeps({
      anchors: [anchor()],
      sourced: [{ id: "s", productSetId: "set-1", region: "GLOBAL", date: exact("2026-07-19T00:00:00.000Z") }],
    });
    await derivePrereleaseEvents({ installIds: INSTALLS, now: NOW }, near.deps);
    expect(near.recorded.upserts).toEqual([]);

    // Ten days out: a different occasion entirely, so the slot is still ours.
    const far = fakeDeps({
      anchors: [anchor()],
      sourced: [{ id: "s", productSetId: "set-1", region: "GLOBAL", date: exact("2026-07-07T00:00:00.000Z") }],
    });
    await derivePrereleaseEvents({ installIds: INSTALLS, now: NOW }, far.deps);
    expect(far.recorded.upserts).toHaveLength(1);
  });

  it("does not let one region's sourced date suppress another region's slot", async () => {
    const { deps, recorded } = fakeDeps({
      anchors: [anchor({ region: "JP" })],
      sourced: [{ id: "s", productSetId: "set-1", region: "GLOBAL", date: exact("2026-07-17T00:00:00.000Z") }],
    });
    await derivePrereleaseEvents({ installIds: INSTALLS, now: NOW }, deps);
    expect(recorded.upserts).toHaveLength(1);
    expect(recorded.upserts[0].region).toBe("JP");
  });

  it("retracts a derived row once a source starts publishing that date", async () => {
    const { deps, recorded } = fakeDeps({
      anchors: [anchor()],
      sourced: [{ id: "s", productSetId: "set-1", region: "GLOBAL", date: exact("2026-07-17T00:00:00.000Z") }],
      derived: [derivedRow()],
    });
    const result = await derivePrereleaseEvents({ installIds: INSTALLS, now: NOW }, deps);
    expect(result.retracted).toBe(1);
    expect(recorded.archived).toEqual([{ id: "derived-1", now: NOW }]);
  });
});

describe("retraction", () => {
  it("archives a derived row whose anchor stopped being confirmed", async () => {
    const { deps, recorded } = fakeDeps({
      anchors: [anchor({ status: "ANNOUNCED" })],
      derived: [derivedRow()],
    });
    const result = await derivePrereleaseEvents({ installIds: INSTALLS, now: NOW }, deps);
    expect(result).toMatchObject({ written: 0, retracted: 1 });
    expect(recorded.archived).toEqual([{ id: "derived-1", now: NOW }]);
  });

  it("archives a derived row whose anchor has gone entirely", async () => {
    const { deps, recorded } = fakeDeps({ anchors: [], derived: [derivedRow()] });
    await derivePrereleaseEvents({ installIds: INSTALLS, now: NOW }, deps);
    expect(recorded.archived.map((a) => a.id)).toEqual(["derived-1"]);
  });

  it("archives a slot the game's schedule no longer has", async () => {
    // Magic has one slot; a row from a two-slot era is no longer wanted.
    const { deps, recorded } = fakeDeps({
      anchors: [anchor()],
      derived: [derivedRow(), derivedRow({ id: "derived-2", derivedSlot: "friday-2" })],
    });
    await derivePrereleaseEvents({ installIds: INSTALLS, now: NOW }, deps);
    expect(recorded.upserts.map((u) => u.derivedSlot)).toEqual(["friday-1"]);
    expect(recorded.archived.map((a) => a.id)).toEqual(["derived-2"]);
  });

  it("leaves an already-archived row alone instead of re-archiving it every run", async () => {
    const { deps, recorded } = fakeDeps({
      anchors: [],
      derived: [derivedRow({ archivedAt: new Date("2026-05-01T00:00:00.000Z") })],
    });
    const result = await derivePrereleaseEvents({ installIds: INSTALLS, now: NOW }, deps);
    expect(result.retracted).toBe(0);
    expect(recorded.archived).toEqual([]);
  });

  it("brings an archived row back through the upsert when its anchor re-confirms", async () => {
    const { deps, recorded } = fakeDeps({
      anchors: [anchor()],
      derived: [derivedRow({ archivedAt: new Date("2026-05-01T00:00:00.000Z") })],
    });
    await derivePrereleaseEvents({ installIds: INSTALLS, now: NOW }, deps);
    // The same (anchor, slot) key, so the repo's upsert lands on the existing
    // row and clears its archivedAt -- follows and notes stay attached.
    expect(recorded.upserts).toHaveLength(1);
    expect(recorded.upserts[0].derivedFromEventId).toBe("shelf-1");
    expect(recorded.upserts[0].derivedSlot).toBe("friday-1");
    expect(recorded.archived).toEqual([]);
  });
});

describe("convergence and isolation", () => {
  it("moves an existing row with its anchor rather than adding a second one", async () => {
    const { deps, recorded } = fakeDeps({
      anchors: [anchor({ date: exact("2026-07-31T00:00:00.000Z") })],
      derived: [derivedRow()],
    });
    const result = await derivePrereleaseEvents({ installIds: INSTALLS, now: NOW }, deps);

    expect(result).toMatchObject({ written: 1, retracted: 0 });
    expect(isoOf(recorded.upserts[0].date)).toBe("2026-07-24");
    expect(recorded.archived).toEqual([]);
  });

  it("is idempotent: the same anchors produce the same rows however often it runs", async () => {
    const state = { anchors: [anchor({ game: "pokemon-tcg" })], derived: [] as Derived[] };
    const first = fakeDeps(state);
    await derivePrereleaseEvents({ installIds: INSTALLS, now: NOW }, first.deps);

    // Feed the first run's writes back in as existing rows and run again.
    const second = fakeDeps({
      anchors: state.anchors,
      derived: first.recorded.upserts.map((u, index) =>
        derivedRow({
          id: `derived-${index}`,
          derivedFromEventId: u.derivedFromEventId,
          derivedSlot: u.derivedSlot,
          date: u.date,
        }),
      ),
    });
    await derivePrereleaseEvents({ installIds: INSTALLS, now: NOW }, second.deps);

    expect(second.recorded.upserts.map((u) => [u.derivedSlot, isoOf(u.date)])).toEqual(
      first.recorded.upserts.map((u) => [u.derivedSlot, isoOf(u.date)]),
    );
    expect(second.recorded.archived).toEqual([]);
  });

  it("counts a failed write as an error and keeps going rather than aborting the run", async () => {
    const { deps } = fakeDeps({ anchors: [anchor({ game: "pokemon-tcg" })], failUpsert: true });
    const result = await derivePrereleaseEvents({ installIds: INSTALLS, now: NOW }, deps);
    expect(result).toMatchObject({ written: 0, errors: 2 });
  });
});

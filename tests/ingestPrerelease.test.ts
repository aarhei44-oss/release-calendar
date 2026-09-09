import { describe, expect, it } from "vitest";
import {
  MAX_PRERELEASE_LEAD_DAYS,
  PRERELEASE_SCHEDULES,
  expectedPrereleaseDates,
  nthWeekdayBefore,
  prereleaseOccurrencesFor,
  prereleaseScheduleFor,
} from "@/lib/ingest/prerelease";
import { PRODUCTION_PROVIDERS } from "@/lib/ingest/providers/registry";
import type { CandidateDate } from "@/lib/ingest/types";

/**
 * The schedules in lib/ingest/prerelease.ts are the only reason most of these
 * games have prerelease dates on the calendar at all, so a wrong offset here
 * publishes a wrong date rather than merely failing to publish one. Everything
 * below is a pure unit test against literal dates whose weekday is stated in
 * the test name, so a regression names the day it broke.
 */

function exact(iso: string): CandidateDate {
  return { kind: "EXACT", date: new Date(iso) };
}

function isoOf(date: CandidateDate): string {
  if (date.kind !== "EXACT") throw new Error(`expected an EXACT date, got ${date.kind}`);
  return date.date.toISOString().slice(0, 10);
}

// 2026-07-24 is a Friday, which is what every one of these games ships on.
const SHELF_FRIDAY = exact("2026-07-24T00:00:00.000Z");

describe("PRERELEASE_SCHEDULES coverage", () => {
  it("has an entry for every game the pipeline ingests, so 'no rule' is a decision and not an omission", () => {
    // Sourced from the provider registry rather than a second hardcoded list:
    // adding a game means registering a provider for it, and that must be what
    // fails this test -- otherwise a new game silently gets no prereleases and
    // nobody finds out.
    const ingested = [...new Set(PRODUCTION_PROVIDERS.flatMap((provider) => provider.games))].sort();
    expect(Object.keys(PRERELEASE_SCHEDULES).sort()).toEqual(ingested);
  });

  it("explains itself for every game, including the ones with no slots", () => {
    for (const [game, schedule] of Object.entries(PRERELEASE_SCHEDULES)) {
      expect(schedule.note.length, `${game} has no note`).toBeGreaterThan(40);
    }
  });

  it("keeps slot keys unique within a game -- they are the derived row's identity", () => {
    for (const [game, schedule] of Object.entries(PRERELEASE_SCHEDULES)) {
      const keys = schedule.slots.map((slot) => slot.key);
      expect(new Set(keys).size, `${game} has duplicate slot keys`).toBe(keys.length);
    }
  });

  it("treats a game with no slots as having no schedule at all", () => {
    expect(prereleaseScheduleFor("gundam-card-game")).toBeNull();
    expect(prereleaseScheduleFor("union-arena-tcg")).toBeNull();
    // Riftbound is the interesting one: it is excluded because Riot publishes
    // the real Pre-Rift date, not because nothing happens.
    expect(prereleaseScheduleFor("riftbound")).toBeNull();
    expect(prereleaseScheduleFor("not-a-game")).toBeNull();
  });
});

describe("nthWeekdayBefore", () => {
  it("counts back strictly, so the Friday before a Friday is seven days earlier", () => {
    // 5 = Friday.
    expect(nthWeekdayBefore(new Date("2026-07-24T00:00:00.000Z"), 5, 1).toISOString().slice(0, 10)).toBe("2026-07-17");
  });

  it("counts further back by whole weeks for later occurrences", () => {
    expect(nthWeekdayBefore(new Date("2026-07-24T00:00:00.000Z"), 5, 2).toISOString().slice(0, 10)).toBe("2026-07-10");
  });

  it("finds the immediately preceding weekend from a Friday anchor", () => {
    // 6 = Saturday, 0 = Sunday. Both land on the weekend before the street date
    // and are consecutive days, which is what Konami's Sneak Peek actually is.
    expect(nthWeekdayBefore(new Date("2026-07-24T00:00:00.000Z"), 6, 1).toISOString().slice(0, 10)).toBe("2026-07-18");
    expect(nthWeekdayBefore(new Date("2026-07-24T00:00:00.000Z"), 0, 1).toISOString().slice(0, 10)).toBe("2026-07-19");
  });

  it("works in UTC, not local time", () => {
    // A UTC-midnight Friday is Thursday evening in every US timezone; reading
    // the local weekday here would shift every prerelease by a day.
    const anchor = new Date("2026-07-24T00:00:00.000Z");
    expect(anchor.getUTCDay()).toBe(5);
    expect(nthWeekdayBefore(anchor, 5, 1).getUTCDay()).toBe(5);
  });
});

describe("per-game schedules", () => {
  it("Magic: the Friday before the Friday street date", () => {
    const occurrences = prereleaseOccurrencesFor("magic-the-gathering", SHELF_FRIDAY);
    expect(occurrences.map((o) => [o.slotKey, isoOf(o.date)])).toEqual([["friday-1", "2026-07-17"]]);
  });

  it("Lorcana: the local-game-store Friday a week before wide retail", () => {
    const occurrences = prereleaseOccurrencesFor("disney-lorcana", SHELF_FRIDAY);
    expect(occurrences.map((o) => isoOf(o.date))).toEqual(["2026-07-17"]);
  });

  it("One Piece: matches Bandai's real OP-17 dates", () => {
    // Bandai ran OP-17 pre-release events from 2026-08-21 for a 2026-08-28
    // release; the schedule has to reproduce that from the shelf date alone.
    const occurrences = prereleaseOccurrencesFor("one-piece-tcg", exact("2026-08-28T00:00:00.000Z"));
    expect(occurrences.map((o) => isoOf(o.date))).toEqual(["2026-08-21"]);
  });

  it("Pokemon: both Fridays before the street date, nearest first", () => {
    const occurrences = prereleaseOccurrencesFor("pokemon-tcg", SHELF_FRIDAY);
    expect(occurrences.map((o) => [o.slotKey, isoOf(o.date)])).toEqual([
      ["friday-1", "2026-07-17"],
      ["friday-2", "2026-07-10"],
    ]);
  });

  it("Yu-Gi-Oh!: two single-day Sneak Peek events, not one weekend-long range", () => {
    const occurrences = prereleaseOccurrencesFor("yugioh-tcg", SHELF_FRIDAY);
    expect(occurrences.map((o) => [o.slotKey, isoOf(o.date)])).toEqual([
      ["saturday-1", "2026-07-18"],
      ["sunday-1", "2026-07-19"],
    ]);
    for (const occurrence of occurrences) {
      expect(occurrence.date.kind).toBe("EXACT");
    }
  });

  it("produces nothing for a game with no schedule", () => {
    expect(prereleaseOccurrencesFor("riftbound", SHELF_FRIDAY)).toEqual([]);
    expect(prereleaseOccurrencesFor("gundam-card-game", SHELF_FRIDAY)).toEqual([]);
  });
});

describe("what refuses to produce a date", () => {
  it("refuses a shelf date that is only a month window", () => {
    const window: CandidateDate = {
      kind: "WINDOW",
      granularity: "MONTH",
      start: new Date("2026-07-01T00:00:00.000Z"),
      end: new Date("2026-07-31T00:00:00.000Z"),
    };
    // "October 2026" names no weekday; inventing one would manufacture a
    // precision no source ever stated.
    expect(prereleaseOccurrencesFor("magic-the-gathering", window)).toEqual([]);
  });

  it("refuses a TBD or missing shelf date", () => {
    expect(prereleaseOccurrencesFor("magic-the-gathering", { kind: "TBD" })).toEqual([]);
    expect(prereleaseOccurrencesFor("magic-the-gathering", null)).toEqual([]);
  });

  it("refuses a slot further out than the lead-time backstop allows", () => {
    // The backstop only bites on a degenerate anchor, so assert the bound
    // itself rather than contriving a game: every real slot sits inside it.
    for (const [game, schedule] of Object.entries(PRERELEASE_SCHEDULES)) {
      for (const slot of schedule.slots) {
        expect(slot.occurrence * 7, `${game}/${slot.key}`).toBeLessThanOrEqual(MAX_PRERELEASE_LEAD_DAYS);
      }
    }
  });
});

describe("expectedPrereleaseDates (the input to gate rule G8)", () => {
  it("is the occurrence dates with the slots dropped -- the gate has no business knowing about slots", () => {
    expect(expectedPrereleaseDates("pokemon-tcg", SHELF_FRIDAY).map(isoOf)).toEqual(["2026-07-17", "2026-07-10"]);
  });

  it("is empty wherever there is nothing to check against, which makes G8 inert", () => {
    expect(expectedPrereleaseDates("riftbound", SHELF_FRIDAY)).toEqual([]);
    expect(expectedPrereleaseDates("magic-the-gathering", null)).toEqual([]);
  });
});

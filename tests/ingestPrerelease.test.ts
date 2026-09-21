import { describe, expect, it } from "vitest";
import {
  MAX_PRERELEASE_LEAD_DAYS,
  type PrereleaseProduct,
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

// A main, prerelease-bearing product for each scheduled game. Which products a
// schedule applies to is tested separately below; these exist so the weekday
// arithmetic tests are not also testing eligibility.
const MTG_MAIN: PrereleaseProduct = { code: "FRA", name: "Reality Fracture", kind: "expansion" };
const LORCANA_MAIN: PrereleaseProduct = { code: "14", name: "Hyperia City" };
const ONE_PIECE_MAIN: PrereleaseProduct = { code: "OP-17", name: "BOOSTER PACK -THE WORLD'S STRONGEST WARRIORS-" };
const POKEMON_MAIN: PrereleaseProduct = { code: "DLR", name: "Mega Evolution—Delta Reign" };
const YUGIOH_MAIN: PrereleaseProduct = { code: "BETB", name: "Beyond the Brave" };

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
    expect(prereleaseScheduleFor("digimon-card-game")).toBeNull();
    expect(prereleaseScheduleFor("flesh-and-blood")).toBeNull();
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
    const occurrences = prereleaseOccurrencesFor("magic-the-gathering", SHELF_FRIDAY, MTG_MAIN);
    expect(occurrences.map((o) => [o.slotKey, isoOf(o.date)])).toEqual([["friday-1", "2026-07-17"]]);
  });

  it("Lorcana: the local-game-store Friday a week before wide retail", () => {
    const occurrences = prereleaseOccurrencesFor("disney-lorcana", SHELF_FRIDAY, LORCANA_MAIN);
    expect(occurrences.map((o) => isoOf(o.date))).toEqual(["2026-07-17"]);
  });

  it("One Piece: matches Bandai's real OP-17 dates", () => {
    // Bandai ran OP-17 pre-release events from 2026-08-21 for a 2026-08-28
    // release; the schedule has to reproduce that from the shelf date alone.
    const occurrences = prereleaseOccurrencesFor("one-piece-tcg", exact("2026-08-28T00:00:00.000Z"), ONE_PIECE_MAIN);
    expect(occurrences.map((o) => isoOf(o.date))).toEqual(["2026-08-21"]);
  });

  it("Pokemon: the Saturday that opens each of the two weekends before the street date, nearest first", () => {
    // Saturdays, not Fridays: Pitch Black's events opened Saturday 2026-07-04 for
    // a Friday 2026-07-17 release, and Delta Reign's open Saturday 2026-10-24 for
    // Friday 2026-11-06. Anchoring on Friday put every derived date a day early.
    const occurrences = prereleaseOccurrencesFor("pokemon-tcg", SHELF_FRIDAY, POKEMON_MAIN);
    expect(occurrences.map((o) => [o.slotKey, isoOf(o.date)])).toEqual([
      ["saturday-1", "2026-07-18"],
      ["saturday-2", "2026-07-11"],
    ]);
  });

  it("Pokemon: reproduces the two real prerelease openings from their release dates alone", () => {
    const pitchBlack = prereleaseOccurrencesFor("pokemon-tcg", exact("2026-07-17T00:00:00.000Z"), POKEMON_MAIN);
    expect(pitchBlack.map((o) => isoOf(o.date)).sort()).toEqual(["2026-07-04", "2026-07-11"]);
    const deltaReign = prereleaseOccurrencesFor("pokemon-tcg", exact("2026-11-06T00:00:00.000Z"), POKEMON_MAIN);
    expect(deltaReign.map((o) => isoOf(o.date)).sort()).toEqual(["2026-10-24", "2026-10-31"]);
  });

  it("Yu-Gi-Oh!: the Sunday Sneak Peek only -- the Saturday one could not be confirmed", () => {
    const occurrences = prereleaseOccurrencesFor("yugioh-tcg", SHELF_FRIDAY, YUGIOH_MAIN);
    expect(occurrences.map((o) => [o.slotKey, isoOf(o.date)])).toEqual([["sunday-1", "2026-07-19"]]);
    expect(occurrences[0].date.kind).toBe("EXACT");
  });

  it("Yu-Gi-Oh!: reproduces the real Chaos Origins and Beyond the Brave Sundays", () => {
    // Retailer event listings: Chaos Origins Sneak Peek Sunday 2026-06-28 for a
    // 2026-07-03 release; Beyond the Brave Sunday 2026-10-04 for 2026-10-09.
    expect(
      prereleaseOccurrencesFor("yugioh-tcg", exact("2026-07-03T00:00:00.000Z"), { code: "CORI", name: "Chaos Origins" }).map(
        (o) => isoOf(o.date),
      ),
    ).toEqual(["2026-06-28"]);
    expect(
      prereleaseOccurrencesFor("yugioh-tcg", exact("2026-10-09T00:00:00.000Z"), YUGIOH_MAIN).map((o) => isoOf(o.date)),
    ).toEqual(["2026-10-04"]);
  });

  it("produces nothing for a game with no schedule", () => {
    expect(prereleaseOccurrencesFor("riftbound", SHELF_FRIDAY, { code: "RAD", name: "Radiance" })).toEqual([]);
    expect(prereleaseOccurrencesFor("gundam-card-game", SHELF_FRIDAY, { code: "GD06", name: "Stardust Trails" })).toEqual([]);
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
    expect(prereleaseOccurrencesFor("magic-the-gathering", window, MTG_MAIN)).toEqual([]);
  });

  it("refuses a TBD or missing shelf date", () => {
    expect(prereleaseOccurrencesFor("magic-the-gathering", { kind: "TBD" }, MTG_MAIN)).toEqual([]);
    expect(prereleaseOccurrencesFor("magic-the-gathering", null, MTG_MAIN)).toEqual([]);
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
    expect(expectedPrereleaseDates("pokemon-tcg", SHELF_FRIDAY, POKEMON_MAIN).map(isoOf)).toEqual([
      "2026-07-18",
      "2026-07-11",
    ]);
  });

  it("is empty wherever there is nothing to check against, which makes G8 inert", () => {
    expect(expectedPrereleaseDates("riftbound", SHELF_FRIDAY, { code: "RAD", name: "Radiance" })).toEqual([]);
    expect(expectedPrereleaseDates("magic-the-gathering", null, MTG_MAIN)).toEqual([]);
  });

  it("is empty for a product the schedule does not apply to, so G8 cannot corroborate a prerelease that does not exist", () => {
    expect(
      expectedPrereleaseDates("magic-the-gathering", SHELF_FRIDAY, { code: "TRC", name: "Star Trek Commander", kind: "commander" }),
    ).toEqual([]);
  });
});

describe("which products a schedule applies to", () => {
  // Every case here is a real production row from 2026-09-20 whose derived
  // prerelease was audited against the publisher's own event pages.
  const derives = (game: string, product: PrereleaseProduct) =>
    prereleaseOccurrencesFor(game, SHELF_FRIDAY, product).length > 0;

  it("Magic: only main expansions and core sets -- never Commander decks, Secret Lair, masterpieces or Art Series", () => {
    expect(derives("magic-the-gathering", { code: "FRA", name: "Reality Fracture", kind: "expansion" })).toBe(true);
    expect(derives("magic-the-gathering", { code: "M27", name: "Core Set 2027", kind: "core" })).toBe(true);
    expect(derives("magic-the-gathering", { code: "HOC", name: "The Hobbit Eternal", kind: "commander" })).toBe(false);
    expect(derives("magic-the-gathering", { code: "SDS", name: "Stardates", kind: "masterpiece" })).toBe(false);
    expect(derives("magic-the-gathering", { code: "SLZ", name: "The Zeta Set", kind: "box" })).toBe(false);
    expect(derives("magic-the-gathering", { code: "ASHOB", name: "Art Series: The Hobbit", kind: "memorabilia" })).toBe(false);
  });

  it("Magic: an unclassified product gets nothing -- unknown means no", () => {
    expect(derives("magic-the-gathering", { code: "FRA", name: "Reality Fracture", kind: null })).toBe(false);
    expect(derives("magic-the-gathering", { code: "FRA", name: "Reality Fracture" })).toBe(false);
  });

  it("One Piece: numbered boosters only -- not starter decks, double packs, deck sets or mini-case sets", () => {
    expect(derives("one-piece-tcg", { code: "OP-16", name: "BOOSTER PACK -THE TIME OF BATTLE-" })).toBe(true);
    expect(derives("one-piece-tcg", { code: "OP17", name: "The World's Strongest Warriors" })).toBe(true);
    for (const code of ["ST-31", "ST-36", "DP-12", "SD-01", "TS-03", "EB-05", "OP17 RE"]) {
      expect(derives("one-piece-tcg", { code, name: "anything" }), code).toBe(false);
    }
  });

  it("Pokemon: main expansions only -- not the 30th Celebration, prize packs or collections", () => {
    expect(derives("pokemon-tcg", { code: "PBL", name: "Mega Evolution\u2014Pitch Black" })).toBe(true);
    expect(derives("pokemon-tcg", { code: "DLR", name: "ME06: Mega Evolution\u2014Delta Reign" })).toBe(true);
    expect(derives("pokemon-tcg", { code: "SVI", name: "Scarlet & Violet\u2014Paldea Evolved" })).toBe(true);
    expect(derives("pokemon-tcg", { code: "30C", name: "30th Celebration" })).toBe(false);
    expect(derives("pokemon-tcg", { code: "PPS9", name: "Play! Pok\u00e9mon Prize Pack Series Nine" })).toBe(false);
    expect(derives("pokemon-tcg", { code: "X", name: "ME: 30th Celebration Classic Collection" })).toBe(false);
  });

  it("Yu-Gi-Oh!: core boosters only -- not Winner's Packs, Legendary Decks or Limited Packs", () => {
    for (const [code, name] of [
      ["CORI", "Chaos Origins"],
      ["MAMO", "Magnificent Monsters"],
      ["BETB", "Beyond the Brave"],
      ["MAMS", "Magnificent Maestros"],
    ]) {
      expect(derives("yugioh-tcg", { code, name }), name).toBe(true);
    }
    for (const [code, name] of [
      ["WI26", "Winner's Pack 2026-2027"],
      ["LAVD", "Legendary Arc-V Decks"],
      ["26LP", "Limited Pack World Championship 2026"],
      ["UP02", "Ultimate Tournament Pack 2"],
      ["TYP1", "THANK YOU PACK"],
    ]) {
      expect(derives("yugioh-tcg", { code, name }), name).toBe(false);
    }
  });

  it("Lorcana: numbered sets only -- Illumineer's Quest boxes ship on one date everywhere", () => {
    expect(derives("disney-lorcana", { code: "13", name: "Attack of the Vine!" })).toBe(true);
    expect(derives("disney-lorcana", { code: "Q3", name: "Illumineer's Quest: The Great Hunny Rescue" })).toBe(false);
    expect(derives("disney-lorcana", { code: "SYN-INTOTHEINKDARK-61947583", name: "Into the Inkdark" })).toBe(false);
  });

  it("a missing product gets nothing", () => {
    expect(prereleaseOccurrencesFor("magic-the-gathering", SHELF_FRIDAY, null)).toEqual([]);
  });

  it("every scheduled game declares its own applicability, so a new schedule cannot silently apply to everything", () => {
    for (const [game, schedule] of Object.entries(PRERELEASE_SCHEDULES)) {
      if (schedule.slots.length === 0) continue;
      expect(typeof schedule.appliesTo, `${game} has slots but no appliesTo`).toBe("function");
    }
  });
});

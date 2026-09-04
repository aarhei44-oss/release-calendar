import { describe, expect, it } from "vitest";
import { ParseError } from "@/lib/ingest/normalize";
import { scryfallProvider } from "@/lib/ingest/providers/scryfall";
import { FORWARD_WINDOW_DAYS } from "@/lib/ingest/providers/shared";
import { loadFixture, parseFixture } from "./fixtures/ingest/helpers";

/**
 * scryfall.sets.json is a recording of `https://api.scryfall.com/sets`
 * (1,049 sets on 2026-09-04), trimmed to every set released on or after
 * 2026-01-01 plus up to two examples of each of the 24 `set_type` values, four
 * digital sets, and six sets with no `tcgplayer_id` -- so every branch below
 * runs against rows Scryfall actually sent.
 */
const FETCHED_AT = new Date("2026-09-04T21:00:00Z");
const FIXTURE = loadFixture("scryfall.sets.json");

function parse(value: unknown = FIXTURE, fetchedAt = FETCHED_AT) {
  return parseFixture(scryfallProvider, value, fetchedAt);
}

describe("scryfall provider: shape", () => {
  it("covers Magic only, as a COMMUNITY origin", () => {
    expect(scryfallProvider.games).toEqual(["magic-the-gathering"]);
    expect(scryfallProvider.origin).toBe("scryfall");
    // Not OFFICIAL: ORIGINS declares scryfall as deriving from
    // wizards-official, so treating it as an independent official observation
    // would let one upstream mistake satisfy gate rule G1 unaided.
    expect(scryfallProvider.tier).toBe("COMMUNITY");
  });
});

describe("scryfall provider: the tcgplayer join key", () => {
  it("emits both the scryfall id and the tcgplayer group id", () => {
    const starTrek = parse().find((candidate) => candidate.code === "TRK");
    expect(starTrek?.externalIds).toEqual({
      scryfall: "b47039dc-da5a-448c-8feb-e77d458108a6",
      tcgplayer: "24766",
    });
  });

  it("omits the tcgplayer id rather than inventing one when Scryfall has none", () => {
    const withoutId = parse().filter((candidate) => candidate.externalIds.tcgplayer === undefined);
    expect(withoutId.length).toBeGreaterThan(0);
    for (const candidate of withoutId) {
      expect(candidate.externalIds.scryfall).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it("emits tcgplayer ids in the same string form tcgcsv does", () => {
    // The whole point of the join: identity.ts compares (origin, externalId)
    // strings, so "24766" from here has to be byte-identical to the id tcgcsv
    // emits for the same group.
    for (const candidate of parse()) {
      const id = candidate.externalIds.tcgplayer;
      if (id !== undefined) expect(id).toMatch(/^\d+$/);
    }
  });
});

describe("scryfall provider: field mapping", () => {
  it("maps a set onto a candidate", () => {
    const starTrek = parse().find((candidate) => candidate.code === "TRK");
    expect(starTrek).toMatchObject({
      origin: "scryfall",
      game: "magic-the-gathering",
      name: "Star Trek",
      code: "TRK",
      region: "GLOBAL",
      type: "SHELF",
      date: { kind: "EXACT", date: new Date("2026-11-13T00:00:00Z") },
      url: "https://scryfall.com/sets/trk",
      imageUrl: "https://svgs.scryfall.io/sets/trk.svg?1788148800",
    });
  });
});

describe("scryfall provider: filtering", () => {
  it("drops digital-only sets", () => {
    const fixture = FIXTURE as { data: Array<{ digital: boolean; name: string }> };
    const digitalNames = new Set(fixture.data.filter((set) => set.digital).map((set) => set.name));
    expect(digitalNames.size).toBeGreaterThan(0);
    for (const candidate of parse()) expect(digitalNames.has(candidate.name)).toBe(false);
  });

  it("drops set types that are not standalone releases", () => {
    const fixture = FIXTURE as { data: Array<{ set_type: string; name: string; digital: boolean }> };
    const excludedNames = new Set(
      fixture.data
        .filter((set) => ["token", "memorabilia", "minigame", "alchemy", "treasure_chest", "vanguard"].includes(set.set_type))
        .map((set) => set.name),
    );
    expect(excludedNames.size).toBeGreaterThan(0);
    for (const candidate of parse()) expect(excludedNames.has(candidate.name)).toBe(false);
  });

  it("keeps expansions, commander decks and promos", () => {
    const kept = parse().map((candidate) => candidate.name);
    expect(kept).toContain("Star Trek");
    expect(kept).toContain("Star Trek Commander");
  });
});

describe("scryfall provider: the forward window", () => {
  it("drops sets released more than the window ago", () => {
    const cutoff = FETCHED_AT.getTime() - FORWARD_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    const candidates = parse();
    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      expect(candidate.date.kind).toBe("EXACT");
      if (candidate.date.kind !== "EXACT") continue;
      expect(candidate.date.date.getTime()).toBeGreaterThanOrEqual(cutoff);
    }
  });

  it("keeps a genuinely future set", () => {
    const starTrek = parse().find((candidate) => candidate.code === "TRK");
    expect(starTrek).toBeDefined();
    expect(starTrek?.date).toEqual({ kind: "EXACT", date: new Date("2026-11-13T00:00:00Z") });
  });

  it("keeps a set with no released_at as TBD", () => {
    const value = {
      object: "list",
      data: [{ id: "abc", code: "und", name: "Undated Set", set_type: "expansion", digital: false, released_at: null }],
    };
    expect(parse(value)).toEqual([expect.objectContaining({ name: "Undated Set", date: { kind: "TBD" } })]);
  });
});

describe("scryfall provider: malformed payloads", () => {
  it("throws ParseError when data is missing", () => {
    expect(() => parse({ object: "list" })).toThrow(ParseError);
  });

  it("throws ParseError when a set loses its id", () => {
    const value = { object: "list", data: [{ code: "trk", name: "Star Trek", set_type: "expansion", digital: false }] };
    expect(() => parse(value)).toThrow(ParseError);
  });

  it("throws ParseError on an unreadable released_at", () => {
    const value = {
      object: "list",
      data: [{ id: "a", code: "trk", name: "Star Trek", set_type: "expansion", digital: false, released_at: "later" }],
    };
    expect(() => parse(value)).toThrow(/unparseable date/);
  });
});

import { describe, expect, it } from "vitest";
import { ParseError } from "@/lib/ingest/normalize";
import { FORWARD_WINDOW_DAYS } from "@/lib/ingest/providers/shared";
import { ygoprodeckProvider } from "@/lib/ingest/providers/ygoprodeck";
import { loadFixture, parseFixture } from "./fixtures/ingest/helpers";

/**
 * ygoprodeck.cardsets.json is a recording of
 * `https://db.ygoprodeck.com/api/v7/cardsets.php` (1,035 sets on 2026-09-04),
 * trimmed to everything dated 2026 or later, all four rows that carry no
 * `tcg_date` at all, three families of sets that share a `set_code`, and eight
 * historical rows.
 */
const FETCHED_AT = new Date("2026-09-04T21:00:00Z");
const FIXTURE = loadFixture("ygoprodeck.cardsets.json");

function parse(value: unknown = FIXTURE, fetchedAt = FETCHED_AT) {
  return parseFixture(ygoprodeckProvider, value, fetchedAt);
}

describe("ygoprodeck provider: shape", () => {
  it("covers Yu-Gi-Oh only, as a COMMUNITY origin", () => {
    expect(ygoprodeckProvider.games).toEqual(["yugioh-tcg"]);
    expect(ygoprodeckProvider.origin).toBe("ygoprodeck");
    expect(ygoprodeckProvider.tier).toBe("COMMUNITY");
  });
});

describe("ygoprodeck provider: field mapping", () => {
  it("maps a set onto a candidate", () => {
    const beyondTheBrave = parse().find((candidate) => candidate.code === "BETB");
    expect(beyondTheBrave).toMatchObject({
      origin: "ygoprodeck",
      game: "yugioh-tcg",
      name: "Beyond the Brave",
      code: "BETB",
      region: "GLOBAL",
      type: "SHELF",
      date: { kind: "EXACT", date: new Date("2026-10-08T00:00:00Z") },
      imageUrl: "https://images.ygoprodeck.com/images/sets/BETB.jpg",
    });
  });

  it("omits imageUrl for a set with no set_image rather than emitting an empty string", () => {
    const noImage = parse().find((candidate) => candidate.name === "Crocs collaboration card");
    expect(noImage).toBeDefined();
    expect(noImage?.imageUrl).toBeUndefined();
  });
});

describe("ygoprodeck provider: external ids", () => {
  it("pairs the set code with the set name, because set_code alone is not unique", () => {
    const beyondTheBrave = parse().find((candidate) => candidate.code === "BETB");
    expect(beyondTheBrave?.externalIds).toEqual({ ygoprodeck: "BETB:Beyond the Brave" });
  });

  it("gives sets that share a set_code distinct identities", () => {
    // YS15 is three different 2015 starter decks upstream. Keying identity on
    // the bare code would fuse them onto one ProductSet -- the one identity
    // error no later pass can undo.
    const value = [
      { set_name: "2-Player Starter Deck: Yuya & Declan", set_code: "YS15", tcg_date: "2026-08-01" },
      { set_name: "Dark Legion Starter Deck", set_code: "YS15", tcg_date: "2026-08-02" },
      { set_name: "Saber Force Starter Deck", set_code: "YS15", tcg_date: "2026-08-03" },
    ];
    const ids = parse(value).map((candidate) => candidate.externalIds.ygoprodeck);
    expect(new Set(ids).size).toBe(3);
    expect(ids).toContain("YS15:Dark Legion Starter Deck");
    // The bare code still travels as the candidate's code.
    expect(parse(value).every((candidate) => candidate.code === "YS15")).toBe(true);
  });
});

describe("ygoprodeck provider: the forward window", () => {
  it("drops sets released more than the window ago and keeps future ones", () => {
    const cutoff = FETCHED_AT.getTime() - FORWARD_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    const candidates = parse();

    for (const candidate of candidates) {
      if (candidate.date.kind === "TBD") continue;
      expect(candidate.date.kind).toBe("EXACT");
      if (candidate.date.kind !== "EXACT") continue;
      expect(candidate.date.date.getTime()).toBeGreaterThanOrEqual(cutoff);
    }

    expect(candidates.some((candidate) => candidate.name === "2-Player Starter Set")).toBe(false);
    expect(candidates.some((candidate) => candidate.name === "Magnificent Maestros")).toBe(true);
  });

  it("keeps every set with no tcg_date as a TBD candidate", () => {
    const fixture = FIXTURE as Array<{ set_name: string; tcg_date?: string | null }>;
    const undated = fixture.filter((set) => !set.tcg_date).map((set) => set.set_name);
    expect(undated.length).toBe(4);

    const candidates = parse();
    for (const name of undated) {
      const candidate = candidates.find((entry) => entry.name === name);
      expect(candidate, `${name} should survive as TBD`).toBeDefined();
      expect(candidate?.date).toEqual({ kind: "TBD" });
    }
  });
});

describe("ygoprodeck provider: malformed payloads", () => {
  it("throws ParseError when the payload is not an array", () => {
    expect(() => parse({ data: [] })).toThrow(ParseError);
  });

  it("throws ParseError when a set loses its name", () => {
    expect(() => parse([{ set_code: "BETB", tcg_date: "2026-10-08" }])).toThrow(ParseError);
  });

  it("throws ParseError on an unreadable tcg_date", () => {
    expect(() => parse([{ set_name: "Set", set_code: "SET", tcg_date: "sometime in Q4" }])).toThrow(
      /unparseable date/,
    );
  });
});

import { describe, expect, it } from "vitest";
import { ParseError } from "@/lib/ingest/normalize";
import { FORWARD_WINDOW_DAYS } from "@/lib/ingest/providers/shared";
import { WIKIPEDIA_PAGES, wikipediaProvider } from "@/lib/ingest/providers/wikipedia";
import { loadFixture, parseFixture } from "./fixtures/ingest/helpers";

/**
 * wikipedia.pages.json is a recording of four `action=parse&prop=text`
 * responses from en.wikipedia.org, captured on 2026-09-04: the Pokémon TCG set
 * list, the Magic set list, Disney Lorcana and Riftbound.
 *
 * The prose is trimmed and only the articles' `<table>` elements are kept --
 * the parser never looks anywhere else, and the Magic article alone is 968 KB
 * of HTML. Two non-matching tables per page (navboxes, infoboxes) are kept as
 * decoys, so "the parser ignores tables it was not asked for" is exercised
 * rather than assumed.
 */
const FETCHED_AT = new Date("2026-09-04T21:00:00Z");
const FIXTURE = loadFixture("wikipedia.pages.json");

function parse(value: unknown = FIXTURE, fetchedAt = FETCHED_AT) {
  return parseFixture(wikipediaProvider, value, fetchedAt);
}

describe("wikipedia provider: shape", () => {
  it("covers four games as an independent COMMUNITY origin", () => {
    expect(wikipediaProvider.games.sort()).toEqual(
      ["disney-lorcana", "magic-the-gathering", "pokemon-tcg", "riftbound"].sort(),
    );
    expect(wikipediaProvider.origin).toBe("wikipedia");
    expect(wikipediaProvider.tier).toBe("COMMUNITY");
  });

  it("addresses the API, never the rendered page", () => {
    for (const page of WIKIPEDIA_PAGES) {
      expect(page.apiUrl).toBe("https://en.wikipedia.org/w/api.php");
    }
  });
});

describe("wikipedia provider: field mapping", () => {
  it("reads a Riftbound row", () => {
    const radiance = parse().find((candidate) => candidate.name === "Radiance");
    expect(radiance).toMatchObject({
      origin: "wikipedia",
      game: "riftbound",
      code: "RAD",
      region: "GLOBAL",
      type: "SHELF",
      date: { kind: "EXACT", date: new Date("2026-10-23T00:00:00Z") },
      url: "https://en.wikipedia.org/wiki/Riftbound",
      externalIds: { wikipedia: "wp-riftbound:RAD" },
    });
  });

  it("reads a Magic row and strips its footnote markers", () => {
    const realityFracture = parse().find(
      (candidate) => candidate.game === "magic-the-gathering" && candidate.code === "FRA",
    );
    // The live cell text is "Reality Fracture" followed by <sup> citations; a
    // parser that kept them would produce "Reality Fracture[281]".
    expect(realityFracture?.name).toBe("Reality Fracture");
    expect(realityFracture?.date).toEqual({ kind: "EXACT", date: new Date("2026-10-02T00:00:00Z") });
  });

  it("reads a quarter window", () => {
    const hyperia = parse().find(
      (candidate) => candidate.name === "Hyperia City" && candidate.type === "SHELF",
    );
    // The Lorcana table gives "Q4 2026" for this set, with no day of its own.
    expect(hyperia?.date).toEqual({
      kind: "WINDOW",
      granularity: "QUARTER",
      start: new Date("2026-10-01T00:00:00Z"),
      end: new Date("2026-12-31T00:00:00Z"),
    });
  });

  it("emits a separate PRERELEASE candidate from the prerelease column", () => {
    const attackOfTheVine = parse().filter((candidate) => candidate.name === "Attack Of The Vine");
    expect(attackOfTheVine.map((candidate) => candidate.type).sort()).toEqual(["PRERELEASE", "SHELF"]);
    const prerelease = attackOfTheVine.find((candidate) => candidate.type === "PRERELEASE");
    const shelf = attackOfTheVine.find((candidate) => candidate.type === "SHELF");
    // The LGS window opens a week before the street date; they are two events
    // for one product, not two claims about one event.
    expect(prerelease?.date).toEqual({ kind: "EXACT", date: new Date("2026-07-17T00:00:00Z") });
    expect(shelf?.date).toEqual({ kind: "EXACT", date: new Date("2026-07-24T00:00:00Z") });
  });
});

describe("wikipedia provider: identity hygiene", () => {
  it("never lets a placeholder code become an identity key", () => {
    // The Magic list carries the literal code "TBA" on every announced-but-
    // unnamed slot -- five at once in this recording. Keyed on that, five
    // different products would collapse onto one ProductSet.
    for (const candidate of parse()) {
      expect(candidate.code).not.toBe("TBA");
      expect(candidate.externalIds.wikipedia).not.toMatch(/:TBA$/);
    }
  });

  it("ignores section banner rows spanning the whole table", () => {
    // "Mirage Block", "Commander" and friends are single colspan cells; read
    // positionally they look like a set name and a release date at once.
    const names = parse().map((candidate) => candidate.name);
    expect(names).not.toContain("Mirage Block");
    expect(names).not.toContain("Commander");
    expect(names).not.toContain("Duel Decks");
  });

  it("recovers rows whose trailing empty cells the article omits", () => {
    // Riftbound's table declares seven columns but writes six cells for its
    // unreleased sets. A positional reader drops them; the grid keeps them.
    const names = parse().map((candidate) => candidate.name);
    expect(names).toContain("The Reckoning");
    expect(names).toContain("Set 8");
  });

  it("ignores navboxes and infoboxes", () => {
    const games = new Set(parse().map((candidate) => candidate.game));
    expect(games).toEqual(new Set(["pokemon-tcg", "magic-the-gathering", "disney-lorcana", "riftbound"]));
    for (const candidate of parse()) {
      expect(candidate.name.length).toBeLessThan(120);
    }
  });
});

describe("wikipedia provider: the forward window", () => {
  it("drops the decades of historical rows these articles are mostly made of", () => {
    const cutoff = FETCHED_AT.getTime() - FORWARD_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    const candidates = parse();
    // The Magic article alone lists 400+ sets going back to 1993.
    expect(candidates.length).toBeLessThan(60);
    for (const candidate of candidates) {
      if (candidate.date.kind === "TBD") continue;
      const anchor = candidate.date.kind === "EXACT" ? candidate.date.date : candidate.date.start;
      expect(anchor.getTime()).toBeGreaterThanOrEqual(cutoff);
    }
  });

  it("keeps genuinely future sets", () => {
    const names = parse().map((candidate) => candidate.name);
    expect(names).toContain("Legacy"); // Riftbound, 2027-01-29
    expect(names).toContain("Kamigawa: Titanbreach"); // Magic, 2027-06-04
  });

  it("keeps an undated but genuinely named announced set as TBD", () => {
    // "Kaladesh: The Gift Box" has a real name and no date at all. Undated is
    // not the same as unidentified: the forward window deliberately passes a
    // TBD through (an announced-but-undated product is often the most
    // interesting row on the page), and a real name is enough to resolve it and
    // to show it. Only rows whose *name* says nothing are refused.
    const undated = parse().filter((candidate) => candidate.name === "Kaladesh: The Gift Box");
    expect(undated.length).toBeGreaterThan(0);
    expect(undated[0].date).toEqual({ kind: "TBD" });
  });

  it("refuses the three placeholder-named Magic rows outright", () => {
    // Three separate rows on the Magic list read "Unnamed Universes Beyond Set"
    // with "TBA" in every other column. They are three different products, and
    // nothing on the page distinguishes them -- so they must not be emitted
    // (see mediawiki.ts's placeholder-name refusal), and the three-way false
    // merge they used to produce is asserted gone in
    // ingestIdentityFixtures.test.ts.
    expect(parse().map((candidate) => candidate.name)).not.toContain("Unnamed Universes Beyond Set");
  });
});

describe("wikipedia provider: malformed payloads", () => {
  it("throws ParseError when the payload is not a page map", () => {
    expect(() => parse({ "wp-riftbound": 42 })).toThrow(ParseError);
  });

  it("throws ParseError rather than yielding nothing when every table has changed shape", () => {
    // A silent zero is the failure that makes a provider look healthy while
    // contributing no evidence at all; the payload is on disk either way, so
    // failing loudly costs one run and buys a replayable diagnosis.
    const value = Object.fromEntries(
      WIKIPEDIA_PAGES.map((page) => [page.key, "<table><tr><th>Widget</th><th>Colour</th></tr></table>"]),
    );
    expect(() => parse(value)).toThrow(/no set tables matched/);
  });
});

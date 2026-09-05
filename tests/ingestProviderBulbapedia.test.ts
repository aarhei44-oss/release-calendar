import { describe, expect, it } from "vitest";
import { BULBAPEDIA_PAGES, bulbapediaProvider } from "@/lib/ingest/providers/bulbapedia";
import { ParseError } from "@/lib/ingest/normalize";
import { FORWARD_WINDOW_DAYS } from "@/lib/ingest/providers/shared";
import { ORIGINS, originsAreIndependent } from "@/lib/ingest/types";
import { loadFixture, parseFixture } from "./fixtures/ingest/helpers";

/**
 * bulbapedia.pages.json is a recording of two `action=parse` responses from
 * bulbapedia.bulbagarden.net, captured on 2026-09-04:
 *
 *   bp-en-expansions  "List of Pokémon Trading Card Game expansions",
 *                     reduced to the article's tables (21 of them, one per era,
 *                     plus decoys);
 *   bp-jp-expansions  "List of Japanese Pokémon Trading Card Game expansions",
 *                     reduced to the 17 era tables that carry a row dated 2022
 *                     or later -- enough recent history for the forward-window
 *                     filter to have something to reject, without carrying the
 *                     other 1996-2021 tables' 300KB into the repository.
 *
 * This provider exists to give Pokémon a second independent origin: before it,
 * the game had only tcgcsv, and gate rule G2 could never fire for a Pokémon
 * set at all. The Japanese page joined it in phase 4, once region became part
 * of the event key.
 */
const FETCHED_AT = new Date("2026-09-04T21:00:00Z");
const FIXTURE = loadFixture("bulbapedia.pages.json");

function parse(value: unknown = FIXTURE, fetchedAt = FETCHED_AT) {
  return parseFixture(bulbapediaProvider, value, fetchedAt);
}

describe("bulbapedia provider: shape", () => {
  it("covers Pokémon only, via the MediaWiki API", () => {
    expect(bulbapediaProvider.games).toEqual(["pokemon-tcg"]);
    expect(bulbapediaProvider.origin).toBe("bulbapedia");
    expect(bulbapediaProvider.tier).toBe("COMMUNITY");
    expect(BULBAPEDIA_PAGES[0].apiUrl).toBe("https://bulbapedia.bulbagarden.net/w/api.php");
  });

  it("fetches one global page and one Japanese one", () => {
    expect(BULBAPEDIA_PAGES.map((page) => [page.key, page.region])).toEqual([
      ["bp-en-expansions", "GLOBAL"],
      ["bp-jp-expansions", "JP"],
    ]);
  });

  it("is independent of Wikipedia, which is the whole point of registering both", () => {
    expect(originsAreIndependent("bulbapedia", "wikipedia", ORIGINS)).toBe(true);
    expect(originsAreIndependent("bulbapedia", "tcgplayer", ORIGINS)).toBe(true);
    // ...but not of the publisher it transcribes.
    expect(originsAreIndependent("bulbapedia", "pokemon-official", ORIGINS)).toBe(false);
  });
});

describe("bulbapedia provider: field mapping", () => {
  it("reads an expansion row, pinning the name column past 'Set no.'", () => {
    const deltaReign = parse().find((candidate) => candidate.code === "DLR");
    expect(deltaReign).toMatchObject({
      origin: "bulbapedia",
      game: "pokemon-tcg",
      name: "Mega Evolution—Delta Reign",
      code: "DLR",
      region: "GLOBAL",
      type: "SHELF",
      date: { kind: "EXACT", date: new Date("2026-11-06T00:00:00Z") },
      externalIds: { bulbapedia: "bp-en-expansions:DLR" },
    });
  });

  it("agrees with tcgcsv on the date of the same set", () => {
    // tcgcsv lists group 24831 "ME06: Delta Reign" on 2026-11-06. Two
    // independent origins stating one date is exactly what gate rule G2 is
    // for, and it is the reason this provider was built.
    const deltaReign = parse().find((candidate) => candidate.code === "DLR");
    expect(deltaReign?.date).toEqual({ kind: "EXACT", date: new Date("2026-11-06T00:00:00Z") });
  });
});

describe("bulbapedia provider: the Japanese expansion list", () => {
  it("reads a Japanese row under its English name, dated the Japanese street date", () => {
    // Bulbapedia's Japanese list calls this set ストームエメラルダ / "Storm
    // Emeralda" and names its English equivalent in its own column. The English
    // name is what the candidate carries: it is what the rest of the catalogue
    // calls the product, and what a reader of an English calendar can act on.
    const jp = parse().find((candidate) => candidate.region === "JP" && candidate.name === "Delta Reign");
    expect(jp).toMatchObject({
      origin: "bulbapedia",
      game: "pokemon-tcg",
      region: "JP",
      type: "SHELF",
      // 98 days ahead of the global date asserted above -- the exact gap that
      // used to make this one G5 conflict instead of two events.
      date: { kind: "EXACT", date: new Date("2026-07-31T00:00:00Z") },
    });
  });

  it("carries the wiki article both lists link, which is what joins them", () => {
    // Not the page-scoped id (those are necessarily different) and not the name
    // (0.667 similarity, under the threshold) and not the code (the Japanese
    // list has no code column). The article path is a fact the wiki publishes
    // about its own catalogue, so it resolves at identity.ts's id tier.
    const global = parse().find((candidate) => candidate.code === "DLR");
    const jp = parse().find((candidate) => candidate.region === "JP" && candidate.name === "Delta Reign");
    expect(global?.externalIds["bulbapedia-article"]).toBe("Delta_Reign_(TCG)");
    expect(jp?.externalIds["bulbapedia-article"]).toBe("Delta_Reign_(TCG)");
    expect(jp?.externalIds.bulbapedia).not.toBe(global?.externalIds.bulbapedia);
  });

  it("does not let a set symbol's File: link stand in for the product", () => {
    // Every row's symbol and logo columns link a File: page, and a namespaced
    // page is not a product -- a link column pointed at one would hand every row
    // on the page the same identity.
    for (const candidate of parse()) {
      const article = candidate.externalIds["bulbapedia-article"];
      if (article) expect(article).not.toMatch(/^File:/i);
    }
  });

  it("emits nothing for a Japanese row with no announced English equivalent", () => {
    // Those rows read "TBA" in the only column that could identify them, so
    // several of them would share one identity. Dropped, on the same reasoning
    // as Wikipedia's "Unnamed Universes Beyond Set".
    const value = {
      "bp-jp-expansions":
        "<table><tr><th>Set no.</th><th>Japanese name<br>Translated name</th><th>English equivalent</th><th>Release date</th></tr>" +
        "<tr><td>7</td><td>???</td><td>TBA</td><td>December 5, 2026</td></tr>" +
        "<tr><td>8</td><td>???</td><td>TBA</td><td>February 6, 2027</td></tr></table>",
    };
    expect(() => parse(value)).toThrow(/no set tables matched/);
  });
});

describe("bulbapedia provider: the forward window", () => {
  it("drops thirty years of expansion history", () => {
    const cutoff = FETCHED_AT.getTime() - FORWARD_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    const candidates = parse();
    // The article lists every English expansion since 1999 -- some 170 rows.
    expect(candidates.length).toBeLessThan(20);
    for (const candidate of candidates) {
      if (candidate.date.kind === "TBD") continue;
      const anchor = candidate.date.kind === "EXACT" ? candidate.date.date : candidate.date.start;
      expect(anchor.getTime()).toBeGreaterThanOrEqual(cutoff);
    }
  });

  it("keeps a genuinely future expansion", () => {
    expect(parse().map((candidate) => candidate.name)).toContain("Mega Evolution—Delta Reign");
  });

  it("reads an open-ended promo series as a range so it falls out of the window", () => {
    // The promo tables give "July 1999 – March 2003" and "January 2023 –
    // Present". Left unparsed these would be TBD, which the window never
    // filters, and ten discontinued promo lines would take up permanent
    // residence on the calendar as dateless rumours.
    const names = parse().map((candidate) => candidate.name);
    expect(names).not.toContain("Wizards Black Star Promos");
    expect(names).not.toContain("SVP Black Star Promos");
  });

  it("keeps an expansion with an empty date cell as TBD", () => {
    const value = {
      "bp-en-expansions":
        "<table><tr><th>Set no.</th><th>Name of Expansion</th><th>Release date</th><th>Set abb.</th></tr>" +
        "<tr><td>99</td><td>Future Expansion</td><td></td><td>FUT</td></tr></table>",
    };
    expect(parse(value)).toEqual([
      expect.objectContaining({ name: "Future Expansion", code: "FUT", date: { kind: "TBD" } }),
    ]);
  });
});

describe("bulbapedia provider: malformed payloads", () => {
  it("throws ParseError when the payload is not a page map", () => {
    expect(() => parse({ "bp-en-expansions": { html: "..." } })).toThrow(ParseError);
  });

  it("throws ParseError when the expansion tables have changed shape", () => {
    expect(() => parse({ "bp-en-expansions": "<table><tr><th>Widget</th><th>Colour</th></tr></table>" })).toThrow(
      /no set tables matched/,
    );
  });

  it("names the provider on failure", () => {
    try {
      parse({ "bp-en-expansions": "<p>no tables at all</p>" });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ParseError);
      expect((error as ParseError).providerKey).toBe("bulbapedia");
    }
  });
});

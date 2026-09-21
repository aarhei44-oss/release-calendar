import { describe, expect, it } from "vitest";
import { ParseError } from "@/lib/ingest/normalize";
import { playriftboundProvider } from "@/lib/ingest/providers/playriftbound";
import { ORIGINS, originsAreIndependent, type Candidate } from "@/lib/ingest/types";
import { byName, loadFixture, parseFixture } from "./fixtures/ingest/helpers";

/**
 * playriftbound.pages.json is a trimmed recording of
 * playriftbound.com/en-us/news/announcements/ and one linked article,
 * captured 2026-09-05.
 *
 * This is Riftbound's first OFFICIAL-tier origin, and the only one that
 * carries a "Pre-Rift" date at all -- see the provenance note at the top of
 * playriftbound.ts for why tcgcsv, wikipedia and (deliberately) riftbound.gg
 * don't.
 */

const FETCHED_AT = new Date("2026-09-05T12:00:00.000Z");
const FIXTURE = loadFixture<{ index: string; articles: Record<string, string> }>("playriftbound.pages.json");

function parse(value: unknown = FIXTURE, fetchedAt = FETCHED_AT): Candidate[] {
  return parseFixture(playriftboundProvider, value, fetchedAt);
}

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

describe("playriftbound provider: shape", () => {
  it("speaks for Riot, at OFFICIAL tier", () => {
    expect(playriftboundProvider.origin).toBe("riot-official");
    expect(playriftboundProvider.tier).toBe("OFFICIAL");
    expect(ORIGINS["riot-official"].tier).toBe("OFFICIAL");
    expect(ORIGINS["riot-official"].derivesFrom).toBeNull();
  });

  it("is independent of the retailer and the wiki, so Riftbound gains a real second and third opinion", () => {
    expect(originsAreIndependent("riot-official", "tcgplayer", ORIGINS)).toBe(true);
    expect(originsAreIndependent("riot-official", "wikipedia", ORIGINS)).toBe(true);
  });

  it("covers only Riftbound", () => {
    expect(playriftboundProvider.games).toEqual(["riftbound"]);
  });
});

// ---------------------------------------------------------------------------
// Field mapping
// ---------------------------------------------------------------------------

describe("playriftbound provider: field mapping", () => {
  it("reads a set's shelf date, code and region from its info list", () => {
    const shelf = parse().find((c) => c.name === "Radiance" && c.type === "SHELF");
    expect(shelf).toMatchObject({
      origin: "riot-official",
      game: "riftbound",
      name: "Radiance",
      code: "RAD",
      region: "GLOBAL",
      type: "SHELF",
      date: { kind: "EXACT", date: new Date("2026-10-23T00:00:00Z") },
    });
    expect(shelf?.externalIds).toEqual({ "riot-official": "products-and-sets-into-2027:radiance" });
  });

  it("reads the Pre-Rift window as a RANGE, rewriting Riot's unspaced day range first", () => {
    const prerelease = parse().find((c) => c.name === "Radiance" && c.type === "PRERELEASE");
    expect(prerelease?.date).toEqual({
      kind: "RANGE",
      start: new Date("2026-10-16T00:00:00Z"),
      end: new Date("2026-10-22T00:00:00Z"),
    });
  });

  it("reads Pre-Rift and Release the same way whether or not Riot bolds the label", () => {
    // Radiance's and Legacy's list items read "<strong>Pre-Rift</strong>: ...";
    // The Reckoning's read "Pre-Rift: ..." with no bolding at all. Both must
    // parse identically, since flattened text erases the difference.
    const reckoningShelf = parse().find((c) => c.name === "The Reckoning" && c.type === "SHELF");
    const reckoningPrerelease = parse().find((c) => c.name === "The Reckoning" && c.type === "PRERELEASE");
    expect(reckoningShelf?.date).toEqual({ kind: "EXACT", date: new Date("2027-04-30T00:00:00Z") });
    expect(reckoningPrerelease?.date).toEqual({
      kind: "RANGE",
      start: new Date("2027-04-23T00:00:00Z"),
      end: new Date("2027-04-29T00:00:00Z"),
    });
    expect(reckoningShelf?.code).toBe("REC");
  });

  it("ignores h2 headings that are not a numbered, named set", () => {
    // "Secret Garden" is a real product but not a numbered set; "Set 8" and
    // "Set 9" are numbered sets with no name locked yet (Riot's own way of
    // saying "nothing to identify here"), same as a wiki's "TBA" row.
    for (const name of ["Secret Garden", "Set 8", "Set 9"]) {
      expect(byName(parse(), name)).toBeUndefined();
    }
  });

  it("yields nothing from an article with no set section, without erroring", () => {
    const fromKoreaArticle = parse().filter((c) => c.externalIds["riot-official"]?.startsWith("koreas-rift"));
    expect(fromKoreaArticle).toEqual([]);
  });

  it("carries the article URL onto every candidate from it", () => {
    for (const candidate of parse()) {
      expect(candidate.url).toBe("https://playriftbound.com/en-us/news/announcements/products-and-sets-into-2027/");
    }
  });
});

// ---------------------------------------------------------------------------
// Forward window
// ---------------------------------------------------------------------------

describe("playriftbound provider: forward window", () => {
  it("drops a set dated more than 90 days in the past", () => {
    const staleArticle = `<html><body><article><h2>Set 2: Spiritforged</h2><ul>
      <li><strong>3-Letter Code</strong>: SFD</li>
      <li class="ck-list-marker-bold"><strong>Dates</strong><ul>
        <li><strong>Pre-Rift</strong>: February 6-12, 2026</li>
        <li><strong>Release</strong>: February 13, 2026</li>
      </ul></li>
    </ul></article></body></html>`;
    const candidates = parse({ index: FIXTURE.index, articles: { "old-news": staleArticle } });
    expect(candidates).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Drift
// ---------------------------------------------------------------------------

describe("playriftbound provider: a page redesign fails loudly", () => {
  it("raises ParseError when the index yields no article links at all", () => {
    const candidates = () => parse({ index: "<html><body><p>hello</p></body></html>", articles: {} });
    expect(candidates).toThrow(ParseError);
  });

  it("names the provider and the field on the index-drift error", () => {
    try {
      parse({ index: "<html></html>", articles: {} });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ParseError);
      expect((error as ParseError).providerKey).toBe("playriftbound");
      expect((error as ParseError).path).toBe("index");
    }
  });

  it("rejects a payload that is not the {index, articles} shape", () => {
    expect(() => parse({ index: "<html></html>" })).toThrow(ParseError);
    expect(() => parse({ index: 42, articles: {} })).toThrow(ParseError);
  });

  it("tolerates an article missing from a replayed payload without inventing drift", () => {
    const partial = { index: FIXTURE.index, articles: {} };
    expect(parse(partial)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// A second product's info list inside a set's section
// ---------------------------------------------------------------------------

describe("playriftbound provider: a product listed under a set does not become the set", () => {
  // Riot's live article puts "Proving Grounds, 2nd Edition" in an <h3> *inside*
  // "Set 6: Legacy"'s section, with its own info list: code PG2, Release
  // February 19, 2027. The fixture predates it, so it is spliced in here in the
  // exact shape of the live page (verified 2026-09-20).
  const PROVING_GROUNDS =
    "<h3>Proving Grounds, 2nd Edition</h3><ul><li>3-Letter Code: PG2</li><li>Languages: EN, CN, FR, KR</li>" +
    '<li>Dates<ul><li>Release: February 19, 2027</li></ul></li><li>Price: $40</li></ul>';

  function withProvingGrounds(): typeof FIXTURE {
    const article = FIXTURE.articles["products-and-sets-into-2027"];
    const marker = "<h2>Set 7: The Reckoning</h2>";
    expect(article).toContain(marker);
    return {
      ...FIXTURE,
      articles: {
        ...FIXTURE.articles,
        "products-and-sets-into-2027": article.replace(marker, `${PROVING_GROUNDS}${marker}`),
      },
    };
  }

  it("keeps Legacy's own release date, not the Proving Grounds date that follows it", () => {
    const legacy = parse(withProvingGrounds()).find((c) => c.name === "Legacy" && c.type === "SHELF");
    expect(legacy?.date).toEqual({ kind: "EXACT", date: new Date("2027-01-29T00:00:00Z") });
  });

  it("keeps Legacy's own code, not PG2", () => {
    const legacy = parse(withProvingGrounds()).filter((c) => c.name === "Legacy");
    expect(legacy.length).toBeGreaterThan(0);
    for (const candidate of legacy) expect(candidate.code).toBe("LGC");
  });

  it("keeps Legacy's Pre-Rift window", () => {
    const prerelease = parse(withProvingGrounds()).find((c) => c.name === "Legacy" && c.type === "PRERELEASE");
    expect(prerelease?.date).toEqual({
      kind: "RANGE",
      start: new Date("2027-01-22T00:00:00Z"),
      end: new Date("2027-01-28T00:00:00Z"),
    });
  });

  it("does not disturb the sets around it", () => {
    const candidates = parse(withProvingGrounds());
    const reckoning = candidates.find((c) => c.name === "The Reckoning" && c.type === "SHELF");
    expect(reckoning?.date).toEqual({ kind: "EXACT", date: new Date("2027-04-30T00:00:00Z") });
    expect(candidates.find((c) => c.name === "Radiance" && c.type === "SHELF")?.date).toEqual({
      kind: "EXACT",
      date: new Date("2026-10-23T00:00:00Z"),
    });
  });

  it("takes the first of two Release lines when a section repeats the label with no code between", () => {
    const article = FIXTURE.articles["products-and-sets-into-2027"];
    const marker = "<h2>Set 7: The Reckoning</h2>";
    const doubled = article.replace(marker, `<ul><li>Release: March 1, 2027</li></ul>${marker}`);
    const legacy = parse({
      ...FIXTURE,
      articles: { ...FIXTURE.articles, "products-and-sets-into-2027": doubled },
    }).find((c) => c.name === "Legacy" && c.type === "SHELF");
    expect(legacy?.date).toEqual({ kind: "EXACT", date: new Date("2027-01-29T00:00:00Z") });
  });
});

import { describe, expect, it } from "vitest";
import { ParseError } from "@/lib/ingest/normalize";
import { FORWARD_WINDOW_DAYS } from "@/lib/ingest/providers/shared";
import { TCGCSV_CATEGORIES, tcgcsvProvider } from "@/lib/ingest/providers/tcgcsv";
import { loadFixture, parseFixture } from "./fixtures/ingest/helpers";

/**
 * tcgcsv.groups.json is a recording of the eight live
 * `https://tcgcsv.com/tcgplayer/{categoryId}/groups` responses, captured on
 * 2026-09-04 (categoryId 81, Union Arena, on 2026-09-05) and trimmed to every
 * group published on or after 2026-01-01 plus the six most recent older ones
 * per category -- so both sides of the forward window are real rows rather
 * than hand-written ones.
 *
 * `FETCHED_AT` is the recording's own timestamp, which is what the forward
 * window is measured against.
 */
const FETCHED_AT = new Date("2026-09-04T21:00:00Z");
const FIXTURE = loadFixture("tcgcsv.groups.json");

function parse(value: unknown = FIXTURE, fetchedAt = FETCHED_AT) {
  return parseFixture(tcgcsvProvider, value, fetchedAt);
}

describe("tcgcsv provider: shape", () => {
  it("declares all eight games", () => {
    expect(tcgcsvProvider.games.sort()).toEqual(
      [
        "disney-lorcana",
        "gundam-card-game",
        "magic-the-gathering",
        "one-piece-tcg",
        "pokemon-tcg",
        "riftbound",
        "union-arena-tcg",
        "yugioh-tcg",
      ].sort(),
    );
    expect(tcgcsvProvider.origin).toBe("tcgplayer");
    expect(tcgcsvProvider.tier).toBe("RETAILER");
  });

  it("yields candidates for every category in the fixture", () => {
    const games = new Set(parse().map((candidate) => candidate.game));
    for (const { game } of TCGCSV_CATEGORIES) expect(games).toContain(game);
  });
});

describe("tcgcsv provider: field mapping", () => {
  it("maps a group onto a candidate", () => {
    const deltaReign = parse().find((candidate) => candidate.externalIds.tcgplayer === "24831");
    expect(deltaReign).toBeDefined();
    expect(deltaReign).toMatchObject({
      origin: "tcgplayer",
      game: "pokemon-tcg",
      name: "ME06: Delta Reign",
      code: "DLR",
      region: "GLOBAL",
      type: "SHELF",
      date: { kind: "EXACT", date: new Date("2026-11-06T00:00:00Z") },
    });
  });

  it("reads publishedOn as a UTC calendar date, not a local one", () => {
    // tcgcsv sends "2026-11-06T00:00:00" with no zone. Parsed locally on a
    // machine east of UTC this becomes the 5th, which would silently shift the
    // whole calendar by a day depending on where the server runs.
    const deltaReign = parse().find((candidate) => candidate.externalIds.tcgplayer === "24831");
    const date = deltaReign?.date;
    expect(date?.kind).toBe("EXACT");
    expect(date?.kind === "EXACT" && date.date.toISOString()).toBe("2026-11-06T00:00:00.000Z");
  });

  it("emits the groupId as the tcgplayer external id and nothing else", () => {
    for (const candidate of parse()) {
      expect(Object.keys(candidate.externalIds)).toEqual(["tcgplayer"]);
      expect(candidate.externalIds.tcgplayer).toMatch(/^\d+$/);
    }
  });

  it("carries the category's groups URL onto every candidate", () => {
    const riftbound = parse().find((candidate) => candidate.game === "riftbound");
    expect(riftbound?.url).toBe("https://tcgcsv.com/tcgplayer/89/groups");
  });
});

describe("tcgcsv provider: the forward window", () => {
  it("drops groups published more than the window ago and keeps future ones", () => {
    const candidates = parse();
    const cutoff = FETCHED_AT.getTime() - FORWARD_WINDOW_DAYS * 24 * 60 * 60 * 1000;

    // TBD candidates always pass the window (including the fixture's real
    // crawl-timestamp-artifact rows, see the "crawl timestamp" describe block
    // below) -- only EXACT ones are checked against the cutoff here.
    for (const candidate of candidates) {
      if (candidate.date.kind !== "EXACT") continue;
      expect(candidate.date.date.getTime()).toBeGreaterThanOrEqual(cutoff);
    }

    // The fixture genuinely contains old rows (SV: Black Bolt, July 2025) that
    // must not survive, and genuinely future ones that must.
    expect(candidates.some((candidate) => candidate.name === "SV: Black Bolt")).toBe(false);
    expect(candidates.some((candidate) => candidate.name === "ME06: Delta Reign")).toBe(true);
  });

  it("keeps a set that a later fetch time would have dropped", () => {
    // Same bytes, read a year later: every EXACT candidate in the recording
    // falls out of the window except the 2027 sets, while the TBD ones
    // (unannounced dates and crawl-timestamp artifacts alike) are unaffected
    // by fetchedAt and still come through. Proves the filter reads the
    // payload's fetchedAt rather than the wall clock.
    const later = parse(FIXTURE, new Date("2027-09-04T00:00:00Z"));
    expect(later.length).toBeLessThan(parse().length);
    for (const candidate of later) {
      if (candidate.date.kind !== "EXACT") continue;
      expect(candidate.date.date.getTime()).toBeGreaterThanOrEqual(
        new Date("2027-09-04T00:00:00Z").getTime() - FORWARD_WINDOW_DAYS * 24 * 60 * 60 * 1000,
      );
    }
  });

  it("keeps a group with no publishedOn as a TBD candidate", () => {
    const value = {
      "89": { success: true, results: [{ groupId: 1, name: "Unannounced Set", abbreviation: "UNA", publishedOn: null }] },
    };
    expect(parse(value)).toEqual([
      expect.objectContaining({ name: "Unannounced Set", date: { kind: "TBD" }, game: "riftbound" }),
    ]);
  });
});

describe("tcgcsv provider: crawl-timestamp publishedOn", () => {
  it("drops a group whose publishedOn is a crawl timestamp", () => {
    // Real tcgcsv rows for evergreen promo/box-set pools (no genuine release
    // date) carry the instant the crawler last touched the record rather
    // than a curated date -- a real ISO instant, "Z"-suffixed and sub-second
    // precise. Left as EXACT this made an ageless pool look like a fresh
    // imminent release every day the crawl ran, which is what actually put
    // "Arena Promos" et al. on the live calendar dated to the pipeline's last
    // run day. The fixture's own MTG category is full of these.
    //
    // Reading them as TBD instead fixed the false dates but kept the rows, and
    // a dateless row that will never gain a date is not a release the calendar
    // can ever show -- it is a ProductSet and an event the gate re-holds
    // forever. A "Z" suffix is not a weaker date; it says this group is not a
    // dated product, so the group is dropped.
    const names = new Set(parse().map((candidate) => candidate.name));
    for (const bucket of ["Arena Promos", "FNM Promos", "Judge Promos", "POP Series 1"]) {
      expect(names.has(bucket)).toBe(false);
    }
  });

  it("leaves genuinely dated groups alone", () => {
    // The guard has to be narrow enough that a real release is never caught by
    // it -- these are ordinary whole-day publishedOn rows in the same payload.
    const names = new Set(parse().map((candidate) => candidate.name));
    expect(names.has("ME06: Delta Reign")).toBe(true);
  });

  it("still reads a naive (non-Z) publishedOn as an EXACT date", () => {
    const value = {
      "1": {
        success: true,
        results: [{ groupId: 2, name: "Real Set", abbreviation: "RS", publishedOn: "2026-11-06T00:00:00" }],
      },
    };
    const [candidate] = parse(value);
    expect(candidate.date).toEqual({ kind: "EXACT", date: new Date("2026-11-06T00:00:00.000Z") });
  });
});

describe("tcgcsv provider: malformed payloads", () => {
  it("throws ParseError when results is not an array", () => {
    expect(() => parse({ "3": { success: true, results: "nope" } })).toThrow(ParseError);
  });

  it("throws ParseError when a group loses its groupId", () => {
    const value = { "3": { success: true, results: [{ name: "Set", publishedOn: "2026-11-06T00:00:00" }] } };
    expect(() => parse(value)).toThrow(ParseError);
  });

  it("throws ParseError on an unreadable publishedOn rather than silently downgrading it to TBD", () => {
    const value = { "3": { success: true, results: [{ groupId: 9, name: "Set", publishedOn: "next Thursday" }] } };
    expect(() => parse(value)).toThrow(/unparseable date/);
  });

  it("names the provider and the failing path", () => {
    try {
      parse({ "3": { success: true, results: [{ groupId: 9, name: "Set", publishedOn: "soon" }] } });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ParseError);
      expect((error as ParseError).providerKey).toBe("tcgcsv");
      expect((error as ParseError).path).toBe("3.results.9.publishedOn");
    }
  });
});

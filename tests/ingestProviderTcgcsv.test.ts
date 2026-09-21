import { describe, expect, it } from "vitest";
import { ParseError } from "@/lib/ingest/normalize";
import { FORWARD_WINDOW_DAYS } from "@/lib/ingest/providers/shared";
import { TCGCSV_CATEGORIES, tcgcsvProvider } from "@/lib/ingest/providers/tcgcsv";
import { loadFixture, parseFixture } from "./fixtures/ingest/helpers";

/**
 * tcgcsv.groups.json is a recording of the ten live
 * `https://tcgcsv.com/tcgplayer/{categoryId}/groups` responses, captured on
 * 2026-09-04 (categoryId 81, Union Arena, on 2026-09-05) and trimmed to every
 * group published on or after 2026-01-01 plus the six most recent older ones
 * per category -- so both sides of the forward window are real rows rather
 * than hand-written ones. Categories 62 (Flesh and Blood) and 63 (Digimon) were
 * recorded later, on 2026-09-19, and trimmed the same way.
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
  it("declares all ten games", () => {
    expect(tcgcsvProvider.games.sort()).toEqual(
      [
        "digimon-card-game",
        "disney-lorcana",
        "flesh-and-blood",
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

describe("tcgcsv provider: pre-release card pools", () => {
  // TCGplayer lists a set's pre-release card pool as its own group carrying the
  // set's code: "Timeless Bonds Release Event Cards" is BT-26, like the booster.
  const DIGIMON_FETCHED_AT = new Date("2026-09-19T12:00:00Z");
  const digimon = () => parse(FIXTURE, DIGIMON_FETCHED_AT).filter((candidate) => candidate.game === "digimon-card-game");
  const fab = () => parse(FIXTURE, DIGIMON_FETCHED_AT).filter((candidate) => candidate.game === "flesh-and-blood");

  it("keeps the real Digimon set and drops its Release Event Cards group", () => {
    const names = digimon().map((candidate) => candidate.name);
    expect(names).toContain("Timeless Bonds");
    expect(names.filter((name) => /release event cards$/i.test(name))).toEqual([]);
    // One product per code, so the code stays usable as an identity key.
    expect(digimon().filter((candidate) => candidate.code === "BT-26")).toHaveLength(1);
  });

  it("keeps the real Flesh and Blood set and drops its Pre-release Cards group", () => {
    const names = fab().map((candidate) => candidate.name);
    expect(names).toContain("Usurp the Shadow Throne");
    expect(names.filter((name) => /pre-?release cards$/i.test(name))).toEqual([]);
  });

  it("applies only to the two games it was written for", () => {
    const value = {
      "3": { success: true, results: [{ groupId: 5, name: "Some Set Prerelease Cards", abbreviation: "SSP", publishedOn: "2026-11-06T00:00:00" }] },
    };
    expect(parse(value)).toHaveLength(1);
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

// ---------------------------------------------------------------------------
// The three date-semantics corrections found by the 2026-09-20 accuracy audit.
// Synthetic payloads on purpose: each case is one row shape from the live feed,
// and a fixture recorded on 2026-09-04 predates half of them.
// ---------------------------------------------------------------------------

function group(groupId: number, name: string, abbreviation: string | null, publishedOn: string, extra: object = {}) {
  return { groupId, name, abbreviation, publishedOn, isSupplemental: false, ...extra };
}

function category(id: number, results: object[]) {
  return { [String(id)]: { success: true, results } };
}

describe("tcgcsv provider: Lorcana dates a numbered set on the day it reaches local game stores", () => {
  // Ravensburger: Hyperia City "pre-release October 16, wide release October 23";
  // TCGplayer's group says 2026-10-16.
  const lorcana = category(71, [
    group(1, "Hyperia City", "14", "2026-10-16T00:00:00"),
    group(2, "Illumineer's Quest: The Great Hunny Rescue", "Q3", "2026-10-02T00:00:00"),
  ]);

  it("emits the date as the local-store PRERELEASE and the shelf date a week later", () => {
    const hyperia = parse(lorcana, new Date("2026-09-20T00:00:00Z")).filter((c) => c.externalIds.tcgplayer === "1");
    expect(hyperia.map((c) => [c.type, c.date])).toEqual([
      ["PRERELEASE", { kind: "EXACT", date: new Date("2026-10-16T00:00:00Z") }],
      ["SHELF", { kind: "EXACT", date: new Date("2026-10-23T00:00:00Z") }],
    ]);
  });

  it("carries the same identity on both, so they resolve to one product", () => {
    const hyperia = parse(lorcana, new Date("2026-09-20T00:00:00Z")).filter((c) => c.externalIds.tcgplayer === "1");
    expect(new Set(hyperia.map((c) => `${c.name}|${c.code}|${c.externalIds.tcgplayer}`)).size).toBe(1);
  });

  it("leaves a non-numbered product alone -- Illumineer's Quest ships on one date everywhere", () => {
    const quest = parse(lorcana, new Date("2026-09-20T00:00:00Z")).filter((c) => c.externalIds.tcgplayer === "2");
    expect(quest).toHaveLength(1);
    expect(quest[0]).toMatchObject({ type: "SHELF", date: { kind: "EXACT", date: new Date("2026-10-02T00:00:00Z") } });
  });

  it("does not shift any other game's numbered-looking code", () => {
    const other = parse(category(3, [group(5, "Some Set", "14", "2026-10-16T00:00:00")]), new Date("2026-09-20T00:00:00Z"));
    expect(other).toHaveLength(1);
    expect(other[0]).toMatchObject({ type: "SHELF", date: { kind: "EXACT", date: new Date("2026-10-16T00:00:00Z") } });
  });
});

describe("tcgcsv provider: release-event card pools are not products", () => {
  // The pool is stamped a week before its set. In Union Arena it also shares its
  // booster's code prefix, so it used to fold into the booster and drag the
  // booster's date a week early (UE20BT showed 06-19, real 06-26).
  const at = new Date("2026-09-20T00:00:00Z");

  it("drops Union Arena's pool and keeps the booster on its own date", () => {
    const candidates = parse(
      category(81, [
        group(10, "UE20BT: That Time I Got Reincarnated as a Slime Release Event Cards", "UE20BT_RE", "2026-06-19T00:00:00"),
        group(11, "UE20BT: That Time I Got Reincarnated as a Slime", "UE20BT", "2026-06-26T00:00:00"),
      ]),
      at,
    );
    expect(candidates.map((c) => [c.code, c.date])).toEqual([
      ["UE20BT", { kind: "EXACT", date: new Date("2026-06-26T00:00:00Z") }],
    ]);
  });

  it("drops One Piece's pool", () => {
    const candidates = parse(
      category(68, [
        group(20, "The Dominance of God Release Event Cards", "OP18 RE", "2026-11-13T00:00:00"),
        group(21, "The Dominance of God", "OP18", "2026-11-20T00:00:00"),
      ]),
      at,
    );
    expect(candidates.map((c) => c.code)).toEqual(["OP18"]);
  });

  it("does not touch a game outside the audited four", () => {
    const candidates = parse(category(3, [group(30, "Something Release Event Cards", "SRE", "2026-11-13T00:00:00")]), at);
    expect(candidates).toHaveLength(1);
  });
});

describe("tcgcsv provider: an Art Series group takes its parent set's date", () => {
  // Production showed Art Series: The Hobbit on 2026-11-13 (the Star Trek date)
  // when it ships inside The Hobbit on 2026-08-14.
  const at = new Date("2026-09-20T00:00:00Z");
  const mtg = category(1, [
    group(40, "The Hobbit", "HOB", "2026-08-14T00:00:00"),
    group(41, "Art Series: The Hobbit", "ASHOB", "2026-11-13T00:00:00", { isSupplemental: true }),
    group(42, "Reality Fracture", "FRA", "2026-10-02T00:00:00"),
    group(43, "Art Series: Reality Fracture", "ASFRA", "2026-10-02T00:00:00", { isSupplemental: true }),
    group(44, "Art Series: Nothing Matches This", "ASNM", "2026-12-25T00:00:00", { isSupplemental: true }),
  ]);

  it("corrects a wrong supplemental date from the parent's", () => {
    const hobbit = parse(mtg, at).find((c) => c.code === "ASHOB");
    expect(hobbit?.date).toEqual({ kind: "EXACT", date: new Date("2026-08-14T00:00:00Z") });
  });

  it("leaves an already-correct one as it was", () => {
    const fracture = parse(mtg, at).find((c) => c.code === "ASFRA");
    expect(fracture?.date).toEqual({ kind: "EXACT", date: new Date("2026-10-02T00:00:00Z") });
  });

  it("keeps its own date when no parent group has that name", () => {
    const orphan = parse(mtg, at).find((c) => c.code === "ASNM");
    expect(orphan?.date).toEqual({ kind: "EXACT", date: new Date("2026-12-25T00:00:00Z") });
  });

  it("does not let a supplemental group be another group's parent", () => {
    const candidates = parse(
      category(1, [
        group(50, "Art Series: Twin", "AST", "2026-10-02T00:00:00", { isSupplemental: true }),
        group(51, "Art Series: Art Series: Twin", "ASAST", "2026-12-01T00:00:00", { isSupplemental: true }),
      ]),
      at,
    );
    expect(candidates.find((c) => c.code === "ASAST")?.date).toEqual({
      kind: "EXACT",
      date: new Date("2026-12-01T00:00:00Z"),
    });
  });
});

import { describe, expect, it } from "vitest";
import { cleanCandidateNaming } from "@/lib/ingest/displayName";

/**
 * The display name is the one field in a candidate whose exact bytes were never
 * a fact, so Normalize is allowed to clean it where it may not touch a date or
 * a shape. These tests pin both halves of that: the artefacts it removes, and
 * the far larger set of names it must leave exactly alone.
 */

describe("cleanCandidateNaming: scraping artefacts", () => {
  it("unwraps a name a source quoted whole", () => {
    // Bulbapedia handed the live pipeline the literal name `"FLO"`, quote marks
    // included, and it went to the database that way.
    expect(cleanCandidateNaming({ name: '"FLO"', code: null }).name).toBe("FLO");
    expect(cleanCandidateNaming({ name: "“Pitch Black”", code: null }).name).toBe("Pitch Black");
  });

  it("leaves an apostrophe inside a real title alone", () => {
    // Only the pair around the outside is punctuation; these are words.
    expect(cleanCandidateNaming({ name: "Winner's Pack 2026-2027", code: "WI26" }).name).toBe("Winner's Pack 2026-2027");
    expect(cleanCandidateNaming({ name: "Illumineer's Quest: The Great Hunny Rescue", code: "Q3" }).name).toBe(
      "Illumineer's Quest: The Great Hunny Rescue",
    );
  });

  it("reads a wiki URL slug back as a title", () => {
    expect(cleanCandidateNaming({ name: "Labyrinth_of_Nightmare", code: null }).name).toBe("Labyrinth of Nightmare");
  });

  it("collapses the whitespace that leaves behind", () => {
    expect(cleanCandidateNaming({ name: "  Chaos   Origins ", code: "CORI" }).name).toBe("Chaos Origins");
  });

  it("keeps the original when cleaning would empty the name", () => {
    // Nothing here is allowed to *destroy* a name -- a candidate that is junk
    // should be rejected on its merits downstream, not silently blanked here.
    expect(cleanCandidateNaming({ name: '""', code: null }).name).toBe('""');
  });
});

describe("cleanCandidateNaming: code prefixes", () => {
  it("drops a prefix the origin's own code already states", () => {
    expect(cleanCandidateNaming({ name: "UE22BT: CHAINSAW MAN", code: "UE22BT" })).toEqual({
      name: "CHAINSAW MAN",
      code: "UE22BT",
    });
  });

  it("promotes a prefix when the origin gave no code", () => {
    expect(cleanCandidateNaming({ name: "OP-13 Royal Blood", code: null })).toEqual({
      name: "Royal Blood",
      code: "OP-13",
    });
  });

  it("keeps a prefix that says something the code column does not", () => {
    // TCGplayer files Delta Reign under the abbreviation DLR but titles it
    // "ME06: Delta Reign". ME06 is the publisher's own series numbering, not a
    // restatement of DLR, so the reader keeps it.
    expect(cleanCandidateNaming({ name: "ME06: Delta Reign", code: "DLR" })).toEqual({
      name: "ME06: Delta Reign",
      code: "DLR",
    });
  });

  it("does not mistake an ordinary first word for a code", () => {
    for (const name of ["POP Series 3", "EX Trainer Kit 1: Latias & Latios", "Set 8", "Star Trek"]) {
      expect(cleanCandidateNaming({ name, code: null }).name).toBe(name);
    }
  });

  it("keeps a name that is nothing but its code", () => {
    expect(cleanCandidateNaming({ name: "UE22BT", code: "UE22BT" }).name).toBe("UE22BT");
  });
});

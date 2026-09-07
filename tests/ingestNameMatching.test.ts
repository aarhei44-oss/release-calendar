import { describe, expect, it } from "vitest";
import { isFuzzyProductSetNameMatch, productSetNameSimilarity } from "@/lib/ingest/nameMatching";

describe("isFuzzyProductSetNameMatch", () => {
  it("matches a redundant sequence-label prefix against the bare title (lorcana.gg vs. Wikipedia naming)", () => {
    expect(isFuzzyProductSetNameMatch("Set 1: The First Chapter", "The First Chapter")).toBe(true);
  });

  it("matches ignoring generic product-type words and capitalization", () => {
    expect(isFuzzyProductSetNameMatch("Scarlet Skies Booster Box", "SCARLET SKIES")).toBe(true);
  });

  it("does not match a sequel/volume number against the same title without one", () => {
    expect(isFuzzyProductSetNameMatch("Dedup Pass Set", "Dedup Pass Set 2")).toBe(false);
  });

  it("does not match two different sequence numbers", () => {
    expect(isFuzzyProductSetNameMatch("Series 1: Foo", "Series 2: Foo")).toBe(false);
  });

  it("does not match genuinely different products that merely share one word", () => {
    expect(isFuzzyProductSetNameMatch("Scarlet Skies", "Scarlet Violet")).toBe(false);
  });

  it("does not match a set-code folded into the name with no shared words (known limitation)", () => {
    // Documents the boundary of what token-similarity can catch -- this
    // case needs identity resolution against a canonical per-TCG source.
    expect(isFuzzyProductSetNameMatch("Secret Lair: The Zeta Set", "The Zeta Set SLZ")).toBe(false);
  });

  it("never matches when either name has no significant tokens", () => {
    expect(productSetNameSimilarity("(2026)", "Set")).toBe(0);
  });

  it("matches a short, stopword-heavy title against its source-appended set-code variant", () => {
    // "The" is a stopword, so "The Hobbit" has only one significant token
    // ("hobbit") -- too little for the general Dice score to survive a
    // second source appending the set's own code (real MTG/Scryfall data).
    expect(isFuzzyProductSetNameMatch("The Hobbit", "The Hobbit HOB")).toBe(true);
    expect(isFuzzyProductSetNameMatch("Reality Fracture", "Reality Fracture FRA")).toBe(true);
  });

  it("does not match a sub-product that shares the base name plus a set code, when it also adds a real distinguishing word", () => {
    // Commander precons and token sheets are genuinely different releases
    // from the main set, not just a differently-formatted name for it, even
    // though they also carry an appended set code.
    expect(isFuzzyProductSetNameMatch("Reality Fracture", "Reality Fracture Commander FRC")).toBe(false);
    expect(isFuzzyProductSetNameMatch("Reality Fracture", "Reality Fracture Tokens TFRA")).toBe(false);
    expect(isFuzzyProductSetNameMatch("The Hobbit", "The Hobbit Eternal HOC")).toBe(false);
  });

  it("does not let an appended set code override a sequence-number veto", () => {
    // A trailing all-caps code stripped from each side must not bypass the
    // "different sequence-label numbers never match" rule above.
    expect(isFuzzyProductSetNameMatch("Series 1: Foo BAR", "Series 2: Foo BAZ")).toBe(false);
  });

  it("does not strip a trailing bare year/number as if it were a set code", () => {
    // "2010" is all-digit -- must stay subject to the numbers veto, not be
    // discarded the way an alphanumeric code (e.g. "M10") is.
    expect(isFuzzyProductSetNameMatch("Magic 2010", "Magic 2011")).toBe(false);
  });
});

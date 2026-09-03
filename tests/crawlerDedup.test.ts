import { describe, expect, it } from "vitest";
import {
  findMatchingEvent,
  dispositionFor,
  isFuzzyProductSetNameMatch,
  productSetNameSimilarity,
  type EventDateInfo,
} from "@/lib/crawler/dedup";

function exact(dateStr: string): EventDateInfo {
  return { dateType: "EXACT", dateExact: new Date(dateStr) };
}

function tbd(): EventDateInfo {
  return { dateType: "TBD" };
}

describe("findMatchingEvent", () => {
  it("matches an existing event within the proximity window", () => {
    const existing = [{ id: "a", ...exact("2026-03-15") }, { id: "b", ...exact("2026-06-01") }];
    const match = findMatchingEvent(exact("2026-03-20"), existing);
    expect(match?.id).toBe("a");
  });

  it("does not match an event outside the proximity window", () => {
    const existing = [{ id: "a", ...exact("2026-03-15") }];
    const match = findMatchingEvent(exact("2026-05-01"), existing);
    expect(match).toBeNull();
  });

  it("picks the closest match when multiple are within range", () => {
    const existing = [{ id: "far", ...exact("2026-03-01") }, { id: "near", ...exact("2026-03-10") }];
    const match = findMatchingEvent(exact("2026-03-12"), existing);
    expect(match?.id).toBe("near");
  });

  it("matches TBD candidates only against existing TBD events", () => {
    const existing = [{ id: "a", ...exact("2026-03-15") }, { id: "b", ...tbd() }];
    const match = findMatchingEvent(tbd(), existing);
    expect(match?.id).toBe("b");
  });

  it("returns null when there is nothing to match", () => {
    expect(findMatchingEvent(exact("2026-03-15"), [])).toBeNull();
  });
});

describe("dispositionFor", () => {
  it("supports when there is no current event yet", () => {
    expect(dispositionFor(exact("2026-03-15"), null)).toBe("SUPPORTS");
  });

  it("supports when the current event is still TBD", () => {
    expect(dispositionFor(exact("2026-03-15"), tbd())).toBe("SUPPORTS");
  });

  it("supports when dates agree within the proximity window", () => {
    expect(dispositionFor(exact("2026-03-15"), exact("2026-03-18"))).toBe("SUPPORTS");
  });

  it("contradicts when dates disagree beyond the proximity window", () => {
    expect(dispositionFor(exact("2026-03-15"), exact("2026-06-01"))).toBe("CONTRADICTS");
  });
});

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

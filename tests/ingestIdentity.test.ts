import { describe, expect, it } from "vitest";
import {
  collectAmbiguousCodes,
  isPlaceholderName,
  normalizeSetCode,
  resolveSetIdentity,
  setCodesFor,
  stripSetCodeTokens,
  type ExistingProductSet,
  type IdentityContext,
  type SetIdentityRecord,
} from "@/lib/ingest/identity";

/**
 * Identity resolution decides which product a scraped row is *about*, and it
 * is the stage where a mistake is least recoverable: two real products fused
 * into one event cannot be safely separated again by any later automated pass.
 * So the ordering under test here -- ids beat names, and "no idea" beats a
 * marginal guess -- is the point, not an implementation detail.
 *
 * Pure unit tests: the existing sets and identities are arguments, exactly as
 * the pipeline passes them.
 */

const SETS: ExistingProductSet[] = [
  { id: "set-first-chapter", name: "The First Chapter" },
  { id: "set-reality-fracture", name: "Reality Fracture" },
  { id: "set-obsidian-flames", name: "Obsidian Flames" },
  { id: "set-untitled", name: null },
];

const IDENTITIES: SetIdentityRecord[] = [
  { origin: "tcgplayer", externalId: "22873", productSetId: "set-first-chapter" },
  { origin: "scryfall", externalId: "fra", productSetId: "set-reality-fracture" },
  { origin: "pokemon-official", externalId: "sv03", productSetId: "set-obsidian-flames" },
];

function context(overrides: Partial<IdentityContext> = {}): IdentityContext {
  return { sets: [...SETS], identities: [...IDENTITIES], ...overrides };
}

function candidate(overrides: Partial<Parameters<typeof resolveSetIdentity>[0]> = {}) {
  return {
    origin: "tcgplayer",
    externalIds: {} as Record<string, string>,
    name: "Some Set",
    ...overrides,
  };
}

describe("resolveSetIdentity: ID matching", () => {
  it("matches on the candidate's own origin id", () => {
    const result = resolveSetIdentity(
      candidate({ origin: "tcgplayer", externalIds: { tcgplayer: "22873" }, name: "The First Chapter" }),
      context(),
    );
    expect(result).toEqual({ productSetId: "set-first-chapter", matchedBy: "id", matchedOrigin: "tcgplayer" });
  });

  it("matches on a cited sibling origin's id when it has none of its own", () => {
    const result = resolveSetIdentity(
      candidate({ origin: "wikipedia", externalIds: { scryfall: "fra" }, name: "Totally Different Words" }),
      context(),
    );
    expect(result.productSetId).toBe("set-reality-fracture");
    expect(result.matchedBy).toBe("id");
    expect(result.matchedOrigin).toBe("scryfall");
  });

  it("prefers the candidate's OWN origin id over a cited sibling's", () => {
    // The candidate cites a scryfall id pointing at one set and carries its own
    // tcgplayer id pointing at another. A provider is authoritative about its
    // own id space; a second-hand id is likelier to be stale.
    const result = resolveSetIdentity(
      candidate({
        origin: "tcgplayer",
        externalIds: { scryfall: "fra", tcgplayer: "22873" },
        name: "Reality Fracture",
      }),
      context(),
    );
    expect(result.productSetId).toBe("set-first-chapter");
    expect(result.matchedOrigin).toBe("tcgplayer");
  });

  it("resolves deterministically when only foreign ids are present", () => {
    const ctx = context({
      identities: [
        ...IDENTITIES,
        { origin: "ygoprodeck", externalId: "zzz", productSetId: "set-obsidian-flames" },
      ],
    });
    const input = candidate({
      origin: "wikipedia",
      externalIds: { ygoprodeck: "zzz", scryfall: "fra" },
      name: "Anything",
    });
    // Foreign origins are tried in sorted order, so the answer never depends on
    // object key insertion order across a replay.
    expect(resolveSetIdentity(input, ctx).matchedOrigin).toBe("scryfall");
    expect(resolveSetIdentity(input, ctx).productSetId).toBe("set-reality-fracture");
  });
});

describe("resolveSetIdentity: an ID match beats a name match", () => {
  it("uses the id even when the name points somewhere else entirely", () => {
    const result = resolveSetIdentity(
      candidate({
        origin: "tcgplayer",
        // Name is a perfect match for set-obsidian-flames...
        name: "Obsidian Flames",
        // ...but the id says otherwise, and the id wins.
        externalIds: { tcgplayer: "22873" },
      }),
      context(),
    );
    expect(result.matchedBy).toBe("id");
    expect(result.productSetId).toBe("set-first-chapter");
  });

  it("falls through to the name only when no id resolves", () => {
    const result = resolveSetIdentity(
      candidate({ origin: "tcgplayer", externalIds: { tcgplayer: "unknown-id" }, name: "Obsidian Flames" }),
      context(),
    );
    expect(result.matchedBy).toBe("name");
    expect(result.productSetId).toBe("set-obsidian-flames");
  });

  it("falls through to the name when the candidate carries no ids at all", () => {
    const result = resolveSetIdentity(candidate({ externalIds: {}, name: "Obsidian Flames" }), context());
    expect(result.matchedBy).toBe("name");
  });
});

describe("resolveSetIdentity: name fallback", () => {
  it("matches on the normalized name, ignoring punctuation and case", () => {
    const result = resolveSetIdentity(candidate({ name: "obsidian-flames!" }), context());
    expect(result).toEqual({ productSetId: "set-obsidian-flames", matchedBy: "name", score: 1 });
  });

  it("matches a name carrying a trailing source code, via the shared v1 helper", () => {
    const result = resolveSetIdentity(candidate({ name: "Reality Fracture FRA" }), context());
    expect(result.productSetId).toBe("set-reality-fracture");
    expect(result.matchedBy).toBe("name");
  });

  it("matches across a redundant sequence-label prefix", () => {
    const result = resolveSetIdentity(candidate({ name: "Set 1: The First Chapter" }), context());
    expect(result.productSetId).toBe("set-first-chapter");
    expect(result.matchedBy).toBe("name");
  });

  it("refuses to match a sequel to its predecessor (the number veto)", () => {
    const result = resolveSetIdentity(candidate({ name: "Obsidian Flames 2" }), context());
    expect(result).toEqual({ productSetId: null, matchedBy: "new" });
  });

  it("ignores sets with no name at all", () => {
    const result = resolveSetIdentity(candidate({ name: "Nothing Like Anything Here" }), {
      sets: [{ id: "set-untitled", name: null }],
      identities: [],
    });
    expect(result.matchedBy).toBe("new");
  });

  it("treats an unmatchable normalized name as new rather than a grouping key", () => {
    // "(2026)" normalizes to the empty string; if that were allowed to match,
    // every parenthetical-only name in an install would collide.
    const result = resolveSetIdentity(candidate({ name: "(2026)" }), context());
    expect(result).toEqual({ productSetId: null, matchedBy: "new" });
  });

  it("reports the similarity score for a fuzzy (non-exact) match", () => {
    const result = resolveSetIdentity(candidate({ name: "Reality Fracture FRA" }), context());
    expect(result.score).toBeGreaterThan(0);
    expect(result.score).toBeLessThanOrEqual(1);
  });

  it("picks the highest-scoring set when several are similar", () => {
    const ctx: IdentityContext = {
      identities: [],
      sets: [
        { id: "weak", name: "Crimson Haze Commander Decks" },
        { id: "strong", name: "Crimson Haze" },
      ],
    };
    const result = resolveSetIdentity(candidate({ name: "Crimson Haze" }), ctx);
    expect(result.productSetId).toBe("strong");
  });

  it("keeps the first (oldest) set on a tie, so replay is deterministic", () => {
    const ctx: IdentityContext = {
      identities: [],
      sets: [
        { id: "older", name: "Crimson Haze" },
        { id: "newer", name: "Crimson Haze" },
      ],
    };
    expect(resolveSetIdentity(candidate({ name: "Crimson Haze" }), ctx).productSetId).toBe("older");
  });
});

describe("set codes", () => {
  it("normalizes case and separators so one code is one key", () => {
    expect(normalizeSetCode("OP-13")).toBe("OP13");
    expect(normalizeSetCode("op 13")).toBe("OP13");
    expect(normalizeSetCode("OP13")).toBe("OP13");
    expect(normalizeSetCode("ST-09")).toBe("ST09");
  });

  it("refuses placeholder codes as identity keys", () => {
    // Wikipedia's Magic list carries the literal code "TBA" on several
    // unannounced sets at once; taking it at face value would fuse them.
    for (const placeholder of ["TBA", "tbd", "TBC", "N/A", "n/a", "?", "—", "", "  ", "unknown", "none"]) {
      expect(normalizeSetCode(placeholder), placeholder).toBeNull();
    }
    expect(normalizeSetCode(null)).toBeNull();
    expect(normalizeSetCode(undefined)).toBeNull();
  });

  it("refuses a single character, which is a sequence position rather than a code", () => {
    expect(normalizeSetCode("9")).toBeNull();
    expect(normalizeSetCode("A")).toBeNull();
    expect(normalizeSetCode("13")).toBe("13");
  });

  it("reads a code from the code column, a leading token and a trailing bracket", () => {
    expect(setCodesFor({ name: "Delta Reign", code: "DLR" })).toEqual(["DLR"]);
    expect(setCodesFor({ name: "ME06: Delta Reign", code: null })).toEqual(["ME06"]);
    expect(setCodesFor({ name: "OP-13 Royal Blood", code: null })).toEqual(["OP13"]);
    expect(setCodesFor({ name: "Phantom Aria [GD04]", code: null })).toEqual(["GD04"]);
    // The column wins the first slot, but a code in the name is still carried:
    // either one is allowed to find the set.
    expect(setCodesFor({ name: "ME06: Delta Reign", code: "DLR" })).toEqual(["DLR", "ME06"]);
  });

  it("does not mistake an ordinary first word for a code", () => {
    // Each of these would be a disaster as an identity key: "POP" is shared by
    // nine Pokémon sets, "EX" by two trainer kits, and "Set" by every
    // placeholder row on Wikipedia's Riftbound table.
    expect(setCodesFor({ name: "POP Series 3", code: null })).toEqual([]);
    expect(setCodesFor({ name: "EX Trainer Kit 1: Latias & Latios", code: null })).toEqual([]);
    expect(setCodesFor({ name: "Set 8", code: null })).toEqual([]);
    expect(setCodesFor({ name: "Star Trek", code: null })).toEqual([]);
    expect(setCodesFor({ name: "Ultimate Tournament Pack 2", code: null })).toEqual([]);
  });

  it("does not mistake a parenthetical phrase or a bare year for a code", () => {
    expect(setCodesFor({ name: "Legendary Dragon Decks (2020 Date Reprint)", code: null })).toEqual([]);
    expect(setCodesFor({ name: "Something (2026)", code: null })).toEqual([]);
  });

  it("strips code tokens back off a name", () => {
    expect(stripSetCodeTokens("ME06: Delta Reign")).toBe("Delta Reign");
    expect(stripSetCodeTokens("OP-13 Royal Blood")).toBe("Royal Blood");
    expect(stripSetCodeTokens("Phantom Aria [GD04]")).toBe("Phantom Aria");
    expect(stripSetCodeTokens("Set 8")).toBe("Set 8");
    expect(stripSetCodeTokens("The First Chapter")).toBe("The First Chapter");
  });

  it("marks a code ambiguous when one origin hands it to several products", () => {
    const ambiguous = collectAmbiguousCodes([
      { origin: "tcgplayer", name: "POP Series 1", code: "POP" },
      { origin: "tcgplayer", name: "POP Series 2", code: "POP" },
      { origin: "tcgplayer", name: "Delta Reign", code: "DLR" },
      // Two origins naming the same product differently is NOT ambiguity -- it
      // is exactly the case the code tier exists to resolve.
      { origin: "bulbapedia", name: "Mega Evolution—Delta Reign", code: "DLR" },
    ]);
    expect(ambiguous.has("POP")).toBe(true);
    expect(ambiguous.has("DLR")).toBe(false);
  });
});

describe("resolveSetIdentity: code matching", () => {
  const CODED: ExistingProductSet[] = [
    { id: "set-delta-reign", name: "Mega Evolution—Delta Reign", code: "DLR" },
    { id: "set-phantom-aria", name: "Phantom Aria", code: "GD04" },
  ];

  it("matches a code-prefixed retailer name against a series-prefixed wiki name", () => {
    // The launch blocker: these two names score 0.571, which no safe similarity
    // threshold reaches. They share a code, and that is a published fact.
    const result = resolveSetIdentity(candidate({ name: "ME06: Delta Reign", code: "DLR" }), {
      sets: CODED,
      identities: [],
    });
    expect(result).toEqual({ productSetId: "set-delta-reign", matchedBy: "code", matchedCode: "DLR" });
  });

  it("matches a code read out of the candidate's name against a stored code", () => {
    const result = resolveSetIdentity(candidate({ name: "GD04 Something Else Entirely", code: null }), {
      sets: CODED,
      identities: [],
    });
    expect(result.matchedBy).toBe("code");
    expect(result.productSetId).toBe("set-phantom-aria");
  });

  it("matches a code read out of the stored set's name", () => {
    const result = resolveSetIdentity(candidate({ name: "Totally Different", code: "ME06" }), {
      sets: [{ id: "set-dr", name: "ME06: Delta Reign", code: null }],
      identities: [],
    });
    expect(result.productSetId).toBe("set-dr");
    expect(result.matchedBy).toBe("code");
  });

  it("lets an ID match beat a code match", () => {
    const result = resolveSetIdentity(
      candidate({ origin: "tcgplayer", externalIds: { tcgplayer: "22873" }, name: "ME06: Delta Reign", code: "DLR" }),
      { sets: [...CODED, ...SETS], identities: IDENTITIES },
    );
    expect(result.matchedBy).toBe("id");
    expect(result.productSetId).toBe("set-first-chapter");
  });

  it("ignores a code the run has flagged as ambiguous", () => {
    const context: IdentityContext = {
      sets: [{ id: "set-pop-1", name: "POP Series 1", code: "POP" }],
      identities: [],
      ambiguousCodes: new Set(["POP"]),
    };
    // Without the guard this is the nine-way POP merge.
    expect(resolveSetIdentity(candidate({ name: "POP Series 2", code: "POP" }), context)).toEqual({
      productSetId: null,
      matchedBy: "new",
    });
  });

  it("ignores a code two stored sets already claim", () => {
    // The store itself is ambiguous; picking a winner would turn that into a
    // merge, so the code simply stops being a key.
    const context: IdentityContext = {
      sets: [
        { id: "set-a", name: "Nintendo Promos", code: "PR" },
        { id: "set-b", name: "Alternate Art Promos", code: "PR" },
      ],
      identities: [],
    };
    expect(resolveSetIdentity(candidate({ name: "Burger King Promos", code: "PR" }), context).matchedBy).toBe("new");
  });

  it("never matches a placeholder code", () => {
    const context: IdentityContext = {
      sets: [{ id: "set-unannounced", name: "Unnamed Universes Beyond Set", code: "TBA" }],
      identities: [],
    };
    const result = resolveSetIdentity(candidate({ name: "Another Unannounced Thing", code: "TBA" }), context);
    expect(result).toEqual({ productSetId: null, matchedBy: "new" });
  });

  it("does not match across games when both sides state one", () => {
    const context: IdentityContext = {
      sets: [{ id: "set-gundam", name: "Phantom Aria", code: "GD04", game: "gundam-card-game" }],
      identities: [],
    };
    expect(
      resolveSetIdentity(candidate({ name: "GD04 Whatever", code: "GD04", game: "one-piece-tcg" }), context).matchedBy,
    ).toBe("new");
  });

  it("never matches a stored set's synthetic code, even one that is code-shaped", () => {
    // orchestrate.ts invents a code (SYN-...) for a set first seen from a
    // code-less origin, purely to satisfy the NOT NULL column -- no source
    // ever published it, so it must not be able to pair two products the way
    // a real shared code does.
    const context: IdentityContext = {
      sets: [{ id: "set-wiki-only", name: "Some New Set", code: "SYNABC123", codeIsSynthetic: true }],
      identities: [],
    };
    const result = resolveSetIdentity(candidate({ name: "Unrelated Name", code: "SYNABC123" }), context);
    expect(result.matchedBy).toBe("new");
  });
});

describe("resolveSetIdentity: name matching across naming conventions", () => {
  it("matches on the segment after a separator when one side leads with a code", () => {
    const context: IdentityContext = { sets: [{ id: "set-dr", name: "Mega Evolution—Delta Reign" }], identities: [] };
    const result = resolveSetIdentity(candidate({ name: "ME06: Delta Reign" }), context);
    expect(result.productSetId).toBe("set-dr");
    expect(result.matchedBy).toBe("name");
  });

  it("matches an expansion-series name against a bare code prefix", () => {
    const context: IdentityContext = { sets: [{ id: "set-30c", name: "30th Celebration" }], identities: [] };
    expect(resolveSetIdentity(candidate({ name: "ME: 30th Celebration" }), context).productSetId).toBe("set-30c");
  });

  it("matches a Scarlet & Violet set across both naming conventions", () => {
    const context: IdentityContext = {
      sets: [{ id: "set-sv10", name: "Scarlet & Violet—Destined Rivals" }],
      identities: [],
    };
    expect(resolveSetIdentity(candidate({ name: "SV10: Destined Rivals" }), context).productSetId).toBe("set-sv10");
  });

  it("matches once a leading code token is stripped", () => {
    const context: IdentityContext = { sets: [{ id: "set-rb", name: "Royal Blood" }], identities: [] };
    expect(resolveSetIdentity(candidate({ name: "OP-13 Royal Blood" }), context).productSetId).toBe("set-rb");
  });

  it("matches a trailing bracketed code against a leading one", () => {
    const context: IdentityContext = { sets: [{ id: "set-pa", name: "Phantom Aria [GD04]" }], identities: [] };
    expect(resolveSetIdentity(candidate({ name: "GD04 Phantom Aria" }), context).productSetId).toBe("set-pa");
  });
});

describe("resolveSetIdentity: the anti-false-merge guards", () => {
  it("keeps two sequential sets in the same expansion apart", () => {
    const context: IdentityContext = { sets: [{ id: "set-sv01", name: "SV01: Scarlet & Violet" }], identities: [] };
    expect(resolveSetIdentity(candidate({ name: "SV02: Paldea Evolved" }), context).matchedBy).toBe("new");
  });

  it("vetoes a perfect name match when the codes disagree", () => {
    // Identical once the codes come off, and by every string measure the same
    // product. The code is the only thing that says otherwise, so it has to win.
    const context: IdentityContext = { sets: [{ id: "set-op13", name: "OP-13 Royal Blood" }], identities: [] };
    expect(resolveSetIdentity(candidate({ name: "OP-14 Royal Blood" }), context)).toEqual({
      productSetId: null,
      matchedBy: "new",
    });
  });

  it("vetoes on codes taken from the code column as well as the name", () => {
    const context: IdentityContext = { sets: [{ id: "set-msh", name: "Marvel Super Heroes", code: "MSH" }], identities: [] };
    const result = resolveSetIdentity(candidate({ name: "Commander: Marvel Super Heroes", code: "MSC" }), context);
    expect(result.matchedBy).toBe("new");
  });

  it("keeps Wikipedia's placeholder Riftbound names apart", () => {
    const context: IdentityContext = { sets: [{ id: "set-8", name: "Set 8" }], identities: [] };
    expect(resolveSetIdentity(candidate({ name: "Set 9" }), context).matchedBy).toBe("new");
  });

  it("lets a side with no code abstain rather than veto", () => {
    // Most wiki rows have no code column at all. If silence counted as
    // disagreement the name tier would never fire again.
    const context: IdentityContext = { sets: [{ id: "set-dr", name: "Mega Evolution—Delta Reign" }], identities: [] };
    expect(resolveSetIdentity(candidate({ name: "ME06: Delta Reign", code: "DLR" }), context).productSetId).toBe(
      "set-dr",
    );
  });

  it("refuses to merge a set into a longer-named sibling on a partial tail", () => {
    // "ME: 30th Celebration Classic Collection" scores 0.8 against "30th
    // Celebration" once the prefix is discounted. Tail comparison is exact-only
    // so that this stays apart while the true pair still merges.
    const context: IdentityContext = {
      sets: [{ id: "set-30c", name: "30th Celebration", code: "30C" }],
      identities: [],
      // tcgcsv gives 30C to both the main set and the Classic Collection, so a
      // real run has already ruled the code out as a key; the name tier is what
      // has to get this right on its own.
      ambiguousCodes: new Set(["30C"]),
    };
    const result = resolveSetIdentity(
      candidate({ name: "ME: 30th Celebration Classic Collection", code: "30C" }),
      context,
    );
    expect(result.matchedBy).toBe("new");
  });

  it("refuses to fold a derived product into the set it is named after", () => {
    // "Commander:" and "Art Series:" heads are not code-shaped, so their tails
    // may not be matched against a whole name.
    const context: IdentityContext = { sets: [{ id: "set-hobbit", name: "The Hobbit" }], identities: [] };
    expect(resolveSetIdentity(candidate({ name: "Art Series: The Hobbit" }), context).matchedBy).toBe("new");
  });
});

describe("resolveSetIdentity: new products", () => {
  it("reports `new` rather than forcing a marginal match", () => {
    const result = resolveSetIdentity(candidate({ name: "Something Nobody Has Ever Heard Of" }), context());
    expect(result).toEqual({ productSetId: null, matchedBy: "new" });
  });

  it("reports `new` against an empty catalogue", () => {
    const result = resolveSetIdentity(candidate({ name: "The First Chapter" }), { sets: [], identities: [] });
    expect(result).toEqual({ productSetId: null, matchedBy: "new" });
  });
});

describe("placeholder names", () => {
  /**
   * The name-shaped twin of the placeholder-code rule. Wikipedia's Magic list
   * carries three separate rows all called "Unnamed Universes Beyond Set", with
   * "TBA" in every other column -- three products Wizards has slotted and not
   * announced. They are not one product, and a shared placeholder is not
   * evidence that they are; it is evidence that none of them has a name yet.
   */
  it("recognises the placeholders the fixtures actually contain", () => {
    for (const name of [
      "Unnamed Universes Beyond Set",
      "TBA",
      "TBD",
      "—",
      "?",
      "N/A",
      "Untitled expansion",
      "TBA Universes Beyond set",
      "",
    ]) {
      expect(isPlaceholderName(name), name).toBe(true);
    }
  });

  it("does not mistake an un-set for an unnamed one", () => {
    // The prefix rule stops at a word boundary, because these are real products.
    for (const name of ["Unglued", "Unhinged", "Unstable", "Unsanctioned", "Unfinity", "Undercity"]) {
      expect(isPlaceholderName(name), name).toBe(false);
    }
  });

  it("keeps three identically-named placeholder rows on three sets", () => {
    // Resolved in sequence against a catalogue that grows as they are created,
    // exactly as orchestrate.ts's resolveInstallCandidates does.
    const sets: ExistingProductSet[] = [];
    const ids = new Set<string>();
    for (let index = 0; index < 3; index++) {
      const result = resolveSetIdentity(candidate({ name: "Unnamed Universes Beyond Set" }), {
        sets,
        identities: [],
      });
      expect(result.matchedBy).toBe("new");
      const id = `placeholder-${index}`;
      sets.push({ id, name: "Unnamed Universes Beyond Set" });
      ids.add(id);
    }
    expect(ids.size).toBe(3);
  });

  it("still honours an external id on a placeholder-named row", () => {
    // The refusal is scoped to the *name* tier. A row an upstream has pinned by
    // id is identified, whatever its name column says.
    const result = resolveSetIdentity(
      candidate({ origin: "wikipedia", externalIds: { wikipedia: "wp-1" }, name: "TBA" }),
      { sets: [{ id: "set-known", name: "Known Set" }], identities: [{ origin: "wikipedia", externalId: "wp-1", productSetId: "set-known" }] },
    );
    expect(result).toMatchObject({ productSetId: "set-known", matchedBy: "id" });
  });

  it("never lets a placeholder-named stored set absorb a real one", () => {
    const result = resolveSetIdentity(candidate({ name: "Unnamed Universes Beyond Set" }), {
      sets: [{ id: "set-placeholder", name: "Unnamed Universes Beyond Set" }],
      identities: [],
    });
    expect(result.matchedBy).toBe("new");
  });
});

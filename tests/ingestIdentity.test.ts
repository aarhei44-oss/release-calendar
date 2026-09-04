import { describe, expect, it } from "vitest";
import {
  resolveSetIdentity,
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

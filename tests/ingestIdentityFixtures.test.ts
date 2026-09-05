import { describe, expect, it } from "vitest";
import {
  collectAmbiguousCodes,
  resolveSetIdentity,
  type ExistingProductSet,
  type SetIdentityRecord,
} from "@/lib/ingest/identity";
import { bulbapediaProvider } from "@/lib/ingest/providers/bulbapedia";
import { scryfallProvider } from "@/lib/ingest/providers/scryfall";
import { tcgcsvProvider } from "@/lib/ingest/providers/tcgcsv";
import { wikipediaProvider } from "@/lib/ingest/providers/wikipedia";
import { ygoprodeckProvider } from "@/lib/ingest/providers/ygoprodeck";
import { ORIGINS, originsAreIndependent, type Candidate, type Origin } from "@/lib/ingest/types";
import { loadFixture, parseFixture } from "./fixtures/ingest/helpers";

/**
 * Identity resolution measured against the real world, not against a fixture
 * written to make it pass.
 *
 * Every candidate here comes from parsing the recorded 2026-09-04 responses of
 * all five Phase 2 providers, and the assertions are about the thing the
 * pipeline actually needs: does the TCGplayer row and the wiki row for one
 * physical product end up on ONE ProductSet? That question is the entire
 * precondition for gate rule G2 -- two independent origins agreeing publishes a
 * date immediately, where a lone retailer claim has to survive seven runs of G3
 * first -- and before the code identity tier the answer for Pokemon was no.
 *
 * The unit tests in ingestIdentity.test.ts pin the rules. This file pins the
 * *outcome*, which is the only thing that tells us the rules were the right
 * ones. Nothing here touches the network or the database.
 */

/** The payloads were captured at this instant; the forward-window filter measures from it. */
const FETCHED_AT = new Date("2026-09-04T20:00:00.000Z");

/**
 * Ordered by provider key, exactly as ingestRepo.getRawPayloads returns them,
 * because identity resolution is order-dependent (the first candidate for a new
 * product creates the set the rest match against) and a test that resolved them
 * in a different order would not be testing the production sequence.
 */
const FIXTURES = [
  [bulbapediaProvider, "bulbapedia.pages.json"],
  [scryfallProvider, "scryfall.sets.json"],
  [tcgcsvProvider, "tcgcsv.groups.json"],
  [wikipediaProvider, "wikipedia.pages.json"],
  [ygoprodeckProvider, "ygoprodeck.cardsets.json"],
] as const;

type ResolvedGame = {
  /** ProductSet id -> the candidates that landed on it. */
  members: Map<string, Candidate[]>;
  /** Candidate name -> the ProductSet id it resolved to. */
  setOf: Map<string, string>;
  candidates: Candidate[];
};

/**
 * Reproduces lib/ingest/orchestrate.ts's resolveInstallCandidates: resolve each
 * candidate in turn, create a set when nothing matches, and extend the
 * in-memory context so later candidates in the same batch can find it.
 *
 * SHELF events only. A PRERELEASE candidate is the same product under a
 * different event type, so counting it would double-count the pairing.
 */
function resolveGame(all: Candidate[], game: string): ResolvedGame {
  const candidates = all.filter((candidate) => candidate.game === game && candidate.type === "SHELF");
  const sets: ExistingProductSet[] = [];
  const identities: SetIdentityRecord[] = [];
  const ambiguousCodes = collectAmbiguousCodes(candidates);

  const members = new Map<string, Candidate[]>();
  const setOf = new Map<string, string>();
  let next = 0;

  for (const candidate of candidates) {
    const resolution = resolveSetIdentity(candidate, { sets, identities, ambiguousCodes });
    let productSetId = resolution.productSetId;
    if (!productSetId) {
      productSetId = `set-${next++}`;
      sets.push({ id: productSetId, name: candidate.name, code: candidate.code });
    }
    for (const [origin, externalId] of Object.entries(candidate.externalIds)) {
      identities.push({ origin, externalId, productSetId });
    }
    members.set(productSetId, [...(members.get(productSetId) ?? []), candidate]);
    setOf.set(candidate.name, productSetId);
  }

  return { members, setOf, candidates };
}

/** Whether a set's claims include two origins the gate would count as separate observations. */
function hasIndependentAgreement(group: Candidate[]): boolean {
  const origins: Origin[] = [...new Set(group.map((candidate) => candidate.origin))];
  return origins.some((a) => origins.some((b) => originsAreIndependent(a, b, ORIGINS)));
}

const ALL: Candidate[] = FIXTURES.flatMap(([provider, file]) =>
  parseFixture(provider, loadFixture(file), FETCHED_AT),
);

const GAMES = [
  "disney-lorcana",
  "gundam-card-game",
  "magic-the-gathering",
  "one-piece-tcg",
  "pokemon-tcg",
  "riftbound",
  "yugioh-tcg",
] as const;

const RESOLVED = new Map(GAMES.map((game) => [game, resolveGame(ALL, game)] as const));

function forGame(game: (typeof GAMES)[number]): ResolvedGame {
  return RESOLVED.get(game) as ResolvedGame;
}

/** The set two named candidates resolved to, asserted to be the same one. */
function expectSameSet(game: (typeof GAMES)[number], a: string, b: string): void {
  const { setOf } = forGame(game);
  expect(setOf.get(a), `${a} was not parsed out of the fixtures`).toBeDefined();
  expect(setOf.get(b), `${b} was not parsed out of the fixtures`).toBeDefined();
  expect(setOf.get(a), `${a} and ${b} should be one product`).toBe(setOf.get(b));
}

function expectDifferentSets(game: (typeof GAMES)[number], a: string, b: string): void {
  const { setOf } = forGame(game);
  expect(setOf.get(a), `${a} was not parsed out of the fixtures`).toBeDefined();
  expect(setOf.get(b), `${b} was not parsed out of the fixtures`).toBeDefined();
  expect(setOf.get(a), `${a} and ${b} are different products`).not.toBe(setOf.get(b));
}

// ---------------------------------------------------------------------------
// The pairings G2 depends on
// ---------------------------------------------------------------------------

describe("real fixtures: the cross-origin pairings gate rule G2 needs", () => {
  it("pairs the TCGplayer and Bulbapedia rows for Delta Reign", () => {
    // The headline failure. TCGplayer prefixes the set code, Bulbapedia prefixes
    // the expansion series; the two names score 0.571, which no safe similarity
    // threshold reaches. They share the code DLR, and that is what resolves it.
    expectSameSet("pokemon-tcg", "ME06: Delta Reign", "Mega Evolution—Delta Reign");
  });

  it("pairs all three Pokémon origins on Pitch Black", () => {
    // tcgplayer (RETAILER) + bulbapedia (COMMUNITY) + wikipedia (COMMUNITY).
    // Bulbapedia derives from pokemon-official and Wikipedia does not, so this
    // set carries two genuinely independent observations even before the
    // retailer is counted.
    expectSameSet("pokemon-tcg", "ME05: Pitch Black", "Mega Evolution—Pitch Black");
    expectSameSet("pokemon-tcg", "ME05: Pitch Black", "Mega Evolution–Pitch Black");

    const group = forGame("pokemon-tcg").members.get(forGame("pokemon-tcg").setOf.get("ME05: Pitch Black") as string);
    expect(new Set(group?.map((candidate) => candidate.origin))).toEqual(
      new Set(["tcgplayer", "bulbapedia", "wikipedia"]),
    );
  });

  it("pairs a bare code prefix against a full expansion-series name", () => {
    // "ME:" carries no digits, so it is not a code -- this one is resolved by
    // the name tier comparing the segment after the separator.
    expectSameSet("pokemon-tcg", "ME: 30th Celebration", "30th Celebration");
  });

  it("pairs the Riftbound sets Wikipedia and TCGplayer both list", () => {
    for (const name of ["Legacy", "Radiance", "Vendetta"]) {
      const group = forGame("riftbound").members.get(forGame("riftbound").setOf.get(name) as string);
      expect(hasIndependentAgreement(group ?? []), `${name} should have two independent origins`).toBe(true);
    }
  });

  it("pairs Yu-Gi-Oh! across TCGplayer and YGOPRODeck by set code", () => {
    for (const name of ["Beyond the Brave", "Chaos Origins", "Magnificent Maestros", "Ultimate Tournament Pack 1"]) {
      const group = forGame("yugioh-tcg").members.get(forGame("yugioh-tcg").setOf.get(name) as string);
      expect(hasIndependentAgreement(group ?? []), `${name} should have two independent origins`).toBe(true);
    }
  });

  it("pairs Magic's differently-worded Commander and supplemental sets", () => {
    // Scryfall says "Star Trek Commander", TCGplayer says "Commander: Star
    // Trek", Wikipedia says neither about this one. All three vocabularies
    // agree on the three-letter Wizards code.
    expectSameSet("magic-the-gathering", "Commander: Star Trek", "Star Trek Commander");
    expectSameSet("magic-the-gathering", "Star Trek: Stardates", "Stardates");
    // v1's canonical identity failure, quoted in identity.ts's own header.
    expectSameSet("magic-the-gathering", "Secret Lair x MSCHF: The Zeta Set", "The Zeta Set");
  });
});

// ---------------------------------------------------------------------------
// The other direction: things that must NOT have merged
// ---------------------------------------------------------------------------

describe("real fixtures: products that must stay distinct", () => {
  it("keeps all nine POP Series sets apart despite one shared abbreviation", () => {
    // tcgcsv gives every POP Series release the abbreviation "POP". A code that
    // one origin hands to nine products is not an identifier, and
    // collectAmbiguousCodes is what notices.
    const ids = new Set(
      Array.from({ length: 9 }, (_, index) => forGame("pokemon-tcg").setOf.get(`POP Series ${index + 1}`)),
    );
    expect(ids.size).toBe(9);
  });

  it("keeps the four Pokémon sets sharing the abbreviation PR apart", () => {
    const names = ["EX Trainer Kit 1: Latias & Latios", "EX Trainer Kit 2: Plusle & Minun", "Nintendo Promos", "Alternate Art Promos"];
    const ids = new Set(names.map((name) => forGame("pokemon-tcg").setOf.get(name)));
    expect(ids.size).toBe(4);
  });

  it("keeps a set apart from its own Classic Collection", () => {
    // Both carry the abbreviation 30C and their names differ by one word. The
    // tail comparison is exact-only precisely so this pair does not merge while
    // "ME: 30th Celebration" / "30th Celebration" does.
    expectDifferentSets("pokemon-tcg", "ME: 30th Celebration Classic Collection", "30th Celebration");
  });

  it("keeps a set apart from its Commander and Art Series siblings", () => {
    // Phase 2's resolver fused seven Marvel candidates into one ProductSet at
    // similarity 0.86. The set codes (MSH / MSC / AAMSH) disagree, and a code
    // disagreement vetoes a name match however good it looks.
    expectDifferentSets("magic-the-gathering", "Marvel Super Heroes", "Commander: Marvel Super Heroes");
    expectDifferentSets("magic-the-gathering", "Marvel Super Heroes", "Art Series: Marvel Super Heroes");
    expectDifferentSets("magic-the-gathering", "Star Trek", "Commander: Star Trek");
    expectDifferentSets("magic-the-gathering", "The Hobbit", "Art Series: The Hobbit");
    expectDifferentSets("magic-the-gathering", "The Hobbit", "The Hobbit: Eternal-Legal");
    expectDifferentSets("magic-the-gathering", "Secret Lair Drop Series", "Secret Lair Series");
  });

  it("keeps a One Piece set apart from its release-event cards", () => {
    expectDifferentSets(
      "one-piece-tcg",
      "The World's Strongest Warriors",
      "The World's Strongest Warriors Release Event Cards",
    );
    expectDifferentSets("one-piece-tcg", "The Dominance of God", "The Dominance of God Release Event Cards");
  });

  it("keeps a Gundam booster apart from the deck box named after it", () => {
    expectDifferentSets("gundam-card-game", "Freedom Ascension", "Deck Build Box Freedom Ascension");
  });

  it("keeps Wikipedia's placeholder Riftbound set names apart", () => {
    expectDifferentSets("riftbound", "Set 8", "Set 9");
  });

  it("keeps the six sequential One Piece starter decks apart", () => {
    const ids = new Set(
      forGame("one-piece-tcg")
        .candidates.filter((candidate) => candidate.name.startsWith("Starter Deck 3"))
        .map((candidate) => forGame("one-piece-tcg").setOf.get(candidate.name)),
    );
    expect(ids.size).toBe(6); // ST-31 through ST-36
  });
});

// ---------------------------------------------------------------------------
// The headline number
// ---------------------------------------------------------------------------

describe("real fixtures: cross-origin pairing rate per game", () => {
  /**
   * How many ProductSets in each game carry claims from two origins the gate
   * would treat as independent -- i.e. how many could publish under G2 rather
   * than waiting out G3's seven-run retailer streak.
   *
   * These are exact expectations rather than floors on purpose: a number moving
   * in *either* direction is worth a human look. Up may mean a better matcher
   * or may mean a false merge; down means a game quietly lost corroboration.
   *
   * `paired` counts sets, `sets` is the total the game resolved to. The "before"
   * column in the comments is Phase 2's resolver measured the same way, on the
   * same fixtures.
   */
  const EXPECTED: Record<string, { candidates: number; sets: number; paired: number }> = {
    // 2 paired before; unchanged. Both Lorcana pairings were plain exact-name
    // matches that never needed help.
    "disney-lorcana": { candidates: 6, sets: 4, paired: 2 },
    // 0 before, 0 now: tcgplayer is this game's only origin. Task B's publisher
    // provider is the only thing that can move this.
    "gundam-card-game": { candidates: 10, sets: 10, paired: 0 },
    // 8 -> 11, and 50 -> 55 sets: three of the new pairings are Wikipedia rows
    // that now find their set by code, and the five extra sets are false merges
    // the code veto took apart.
    "magic-the-gathering": { candidates: 73, sets: 55, paired: 11 },
    // 0 before, 0 now, same reason as Gundam.
    "one-piece-tcg": { candidates: 14, sets: 14, paired: 0 },
    // 2 -> 3, and the two that already paired now pull in the retailer too.
    "pokemon-tcg": { candidates: 28, sets: 24, paired: 3 },
    "riftbound": { candidates: 10, sets: 7, paired: 3 },
    "yugioh-tcg": { candidates: 40, sets: 32, paired: 8 },
  };

  for (const game of GAMES) {
    it(`${game} resolves to a stable set count and pairing rate`, () => {
      const { members, candidates } = forGame(game);
      const paired = [...members.values()].filter(hasIndependentAgreement).length;
      expect({ candidates: candidates.length, sets: members.size, paired }).toEqual(EXPECTED[game]);
    });
  }

  it("gives every game with two origins at least one G2-capable pairing", () => {
    // The negative form of the same statement, and the one that would have
    // caught the original bug: before the code tier Pokémon had three origins
    // and still could not corroborate its flagship set.
    for (const game of GAMES) {
      const origins = new Set(forGame(game).candidates.map((candidate) => candidate.origin));
      if (origins.size < 2) continue;
      const paired = [...forGame(game).members.values()].filter(hasIndependentAgreement).length;
      expect(paired, `${game} has ${origins.size} origins but no cross-origin pairing`).toBeGreaterThan(0);
    }
  });
});

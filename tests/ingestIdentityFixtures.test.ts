import { describe, expect, it } from "vitest";
import {
  collectAmbiguousCodes,
  resolveSetIdentity,
  type ExistingProductSet,
  type SetIdentityRecord,
} from "@/lib/ingest/identity";
import { bandaiGundamProvider } from "@/lib/ingest/providers/bandaiGundam";
import { bandaiOnePieceProvider } from "@/lib/ingest/providers/bandaiOnePiece";
import { bulbapediaProvider } from "@/lib/ingest/providers/bulbapedia";
import { scryfallProvider } from "@/lib/ingest/providers/scryfall";
import { tcgcsvProvider } from "@/lib/ingest/providers/tcgcsv";
import { wikipediaProvider } from "@/lib/ingest/providers/wikipedia";
import { ygoprodeckProvider } from "@/lib/ingest/providers/ygoprodeck";
import { evaluateGate } from "@/lib/ingest/gate";
import { eventGroupKey } from "@/lib/ingest/orchestrate";
import { ORIGINS, originsAreIndependent, type Candidate, type ClaimRecord, type Origin } from "@/lib/ingest/types";
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
  [bandaiGundamProvider, "bandaiGundam.pages.json"],
  [bandaiOnePieceProvider, "bandaiOnePiece.pages.json"],
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
  /** Candidate -> the ProductSet id it resolved to, by identity rather than by name. */
  setOfCandidate: Map<Candidate, string>;
};

/**
 * Reproduces lib/ingest/orchestrate.ts's resolveInstallCandidates: resolve each
 * candidate in turn, create a set when nothing matches, and extend the
 * in-memory context so later candidates in the same batch can find it.
 *
 * SHELF events only. A PRERELEASE candidate is the same product under a
 * different event type, so counting it would double-count the pairing.
 */
function resolveGame(all: Candidate[], game: string, shelfOnly = true): ResolvedGame {
  const candidates = all.filter(
    (candidate) => candidate.game === game && (!shelfOnly || candidate.type === "SHELF"),
  );
  const sets: ExistingProductSet[] = [];
  const identities: SetIdentityRecord[] = [];
  const ambiguousCodes = collectAmbiguousCodes(candidates);

  const members = new Map<string, Candidate[]>();
  const setOf = new Map<string, string>();
  const setOfCandidate = new Map<Candidate, string>();
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
    setOfCandidate.set(candidate, productSetId);
  }

  return { members, setOf, candidates, setOfCandidate };
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

  it("pairs the Bandai publisher pages against the retailer, which is what makes G1 reachable", () => {
    // Bandai and TCGplayer agree on almost nothing textually -- "BOOSTER PACK
    // -THE WORLD'S STRONGEST WARRIORS-" against "The World's Strongest
    // Warriors", "Heavy Dominion" against "Starter Deck 14: Heavy Dominion" --
    // and on the set code exactly. Without the code tier these providers would
    // have doubled One Piece's and Gundam's ProductSet count instead of
    // corroborating it.
    expectSameSet("one-piece-tcg", "BOOSTER PACK -THE WORLD’S STRONGEST WARRIORS-", "The World's Strongest Warriors");
    expectSameSet("one-piece-tcg", "STARTER DECK -BLUE Kuzan-", "Starter Deck 33: BLUE Kuzan");
    expectSameSet(
      "one-piece-tcg",
      "EXTRA BOOSTER -ONE PIECE HEROINES EDITION vol.2-",
      "Extra Booster: One Piece Heroine's Edition Vol. 2",
    );
    expectSameSet("gundam-card-game", "Heavy Dominion", "Starter Deck 14: Heavy Dominion");
    expectSameSet("gundam-card-game", "Stardust Trails", "Stardust Trails");
  });

  it("puts an OFFICIAL claim on the games that had none, so G1 can fire", () => {
    for (const game of ["one-piece-tcg", "gundam-card-game"] as const) {
      const origins = new Set(forGame(game).candidates.map((candidate) => candidate.origin));
      expect(origins, game).toContain("bandai-official");
      // ...and on the same ProductSet as the retailer, not beside it. A
      // publisher claim on a set of its own would publish a duplicate event
      // under G1 rather than confirming the one already on the calendar.
      const publisherSets = forGame(game)
        .candidates.filter((candidate) => candidate.origin === "bandai-official")
        .map((candidate) => forGame(game).setOf.get(candidate.name) as string);
      const shared = publisherSets.filter((id) =>
        (forGame(game).members.get(id) ?? []).some((candidate) => candidate.origin === "tcgplayer"),
      );
      expect(shared.length, `${game}: publisher sets also claimed by the retailer`).toBeGreaterThanOrEqual(6);
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
  it("never sees TCGplayer's catalogue buckets at all", () => {
    // These used to be the file's showcase for collectAmbiguousCodes: tcgcsv
    // gives all nine POP Series releases the abbreviation "POP" and four
    // unrelated promo pools "PR", and the resolver had to keep thirteen
    // products apart on names alone.
    //
    // It still can -- that rule is pinned directly in ingestIdentity.test.ts --
    // but the resolver is no longer asked to. None of these is a dated product;
    // every one carries a crawl timestamp where a release date would be, and
    // tcgcsv.ts now drops such a group rather than admitting it as a dateless
    // candidate. The strongest thing this file can say about them is that they
    // never reach identity resolution in the first place.
    const bucketed = [
      ...Array.from({ length: 9 }, (_, index) => `POP Series ${index + 1}`),
      "EX Trainer Kit 1: Latias & Latios",
      "EX Trainer Kit 2: Plusle & Minun",
      "Nintendo Promos",
      "Alternate Art Promos",
    ];
    const { setOf } = forGame("pokemon-tcg");
    for (const name of bucketed) expect(setOf.has(name)).toBe(false);
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
    // "Secret Lair Drop Series" / "Secret Lair Series" used to sit here too.
    // Both are evergreen TCGplayer pools with a crawl timestamp for a date, so
    // neither reaches the resolver any more -- see the catalogue-bucket test
    // above.
  });

  it("does not admit One Piece release-event card pools as products at all", () => {
    // They used to be kept apart from their booster; since 2026-09-20 they never
    // reach the resolver (tcgcsv.ts's PRERELEASE_CARD_POOL_GAMES), because a pool
    // is stamped a week before its set and was showing up as a shelf release.
    const { setOf } = forGame("one-piece-tcg");
    expect(setOf.get("The World's Strongest Warriors Release Event Cards")).toBeUndefined();
    expect(setOf.get("The Dominance of God Release Event Cards")).toBeUndefined();
    // ...while the boosters they accompany are untouched.
    expect(setOf.get("The World's Strongest Warriors")).toBeDefined();
    expect(setOf.get("The Dominance of God")).toBeDefined();
  });

  it("keeps a Gundam booster apart from the deck box named after it", () => {
    expectDifferentSets("gundam-card-game", "Freedom Ascension", "Deck Build Box Freedom Ascension");
  });

  it("keeps Wikipedia's placeholder Riftbound set names apart", () => {
    expectDifferentSets("riftbound", "Set 8", "Set 9");
  });

  it("emits none of the three placeholder-named Magic rows, so they cannot fuse", () => {
    // The pre-existing false merge phase 3 named and did not touch. Three
    // separate rows on Wikipedia's Magic list read "Unnamed Universes Beyond
    // Set"; all three carry "TBA" in the code column, so mediawiki.ts's
    // `${page}:${code ?? name}` external id was byte-identical for all three and
    // they collapsed onto one ProductSet.
    //
    // The fix refuses the rows rather than inventing per-row ids for them. Row
    // index is the only per-row key the page offers and it is not stable: the
    // placeholders are interleaved between dated rows, so naming one of them
    // re-indexes the rest and would silently re-point three ProductSets at each
    // other's ids. And the rows are worth nothing anyway -- no name, no code, no
    // date.
    const names = forGame("magic-the-gathering").candidates.map((candidate) => candidate.name);
    expect(names).not.toContain("Unnamed Universes Beyond Set");
  });

  it("keeps three placeholder-named rows on three ProductSets if a provider ever does emit them", () => {
    // Belt and braces for the rule above, at the identity layer rather than the
    // provider layer, because the provider refusal is the only thing standing
    // between these rows and the merge and it should not be the only thing.
    const rows: Candidate[] = [1, 2, 3].map((index) => ({
      origin: "wikipedia",
      game: "magic-the-gathering",
      externalIds: { wikipedia: `wp-mtg-sets:slot-${index}` },
      name: "Unnamed Universes Beyond Set",
      code: null,
      date: { kind: "TBD" },
      region: "GLOBAL",
      type: "SHELF",
    }));

    const resolved = resolveGame(rows, "magic-the-gathering");
    expect(resolved.members.size).toBe(3);
  });

  it("does not treat an un-set as an unnamed one", () => {
    // The placeholder-name rule is a prefix match on "Unnamed"/"Untitled"/..., so
    // it has to stop at a word boundary: Unglued, Unhinged, Unstable,
    // Unsanctioned and Unfinity are real Magic products.
    for (const name of ["Unglued", "Unhinged", "Unstable", "Unsanctioned", "Unfinity"]) {
      const resolved = resolveGame(
        [
          {
            origin: "wikipedia",
            game: "magic-the-gathering",
            externalIds: {},
            name,
            code: null,
            date: { kind: "TBD" },
            region: "GLOBAL",
            type: "SHELF",
          },
        ],
        "magic-the-gathering",
      );
      const only = [...resolved.members.values()][0];
      expect(only?.[0]?.name, name).toBe(name);
    }
  });
});

// ---------------------------------------------------------------------------
// Region: the phase-4 event key
// ---------------------------------------------------------------------------

describe("real fixtures: region as part of the event key", () => {
  /**
   * Every event this run would create, keyed exactly as the pipeline keys them.
   *
   * PRERELEASE candidates are included here (unlike the pairing counts above,
   * which are SHELF-only to avoid double-counting a product): the question this
   * section asks is "how many *events*", and a prerelease is one.
   */
  function eventsFor(game: (typeof GAMES)[number]): Map<string, { region: string; type: string }> {
    const resolved = resolveGame(ALL, game, false);
    const events = new Map<string, { region: string; type: string }>();
    for (const candidate of resolved.candidates) {
      const productSetId = resolved.setOfCandidate.get(candidate);
      if (!productSetId) continue;
      events.set(eventGroupKey(productSetId, candidate.type, candidate.region), {
        region: candidate.region,
        type: candidate.type,
      });
    }
    return events;
  }

  /**
   * Events per game, split by region, from the recorded 2026-09-04 payloads.
   *
   * Exact rather than a floor, for the same reason the pairing table above is:
   * a number that moves in either direction wants a human glance. JP appears for
   * Pokemon alone today, because Bulbapedia's Japanese expansion list is the
   * only non-GLOBAL source wired up -- Bandai's Japanese sites are noted as
   * deferred in bandaiOnePiece.ts.
   */
  const EXPECTED_EVENTS: Record<string, Record<string, number>> = {
    // 4 SHELF + 3 PRERELEASE: Wikipedia's Lorcana table splits "Local game
    // store release" from "Retail release", which is a type split, not a region
    // one -- worth stating because it was on phase 4's list and turned out to
    // need nothing.
    "disney-lorcana": { GLOBAL: 7 },
    "gundam-card-game": { GLOBAL: 10 },
    // 56 -> 20, 24 -> 5 and 32 -> 14: tcgcsv.ts now drops a group whose
    // publishedOn is a crawl timestamp rather than admitting it as a dateless
    // candidate, and those three games are where TCGplayer keeps its evergreen
    // promo and box-set pools. Every event removed was one with no date and no
    // prospect of one. The three games with no such pools are untouched.
    "magic-the-gathering": { GLOBAL: 20 },
    "one-piece-tcg": { GLOBAL: 13 },
    "pokemon-tcg": { GLOBAL: 5, JP: 2 },
    riftbound: { GLOBAL: 7 },
    "yugioh-tcg": { GLOBAL: 14 },
  };

  for (const game of GAMES) {
    it(`${game} resolves to a stable event count per region`, () => {
      const counts: Record<string, number> = {};
      for (const event of eventsFor(game).values()) {
        counts[event.region] = (counts[event.region] ?? 0) + 1;
      }
      expect(counts).toEqual(EXPECTED_EVENTS[game]);
    });
  }

  it("gives Delta Reign a Japanese event and a global one, on the same product", () => {
    // The concrete case phase 2 and phase 3 both deferred. Bulbapedia's English
    // list dates Delta Reign 2026-11-06; its Japanese list dates the same
    // product (as "Storm Emeralda", English equivalent "Delta Reign")
    // 2026-07-31. Ninety-eight days apart.
    const resolved = resolveGame(ALL, "pokemon-tcg", false);
    const deltaReign = resolved.candidates.filter(
      (candidate) => resolved.setOfCandidate.get(candidate) === resolved.setOf.get("Mega Evolution—Delta Reign"),
    );

    const jp = deltaReign.filter((candidate) => candidate.region === "JP");
    const global = deltaReign.filter((candidate) => candidate.region === "GLOBAL");
    expect(jp.length, "the Japanese list should reach the same product").toBe(1);
    expect(global.length).toBeGreaterThan(0);
    expect(jp[0].date).toEqual({ kind: "EXACT", date: new Date("2026-07-31T00:00:00.000Z") });

    // One ProductSet, two events -- which is the whole point.
    const keys = new Set(
      deltaReign.map((candidate) =>
        eventGroupKey(resolved.setOfCandidate.get(candidate) as string, candidate.type, candidate.region),
      ),
    );
    expect(keys.size).toBe(2);
  });

  it("publishes Delta Reign's global date only because the Japanese one is on its own event", () => {
    // The counterfactual, stated as a test so the reason for the change cannot
    // quietly stop being true.
    //
    // A claim is stored per (run, origin, event) -- see ingestRepo's
    // upsertIngestClaim -- so before region joined the event key, Bulbapedia's
    // English row and its Japanese row for one product shared a single claim
    // slot and the later write silently replaced the earlier. What the gate then
    // saw was TCGplayer on 2026-11-06 against "Bulbapedia" on 2026-07-31: no
    // agreement, no G2, and the flagship set's date never published at all.
    const resolved = resolveGame(ALL, "pokemon-tcg", false);
    const setId = resolved.setOf.get("Mega Evolution—Delta Reign") as string;
    const shelf = resolved.candidates.filter(
      (candidate) => resolved.setOfCandidate.get(candidate) === setId && candidate.type === "SHELF",
    );

    const asClaim = (candidate: Candidate): ClaimRecord => ({
      origin: candidate.origin,
      tier: ORIGINS[candidate.origin as keyof typeof ORIGINS]?.tier ?? "COMMUNITY",
      date: candidate.date,
      consecutiveRuns: 1,
      seenInCurrentRun: true,
      lastSeenAt: FETCHED_AT,
    });

    // One claim slot per origin, last write wins -- the pre-phase-4 shape.
    const fusedByOrigin = new Map<Origin, ClaimRecord>();
    for (const candidate of shelf) fusedByOrigin.set(candidate.origin, asClaim(candidate));
    const fused = evaluateGate({ now: FETCHED_AT, claims: [...fusedByOrigin.values()], published: null });
    expect(fused.action).toBe("HOLD");
    expect(fused.date).toBeNull();

    // Region-scoped, as the pipeline now does it: the global event publishes on
    // G2 (TCGplayer and Bulbapedia agreeing), and the Japanese event carries its
    // own date without arguing with it.
    const global = shelf.filter((candidate) => candidate.region === "GLOBAL").map(asClaim);
    const globalVerdict = evaluateGate({ now: FETCHED_AT, claims: global, published: null });
    expect(globalVerdict.action).toBe("PUBLISH");
    expect(globalVerdict.rule).toBe("G2");
    expect(globalVerdict.date).toEqual({ kind: "EXACT", date: new Date("2026-11-06T00:00:00.000Z") });

    const jp = shelf.filter((candidate) => candidate.region === "JP").map(asClaim);
    const jpVerdict = evaluateGate({ now: FETCHED_AT, claims: jp, published: null });
    expect(jpVerdict.action, "a lone-origin region holds, it never conflicts").not.toBe("FLAG");
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
    // 0 paired before the Bandai provider existed, because tcgplayer was the
    // game's only origin. All six of the publisher's in-window products pair.
    "gundam-card-game": { candidates: 16, sets: 10, paired: 6 },
    // 8 -> 11, and 50 -> 55 sets: three of the new pairings are Wikipedia rows
    // that now find their set by code, and the five extra sets are false merges
    // the code veto took apart. Phase 4 then dropped three candidates and one
    // set: Wikipedia's three "Unnamed Universes Beyond Set" rows, which shared
    // a placeholder name, a "TBA" code and therefore one external id, and had
    // fused into a single contentless ProductSet.
    //
    // Then 70 -> 34 candidates and 54 -> 18 sets, when tcgcsv.ts stopped
    // admitting its crawl-timestamped catalogue pools. **`paired` did not
    // move** -- here or for Pokemon or Yu-Gi-Oh! -- and that is the number
    // worth watching: every set this removed was one no second origin had ever
    // corroborated, because there was no release for a second origin to
    // corroborate. The catalogue lost two thirds of its rows and none of its
    // evidence.
    "magic-the-gathering": { candidates: 34, sets: 18, paired: 11 },
    // 0 before, same reason as Gundam. Ten of the publisher's eleven in-window
    // products pair; the eleventh (Double Pack Set Vol.12) is one TCGplayer
    // does not carry.
    "one-piece-tcg": { candidates: 23, sets: 13, paired: 10 },
    // 2 -> 3, and the two that already paired now pull in the retailer too.
    // Phase 4 added two candidates and no sets: the Japanese expansion list's
    // two in-window rows both resolved onto the English product they name,
    // through the Bulbapedia article link both pages carry. Two extra
    // candidates landing on zero extra sets is the whole claim of that change.
    "pokemon-tcg": { candidates: 11, sets: 5, paired: 3 },
    "riftbound": { candidates: 10, sets: 7, paired: 3 },
    "yugioh-tcg": { candidates: 22, sets: 14, paired: 8 },
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

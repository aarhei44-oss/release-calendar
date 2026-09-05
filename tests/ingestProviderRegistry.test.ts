import { describe, expect, it } from "vitest";
import { PRODUCTION_PROVIDERS, listProviders, providersForGames } from "@/lib/ingest/providers/registry";
import { ORIGINS, originsAreIndependent, type Origin } from "@/lib/ingest/types";

/**
 * The registry's job is not "some providers are registered"; it is that every
 * game has evidence, and that the games we claim are corroborated really do
 * have two origins the gate will accept as independent.
 *
 * That last part is easy to get wrong in a way no other test would catch.
 * Registering Scryfall and Wikipedia for Magic *looks* like two origins, but if
 * either declared the other as an ancestor, gate rule G2 would silently never
 * fire and every Magic date would quietly fall back to G3's seven-run retailer
 * streak. So this file asserts independence through the same
 * `originsAreIndependent` the gate itself calls, against the same ORIGINS
 * registry, rather than counting provider entries.
 */

const GAMES = [
  "pokemon-tcg",
  "magic-the-gathering",
  "yugioh-tcg",
  "disney-lorcana",
  "one-piece-tcg",
  "gundam-card-game",
  "riftbound",
] as const;

function originsFor(game: string): Origin[] {
  return [...new Set(providersForGames([game]).map((provider) => provider.origin))];
}

/** The largest set of mutually independent origins covering this game. */
function independentPairs(game: string): Array<[Origin, Origin]> {
  const origins = originsFor(game);
  const pairs: Array<[Origin, Origin]> = [];
  for (let i = 0; i < origins.length; i++) {
    for (let j = i + 1; j < origins.length; j++) {
      if (originsAreIndependent(origins[i], origins[j], ORIGINS)) pairs.push([origins[i], origins[j]]);
    }
  }
  return pairs;
}

describe("provider registry: registration", () => {
  it("registers every production provider under its own key", () => {
    const registered = listProviders();
    for (const provider of PRODUCTION_PROVIDERS) {
      expect(registered).toContain(provider);
    }
  });

  it("gives every provider a distinct key", () => {
    const keys = PRODUCTION_PROVIDERS.map((provider) => provider.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("declares every provider's origin in ORIGINS, at the tier the gate will use", () => {
    for (const provider of PRODUCTION_PROVIDERS) {
      const descriptor = ORIGINS[provider.origin as keyof typeof ORIGINS];
      expect(descriptor, `origin "${provider.origin}" is not in ORIGINS`).toBeDefined();
      // orchestrate.ts derives a claim's tier from ORIGINS, not from the
      // provider, so a provider whose tier disagreed would be advertising
      // authority the gate never grants it.
      expect(descriptor.tier, `provider "${provider.key}" tier`).toBe(provider.tier);
    }
  });

  it("names only real TcgProfilePackage slugs", () => {
    for (const provider of PRODUCTION_PROVIDERS) {
      for (const game of provider.games) {
        expect(GAMES, `provider "${provider.key}"`).toContain(game);
      }
    }
  });
});

describe("provider registry: per-game coverage", () => {
  it.each(GAMES)("has at least one provider for %s", (game) => {
    expect(providersForGames([game]).length).toBeGreaterThan(0);
  });

  it.each(GAMES)("has two independent origins for %s, so gate rule G2 can fire", (game) => {
    const pairs = independentPairs(game);
    expect(pairs.length, `${game} origins: ${originsFor(game).join(", ")}`).toBeGreaterThan(0);
  });

  it("records the coverage each game actually has", () => {
    // Deliberately an exact assertion rather than a floor: this table is the
    // decision about how much evidence each game gets, and widening or
    // narrowing it should have to come through this test.
    //
    // Riot (Riftbound) and Ravensburger (Lorcana) are absent on purpose. Neither
    // publishes an index page carrying release dates -- Riot's site is news and
    // a "get started" page, Ravensburger states dates only in per-product
    // marketing prose -- and both games already reach G2 on tcgplayer plus
    // Wikipedia, so a fragile parser would buy nothing.
    const coverage = Object.fromEntries(GAMES.map((game) => [game, originsFor(game).sort()]));
    expect(coverage).toEqual({
      "pokemon-tcg": ["bulbapedia", "tcgplayer", "wikipedia"],
      "magic-the-gathering": ["scryfall", "tcgplayer", "wikipedia"],
      "yugioh-tcg": ["tcgplayer", "ygoprodeck"],
      "disney-lorcana": ["tcgplayer", "wikipedia"],
      "riftbound": ["tcgplayer", "wikipedia"],
      "one-piece-tcg": ["bandai-official", "tcgplayer"],
      "gundam-card-game": ["bandai-official", "tcgplayer"],
    });
  });

  it("gives One Piece and Gundam an OFFICIAL origin, which is what rule G1 needs", () => {
    // These were the two single-origin games, publishable only through G3's
    // seven-run retailer streak. An OFFICIAL claim publishes on first sight --
    // and until these providers existed, no origin in the registry was OFFICIAL
    // at all, so G1 was a branch of the gate nothing could reach.
    for (const game of ["one-piece-tcg", "gundam-card-game"] as const) {
      const tiers = providersForGames([game]).map((provider) => provider.tier);
      expect(tiers, `${game}`).toContain("OFFICIAL");
    }
    const officialProviders = PRODUCTION_PROVIDERS.filter((provider) => provider.tier === "OFFICIAL");
    expect(officialProviders.map((provider) => provider.key).sort()).toEqual(["bandai-gundam", "bandai-onepiece"]);
  });

  it("does not count a mirror as corroboration", () => {
    // Scryfall derives from wizards-official; if a wizards-official provider is
    // ever added for Magic, the pair must stop counting as two observations.
    expect(originsAreIndependent("scryfall", "wizards-official", ORIGINS)).toBe(false);
    expect(originsAreIndependent("ygoprodeck", "konami-official", ORIGINS)).toBe(false);
    expect(originsAreIndependent("bulbapedia", "pokemon-official", ORIGINS)).toBe(false);
  });
});

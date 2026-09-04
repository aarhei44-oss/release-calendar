import { bulbapediaProvider } from "./bulbapedia";
import { scryfallProvider } from "./scryfall";
import { tcgcsvProvider } from "./tcgcsv";
import type { Provider } from "./types";
import { wikipediaProvider } from "./wikipedia";
import { ygoprodeckProvider } from "./ygoprodeck";

/**
 * The provider registry.
 *
 * A Map rather than a plain object because tests need a seam to register a fake
 * (mirroring lib/crawler/adapters/registry.ts's registerAdapter), and because
 * registration by key makes "replace this provider" a one-liner.
 *
 * Registration happens here rather than in each provider module: a provider
 * that registered itself on import would have to import this file, and this
 * file imports the providers, which is an import cycle. Listing them here also
 * makes the production set of origins readable in one place.
 *
 * Per-game origin coverage this produces:
 *
 *   pokemon-tcg         tcgplayer, wikipedia, bulbapedia   (3 independent)
 *   magic-the-gathering tcgplayer, wikipedia, scryfall     (3 independent)
 *   yugioh-tcg          tcgplayer, ygoprodeck              (2 independent)
 *   disney-lorcana      tcgplayer, wikipedia               (2 independent)
 *   riftbound           tcgplayer, wikipedia               (2 independent)
 *   one-piece-tcg       tcgplayer                          (1 -- G3 only)
 *   gundam-card-game    tcgplayer                          (1 -- G3 only)
 *
 * One Piece and Gundam are honestly single-origin: neither has a maintained
 * Wikipedia set table, and the community trackers v1 used are ordinary scraped
 * pages rather than sanctioned APIs. Their dates still publish, but only via
 * gate rule G3 -- a lone retailer claim that has held still for seven runs --
 * which is slower and is the correct amount of caution for evidence this thin.
 * tests/ingestProviderRegistry.test.ts asserts this table so a regression in it
 * is a test failure rather than a quiet loss of corroboration.
 */
const registry = new Map<string, Provider>();

export function getProvider(key: string): Provider | undefined {
  return registry.get(key);
}

export function listProviders(): Provider[] {
  return [...registry.values()];
}

/** Providers that serve at least one of the given TcgProfilePackage slugs; all providers when `games` is omitted. */
export function providersForGames(games?: string[]): Provider[] {
  if (!games || games.length === 0) return listProviders();
  const wanted = new Set(games);
  return listProviders().filter((provider) => provider.games.some((game) => wanted.has(game)));
}

/**
 * Registers a provider. Phase 2's providers will call this at module load;
 * tests use it to install a fake. Registering the same key twice replaces the
 * earlier entry, so a test fake reliably wins over a production provider of
 * the same key.
 */
export function registerProvider(provider: Provider): void {
  registry.set(provider.key, provider);
}

/** Test-only: drops a registration again, so one test file's fake cannot leak into another's expectations. */
export function unregisterProvider(key: string): void {
  registry.delete(key);
}

/** The production providers, registered at import time. */
export const PRODUCTION_PROVIDERS: readonly Provider[] = [
  tcgcsvProvider,
  scryfallProvider,
  ygoprodeckProvider,
  wikipediaProvider,
  bulbapediaProvider,
];

for (const provider of PRODUCTION_PROVIDERS) {
  registerProvider(provider);
}

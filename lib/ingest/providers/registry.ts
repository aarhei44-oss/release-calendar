import { bandaiGundamProvider } from "./bandaiGundam";
import { bandaiOnePieceProvider } from "./bandaiOnePiece";
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
 *   pokemon-tcg         tcgplayer, wikipedia, bulbapedia   (3 independent, G2)
 *   magic-the-gathering tcgplayer, wikipedia, scryfall     (3 independent, G2)
 *   yugioh-tcg          tcgplayer, ygoprodeck              (2 independent, G2)
 *   disney-lorcana      tcgplayer, wikipedia               (2 independent, G2)
 *   riftbound           tcgplayer, wikipedia               (2 independent, G2)
 *   one-piece-tcg       tcgplayer, bandai-official         (2, and G1)
 *   gundam-card-game    tcgplayer, bandai-official         (2, and G1)
 *
 * The two Bandai entries are the pipeline's first OFFICIAL-tier origins, which
 * makes them the first providers whose claims satisfy gate rule G1 -- one
 * official source is enough on its own. Before them One Piece and Gundam had
 * tcgcsv alone and could only publish through G3's seven-run retailer streak;
 * they are also, as the only OFFICIAL providers, what turns G1 from an untested
 * branch of the gate into live code.
 *
 * Riot (Riftbound) and Ravensburger (Lorcana) are deliberately absent. Neither
 * publishes an index page carrying release dates: Riot's site is news and a
 * "get started" page, and Ravensburger states dates only in marketing prose on
 * ~28 individual product pages, with labels that disagree with the retailer's
 * street date by a week. Both games already have two independent origins and
 * publish under G2, so a fragile parser would be buying nothing. See
 * tests/ingestProviderRegistry.test.ts, which asserts this table so a
 * regression in it is a test failure rather than a quiet loss of corroboration.
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
  bandaiOnePieceProvider,
  bandaiGundamProvider,
];

for (const provider of PRODUCTION_PROVIDERS) {
  registerProvider(provider);
}

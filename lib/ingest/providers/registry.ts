import { bandaiDigimonProvider } from "./bandaiDigimon";
import { bandaiGundamProvider } from "./bandaiGundam";
import { bandaiOnePieceProvider } from "./bandaiOnePiece";
import { bandaiUnionArenaProvider } from "./bandaiUnionArena";
import { bulbapediaProvider } from "./bulbapedia";
import { playriftboundProvider } from "./playriftbound";
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
 *   riftbound           tcgplayer, wikipedia, riot-official (3, and G1)
 *   one-piece-tcg       tcgplayer, bandai-official         (2, and G1)
 *   gundam-card-game    tcgplayer, bandai-official         (2, and G1)
 *   union-arena-tcg     tcgplayer, bandai-official         (2, and G1)
 *   digimon-card-game   tcgplayer, bandai-official         (2, and G1)
 *   flesh-and-blood     tcgplayer, wikipedia               (2, G2)
 *
 * Flesh and Blood's own site (fabtcg.com) would be its OFFICIAL origin, but it
 * answers 403 to every non-browser request, including from the production
 * droplet, so Wikipedia's set table is the second origin instead.
 *
 * The Bandai entries and playriftbound are the pipeline's OFFICIAL-tier
 * origins, which makes them the only providers whose claims satisfy gate rule
 * G1 -- one official source is enough on its own. Before the Bandai providers,
 * One Piece and Gundam had tcgcsv alone and could only publish through G3's
 * seven-run retailer streak; they were also what first turned G1 from an
 * untested branch of the gate into live code.
 *
 * Ravensburger (Lorcana) is still deliberately absent: it states dates only in
 * marketing prose on ~28 individual product pages, with labels that disagree
 * with the retailer's street date by a week, and the game already has two
 * independent origins publishing under G2 -- a fragile parser would buy
 * nothing. Riot (Riftbound) used to be absent for the same kind of reason
 * (its site read as news and a "get started" page), but its
 * `/en-us/news/announcements/` turned out to publish exactly the one thing no
 * other Riftbound origin carries -- a "Pre-Rift" prerelease date -- in a
 * genuinely consistent shape; see playriftbound.ts for why. See
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
  playriftboundProvider,
  bandaiUnionArenaProvider,
  bandaiDigimonProvider,
];

for (const provider of PRODUCTION_PROVIDERS) {
  registerProvider(provider);
}

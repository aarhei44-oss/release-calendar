import type { Provider } from "./types";

/**
 * The provider registry.
 *
 * Deliberately empty in phase 1 -- real providers (TCGplayer, Scryfall,
 * YGOPRODeck, the publishers' own feeds) land in phase 2. The lookup shape
 * exists now so that the orchestrator, replay and their tests can be written
 * and exercised against it rather than being blocked on the first provider,
 * and so that a provider added later needs no changes anywhere else.
 *
 * A Map rather than a plain object because registration happens at import
 * time from several modules, and because tests need a seam to register a fake
 * (mirroring lib/crawler/adapters/registry.ts's registerAdapter).
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

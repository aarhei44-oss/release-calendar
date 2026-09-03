import type { ParserAdapter } from "./types";
import { htmlTableAdapter } from "./htmlTableAdapter";
import { fixtureAdapter } from "./fixtureAdapter";

const registry = new Map<string, ParserAdapter>([
  [htmlTableAdapter.key, htmlTableAdapter],
  [fixtureAdapter.key, fixtureAdapter],
]);

export function getAdapter(key: string): ParserAdapter | undefined {
  return registry.get(key);
}

/** Test-only seam: registers an extra adapter (e.g. a custom-HTML fixture variant) without touching the two production entries above. */
export function registerAdapter(adapter: ParserAdapter): void {
  registry.set(adapter.key, adapter);
}

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

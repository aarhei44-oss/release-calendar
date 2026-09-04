import type { Candidate, RawPayloadRecord } from "../types";
import { fetchWikiPages, parseWikiPayload, type WikiPageSpec } from "./mediawiki";
import type { FetchContext, Provider } from "./types";

/**
 * English Wikipedia's set-list articles, via the MediaWiki API.
 *
 * Four games, chosen from the pages v1 already relied on (prisma/seed.ts's
 * source lists): Pokémon, Magic, Lorcana and Riftbound. Yu-Gi-Oh! is
 * deliberately absent -- Wikipedia has no maintained set table for it, and
 * YGOPRODeck already gives that game its second origin.
 *
 * Origin `wikipedia`, tier COMMUNITY, `derivesFrom: null`. That null is what
 * makes this provider valuable rather than decorative: it means Wikipedia
 * agreeing with TCGplayer is two independent observations, which is gate rule
 * G2, which is the difference between a date publishing this run and a date
 * waiting seven runs for G3.
 *
 * For Pokémon it is doing something more specific. Pokémon's only other source
 * is tcgcsv; without Wikipedia and Bulbapedia the game has a single origin and
 * *cannot* satisfy G2 at all.
 */

const PROVIDER_KEY = "wikipedia";
const API_URL = "https://en.wikipedia.org/w/api.php";

export const WIKIPEDIA_PAGES: readonly WikiPageSpec[] = [
  {
    key: "wp-pokemon-sets",
    apiUrl: API_URL,
    pageUrl: "https://en.wikipedia.org/wiki/List_of_Pok%C3%A9mon_Trading_Card_Game_sets",
    title: "List of Pokémon Trading Card Game sets",
    game: "pokemon-tcg",
    region: "GLOBAL",
    // The era tables here are ["Generation Set No.", "Name", "Release date",
    // "Details"]; "name" must not be widened to "set", which would match the
    // set-number column instead (the same trap prisma/seed.ts documents for
    // v1's html-table adapter).
    nameHeaders: ["name"],
    dateHeaders: ["releasedate"],
  },
  {
    key: "wp-mtg-sets",
    apiUrl: API_URL,
    pageUrl: "https://en.wikipedia.org/wiki/List_of_Magic:_The_Gathering_sets",
    title: "List of Magic: The Gathering sets",
    game: "magic-the-gathering",
    region: "GLOBAL",
    nameHeaders: ["set"],
    dateHeaders: ["releasedate"],
    codeHeaders: ["expansioncode", "setcode", "code"],
    prereleaseDateHeaders: ["prereleasedate"],
  },
  {
    key: "wp-lorcana",
    apiUrl: API_URL,
    pageUrl: "https://en.wikipedia.org/wiki/Disney_Lorcana",
    title: "Disney Lorcana",
    game: "disney-lorcana",
    region: "GLOBAL",
    nameHeaders: ["setname"],
    // "Retail release" is the street date; "Local game store release" is the
    // week-early LGS window, which becomes a PRERELEASE event rather than
    // competing with the shelf date.
    dateHeaders: ["retailrelease"],
    prereleaseDateHeaders: ["localgamestorerelease"],
  },
  {
    key: "wp-riftbound",
    apiUrl: API_URL,
    pageUrl: "https://en.wikipedia.org/wiki/Riftbound",
    title: "Riftbound",
    game: "riftbound",
    region: "GLOBAL",
    nameHeaders: ["setname"],
    dateHeaders: ["releasedate"],
    codeHeaders: ["setcode"],
  },
];

export const wikipediaProvider: Provider = {
  key: PROVIDER_KEY,
  origin: "wikipedia",
  tier: "COMMUNITY",
  games: [...new Set(WIKIPEDIA_PAGES.map((page) => page.game))],
  fetch: (ctx: FetchContext) => fetchWikiPages(PROVIDER_KEY, WIKIPEDIA_PAGES, ctx),
  parse: (payload: RawPayloadRecord): Candidate[] =>
    parseWikiPayload({ providerKey: PROVIDER_KEY, origin: "wikipedia", specs: WIKIPEDIA_PAGES, payload }),
};

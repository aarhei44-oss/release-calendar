import type { Candidate, RawPayloadRecord } from "../types";
import { fetchWikiPages, parseWikiPayload, type WikiPageSpec } from "./mediawiki";
import type { FetchContext, Provider } from "./types";

/**
 * Bulbapedia's expansion list, via the MediaWiki API.
 *
 * Pokémon's second independent origin. Before this provider the game had only
 * tcgcsv, which means gate rule G2 (two independent origins agreeing) could
 * never fire for a Pokémon set and every date had to wait out G3's seven-run
 * retailer streak. Bulbapedia is declared in ORIGINS as deriving from
 * pokemon-official (its tables are transcribed from The Pokémon Company's
 * announcements) but as independent of Wikipedia, so Pokémon now has three
 * mutually independent origins: tcgplayer, wikipedia and bulbapedia.
 *
 * The English page alone is fetched. The Japanese expansion list is
 * deliberately deferred -- see the note at the bottom of this file.
 */

const PROVIDER_KEY = "bulbapedia";
const API_URL = "https://bulbapedia.bulbagarden.net/w/api.php";

export const BULBAPEDIA_PAGES: readonly WikiPageSpec[] = [
  {
    key: "bp-en-expansions",
    apiUrl: API_URL,
    pageUrl: "https://bulbapedia.bulbagarden.net/wiki/List_of_Pok%C3%A9mon_Trading_Card_Game_expansions",
    title: "List of Pokémon Trading Card Game expansions",
    game: "pokemon-tcg",
    region: "GLOBAL",
    // One table per era, ~20 of them, all with these headers. "Set no." also
    // starts with "set", which is why the name hint is pinned to the real
    // column rather than left as a prefix match.
    nameHeaders: ["nameofexpansion"],
    // A handful of the older era tables head the column "Release period"
    // instead; both mean the same thing and parseCandidateDateText handles the
    // coarser text they carry.
    dateHeaders: ["releasedate", "releaseperiod"],
    codeHeaders: ["setabb"],
  },
];

export const bulbapediaProvider: Provider = {
  key: PROVIDER_KEY,
  origin: "bulbapedia",
  tier: "COMMUNITY",
  games: ["pokemon-tcg"],
  fetch: (ctx: FetchContext) => fetchWikiPages(PROVIDER_KEY, BULBAPEDIA_PAGES, ctx),
  parse: (payload: RawPayloadRecord): Candidate[] =>
    parseWikiPayload({ providerKey: PROVIDER_KEY, origin: "bulbapedia", specs: BULBAPEDIA_PAGES, payload }),
};

/**
 * Deferred: "List of Japanese Pokémon Trading Card Game expansions".
 *
 * The page parses cleanly with the same machinery (its tables are headed
 * "Japanese name/Translated name" + "Release date"), so this is not a technical
 * obstacle. It is a modelling one: ReleaseEvents are grouped by
 * (productSet, type) and *not* by region, so a Japanese street date and the
 * global street date for the same expansion would land on one event as two
 * claims 3+ months apart -- which the gate would correctly read as a G5
 * conflict and flag for review, on every Pokémon set, forever. Ingesting the
 * Japanese list needs region to become part of the event key first; that is a
 * pipeline change, not a provider one.
 */

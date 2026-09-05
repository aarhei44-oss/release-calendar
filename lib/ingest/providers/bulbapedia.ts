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
 * Both the English and the Japanese expansion lists are fetched. The Japanese
 * one was deferred through phases 2 and 3 for a modelling reason rather than a
 * technical one -- see the note at the bottom of this file, and BULBAPEDIA_PAGES
 * below for how the two lists are joined.
 */

const PROVIDER_KEY = "bulbapedia";
const API_URL = "https://bulbapedia.bulbagarden.net/w/api.php";

/**
 * The id space the two lists meet in.
 *
 * Not an origin in ORIGINS and never used as one: it is a key into
 * `Candidate.externalIds`, which identity.ts reads and the gate does not. Both
 * lists link the same Bulbapedia article for a given product -- the English list
 * from its name column, the Japanese list from its "English equivalent" column
 * -- so the article path pins a Japanese row to the English product at the id
 * tier, which is the only tier strong enough to be trusted here. (By name the
 * pairing fails: "Delta Reign" against "Mega Evolution—Delta Reign" scores
 * 0.667 against a 0.75 threshold, and by code it fails too, because the Japanese
 * list has no set-abbreviation column.)
 */
const ARTICLE_ID_ORIGIN = "bulbapedia-article";

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
    articleLink: { idOrigin: ARTICLE_ID_ORIGIN, headers: ["nameofexpansion"] },
  },
  {
    key: "bp-jp-expansions",
    apiUrl: API_URL,
    pageUrl:
      "https://bulbapedia.bulbagarden.net/wiki/List_of_Japanese_Pok%C3%A9mon_Trading_Card_Game_expansions",
    title: "List of Japanese Pokémon Trading Card Game expansions",
    game: "pokemon-tcg",
    // The point of the whole page. A Japanese street date is months ahead of the
    // global one for the same expansion (Delta Reign: 2026-07-31 in Japan,
    // 2026-11-06 everywhere else), and until phase 4 those two dates landed on
    // one ReleaseEvent as two claims 98 days apart -- a permanent G5 conflict on
    // every Pokemon set with a Japanese release. Now they are two events.
    region: "JP",
    // The name column reads "ストームエメラルダ Storm Emeralda"; the "English
    // equivalent" column reads "Delta Reign". The English name is preferred both
    // because it is what the rest of the catalogue calls the product and because
    // it is what a reader of an English calendar can act on. A Japan-only
    // product whose English equivalent is still "TBA" is dropped by the
    // placeholder-name rule, which is the conservative answer: we would have no
    // way to tell two such rows apart.
    nameHeaders: ["englishequivalent"],
    dateHeaders: ["releasedate"],
    articleLink: { idOrigin: ARTICLE_ID_ORIGIN, headers: ["englishequivalent"] },
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
 * Why the Japanese list waited for phase 4.
 *
 * The page always parsed cleanly with the same machinery; the obstacle was a
 * modelling one. ReleaseEvents were grouped by (productSet, type) and *not* by
 * region, so a Japanese street date and the global street date for the same
 * expansion landed on one event as two claims 3+ months apart -- which the gate
 * read, correctly given what it had been told, as a G5 conflict, on every
 * Pokemon set, forever. Phase 4 made region part of the event key
 * (lib/ingest/orchestrate.ts's eventGroupKey), so the two dates are now two
 * events and neither has to argue with the other.
 *
 * Known limitation, deliberately not solved here: a Japanese row whose "English
 * equivalent" cell is still "TBA" is dropped rather than emitted under its
 * Japanese name. Those rows are the ones we can least afford to guess about --
 * two unannounced Japanese sets have identical placeholder cells in every column
 * that could identify them -- and the same reasoning that refuses Wikipedia's
 * "Unnamed Universes Beyond Set" rows applies unchanged.
 */

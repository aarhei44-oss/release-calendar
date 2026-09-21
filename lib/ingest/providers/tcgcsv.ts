import { z } from "zod";
import { encodeValidators, fetchConditional, type Validators } from "../fetch";
import { decodePayloadBody } from "../normalize";
import type { Candidate, RawPayloadRecord } from "../types";
import {
  failedPayload,
  isWithinForwardWindow,
  notModifiedPayload,
  okPayload,
  parseErrorFor,
  parseIsoDateUtc,
} from "./shared";
import type { FetchContext, Provider } from "./types";

/**
 * tcgcsv.com -- TCGplayer's group (set) catalogue, republished as plain JSON.
 *
 * The only provider that covers every game, and the backbone of the whole
 * phase: every game gets at least this one origin, and its `groupId` is the id
 * space that Scryfall's `tcgplayer_id` joins onto, which is what lets identity
 * resolution pin an MTG set exactly instead of fuzzy-matching its name.
 *
 * Tier RETAILER, and that matters. A retailer knows what it has been cleared to
 * sell and when, which is genuine independent evidence of a street date -- and
 * it is also the source most prone to end-of-month and end-of-quarter
 * placeholders, which is exactly why gate rule G3 makes a lone retailer date
 * hold still for seven runs before it publishes.
 */

const PROVIDER_KEY = "tcgcsv";
const BASE_URL = "https://tcgcsv.com/tcgplayer";

/**
 * TCGplayer category id -> TcgProfilePackage slug. Verified live on 2026-09-04;
 * these ids are stable and are the only place the two vocabularies meet.
 */
export const TCGCSV_CATEGORIES: ReadonlyArray<{ categoryId: number; game: string }> = [
  // Flesh and Blood (62) and Digimon (63) verified 2026-09-19.
  { categoryId: 1, game: "magic-the-gathering" },
  { categoryId: 2, game: "yugioh-tcg" },
  { categoryId: 3, game: "pokemon-tcg" },
  { categoryId: 68, game: "one-piece-tcg" },
  { categoryId: 71, game: "disney-lorcana" },
  { categoryId: 86, game: "gundam-card-game" },
  { categoryId: 89, game: "riftbound" },
  { categoryId: 81, game: "union-arena-tcg" },
  { categoryId: 62, game: "flesh-and-blood" },
  { categoryId: 63, game: "digimon-card-game" },
];

/**
 * Groups that are a set's *pre-release card pool*, not a product of their own:
 * Digimon's "Timeless Bonds Release Event Cards" (code BT-26, the same as the
 * booster it accompanies) and Flesh and Blood's "Usurp the Shadow Throne
 * Pre-release Cards" (code IAR, likewise). TCGplayer stamps each with the
 * event's date, a week before the set's.
 *
 * Left in, they do two kinds of damage. Two products in one origin sharing a
 * code makes identity.ts's collectAmbiguousCodes disqualify that code as an
 * identity key -- for the real set as well, so Bandai's BT-26 could no longer
 * pair with TCGplayer's by code -- and each would land on the calendar as a
 * SHELF release of its own, a week ahead of the actual one.
 *
 * One Piece and Union Arena were added on 2026-09-20 after an accuracy audit
 * found the same shape there: "The Dominance of God Release Event Cards" (OP18
 * RE) and "UE24BT: Re:ZERO ... Release Event Cards" (UE24BT_RE) were on the
 * calendar as releases, and worse, Union Arena's pool groups share their
 * booster's code ("UE20BT: ..." / "UE20BT_RE") so identity.ts folded them into
 * the real product and their week-early dates became that product's date --
 * UE20BT showed 2026-06-19 (real: 2026-06-26) and UE22BT 2026-07-24 (real:
 * 2026-07-31). Only these four games are filtered: the shape is cheap to name
 * here and the remaining games' catalogues carry no such groups.
 */
const PRERELEASE_CARD_POOL_GAMES: ReadonlySet<string> = new Set([
  "flesh-and-blood",
  "digimon-card-game",
  "one-piece-tcg",
  "union-arena-tcg",
]);
const PRERELEASE_CARD_POOL_NAME = /\b(release event|pre-?release) cards$/i;

/**
 * Lorcana's numbered sets are dated by TCGplayer on the day they reach local
 * game stores, a week before they go on sale everywhere.
 *
 * Ravensburger's own announcements say so: Attack of the Vine! "prereleases on
 * July 17 ... and will be available everywhere on July 24", Hyperia City
 * "pre-release October 16, wide release October 23". TCGplayer's groups say
 * 2026-07-17 and 2026-10-16. Reading that date as the release put the set on
 * the calendar a week early -- and Wikipedia, which states both dates, could
 * never corroborate it, so the event sat contradicted with the wrong date
 * published (see ingest-v2-plan.md's original reason for skipping Lorcana).
 *
 * So each numbered set yields two candidates from the one group: the date as
 * given is the local-store PRERELEASE, and the SHELF date is a week later.
 * Only numbered sets ("13", "14") -- Illumineer's Quest boxes carry a "Q" code,
 * ship on one date everywhere, and TCGplayer's 2026-10-02 matches Ravensburger's.
 * If TCGplayer ever lists a numbered set at its wide date instead, the +7 shelf
 * claim disagrees with Wikipedia's and the gate holds and flags it rather than
 * publishing, which is the outcome this is trying to buy.
 */
const LORCANA_LOCAL_STORE_LEAD_DAYS = 7;
const LORCANA_NUMBERED_SET_CODE = /^\d{1,2}$/;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * "Art Series: The Hobbit" ships inside The Hobbit and always shares its date.
 * TCGplayer nevertheless dates these supplemental groups independently, and got
 * one wrong: Art Series: The Hobbit was 2026-11-13 (the Star Trek date) against
 * the real 2026-08-14. Scryfall cannot check it -- memorabilia sets are excluded
 * there -- so the only correct source for the date is the parent set's group.
 */
const ART_SERIES_NAME = /^art series:\s*(.+)$/i;

const groupSchema = z.object({
  groupId: z.number().int(),
  name: z.string(),
  abbreviation: z.string().nullable().optional(),
  isSupplemental: z.boolean().optional(),
  // Naive local-form datetime, e.g. "2026-11-06T00:00:00". Kept as a string
  // here and converted in UTC below; see parseIsoDateUtc.
  publishedOn: z.string().nullable().optional(),
  modifiedOn: z.string().nullable().optional(),
  categoryId: z.number().int().optional(),
});

const categoryResponseSchema = z.object({
  success: z.boolean().optional(),
  results: z.array(groupSchema),
});

/**
 * What this provider stores: one entry per category, keyed by category id as a
 * string. Storing the per-category responses as one payload keeps a run's evidence in
 * a single replayable blob, at the cost described in `fetch` below.
 */
const storedPayloadSchema = z.record(z.string(), categoryResponseSchema);

export function groupsUrl(categoryId: number): string {
  return `${BASE_URL}/${categoryId}/groups`;
}

/**
 * Fetches every category and stores them as one payload.
 *
 * Conditional GET here is a whole-payload content-hash comparison rather than
 * per-request If-None-Match, and that is a deliberate trade. The per-category
 * responses have to be reassembled into one blob to be stored, so a 304 on any
 * one of them would leave a hole we cannot fill from the FetchContext (which
 * carries last run's hash, not last run's body). Comparing the assembled hash
 * instead still buys the thing that actually costs: on an unchanged day the
 * whole of Normalize, Identity, Gate and Apply is skipped. It does not save
 * bandwidth. tcgcsv refreshes around 20:00 UTC daily, so most runs will see a
 * change anyway.
 */
async function fetchTcgcsv(ctx: FetchContext): Promise<RawPayloadRecord> {
  try {
    const stored: Record<string, unknown> = {};
    let latestValidators: Validators = {};

    for (const { categoryId } of TCGCSV_CATEGORIES) {
      // No validators sent: see the note above -- a 304 would be unusable.
      const result = await fetchConditional({ url: groupsUrl(categoryId), fetch: ctx.fetch, signal: ctx.signal });
      if (result.kind === "not-modified") {
        throw new Error(`unexpected 304 for category ${categoryId} on an unconditional request`);
      }
      stored[String(categoryId)] = JSON.parse(result.body);
      latestValidators = result.validators;
    }

    const payload = okPayload({
      scanRunId: ctx.scanRunId,
      providerKey: PROVIDER_KEY,
      value: stored,
      fetchedAt: ctx.now,
      etag: encodeValidators(latestValidators),
    });

    if (ctx.contentHash && ctx.contentHash === payload.contentHash) {
      return notModifiedPayload({
        scanRunId: ctx.scanRunId,
        providerKey: PROVIDER_KEY,
        contentHash: payload.contentHash,
        fetchedAt: ctx.now,
        etag: payload.etag,
      });
    }

    return payload;
  } catch (error) {
    return failedPayload({ scanRunId: ctx.scanRunId, providerKey: PROVIDER_KEY, fetchedAt: ctx.now, error });
  }
}

function parseTcgcsv(payload: RawPayloadRecord): Candidate[] {
  const decoded = storedPayloadSchema.safeParse(decodePayloadBody(payload));
  if (!decoded.success) {
    const issue = decoded.error.issues[0];
    throw parseErrorFor(PROVIDER_KEY, issue.path.map(String).join(".") || "body", issue.message, decoded.error);
  }

  const candidates: Candidate[] = [];

  for (const { categoryId, game } of TCGCSV_CATEGORIES) {
    const category = decoded.data[String(categoryId)];
    // A category missing from the payload is not an error: a partially
    // successful fetch, or a replay of a payload captured before a game was
    // added, both look like this and both should yield what they do have.
    if (!category) continue;

    // Non-supplemental groups by name, so an Art Series group can borrow its
    // parent's date. Built per category: names only mean anything within a game.
    const datesByName = new Map<string, string>();
    if (game === "magic-the-gathering") {
      for (const candidate of category.results) {
        const published = candidate.publishedOn?.trim();
        if (candidate.isSupplemental || !published || published.endsWith("Z")) continue;
        datesByName.set(candidate.name.trim().toLowerCase(), published);
      }
    }

    for (const group of category.results) {
      const artSeriesParent =
        game === "magic-the-gathering" ? ART_SERIES_NAME.exec(group.name.trim())?.[1]?.trim().toLowerCase() : undefined;
      const raw = (artSeriesParent ? datesByName.get(artSeriesParent) : undefined) ?? group.publishedOn?.trim();
      // tcgcsv's genuine publishedOn is the naive local-form datetime described
      // above -- no zone suffix. For groups it has no curated release date for
      // (evergreen promo/box-set pools like "FNM Promos" or "Arena Promos",
      // not an actual dated product), it instead stamps publishedOn with the
      // instant its own crawler last touched the record: a real ISO instant,
      // "Z"-suffixed and sub-second precise (e.g.
      // "2026-09-05T20:00:07.1172096Z"). Verified live on 2026-09-06: 36 of
      // 455 MTG groups shared one such timestamp down to the microsecond,
      // while every genuine release date was a bare whole-day value. Reading
      // that as an EXACT date makes an ageless promo pool look like a fresh
      // imminent release every day the crawl runs -- which is what put
      // "Arena Promos", "FNM Promos" et al. on the calendar dated to whatever
      // day the pipeline last ran. A "Z" suffix never appears on a genuine
      // value, so it's read as TBD instead.
      const isCrawlTimestamp = raw?.endsWith("Z") ?? false;
      // A crawl timestamp is not a weaker date than usual, it is a statement
      // that this group is not a dated product at all -- so the group is
      // dropped here rather than admitted as TBD.
      //
      // Reading it as TBD (this provider's first correction, once the timestamp
      // was no longer being read as a release date) stopped promo pools being
      // dated to whatever day the pipeline last ran, but it left them on the
      // books: 73 dateless ProductSets -- "FNM Promos", "Judge Promos", "POP
      // Series 1" through "9", "EX Trainer Kit 2: Plusle & Minun" -- each with
      // an event the gate re-held on every run forever, because there is no
      // date coming and no rule that can retire them. They were 48% of the
      // catalogue and 0% of the calendar.
      //
      // This is safe to do unconditionally because the two states are cleanly
      // separated in the feed rather than merely usually distinguishable:
      // across the eight categories then tracked, on 2026-09-08, every group carried a
      // publishedOn, every genuine one was a bare whole-day value, and the 73
      // "Z"-suffixed ones matched the 73 dateless sets in the database exactly.
      // A product that later gains a real date reappears as an ordinary
      // candidate the next run, so nothing is permanently excluded.
      if (isCrawlTimestamp) continue;
      const parsed = raw ? parseIsoDateUtc(raw) : null;
      // A publishedOn that is present but unreadable is drift worth failing on:
      // silently downgrading it to TBD would quietly blank real dates.
      if (raw && !parsed) {
        throw parseErrorFor(
          PROVIDER_KEY,
          `${categoryId}.results.${group.groupId}.publishedOn`,
          `unparseable date "${raw}"`,
        );
      }

      const date: Candidate["date"] = parsed ? { kind: "EXACT", date: parsed } : { kind: "TBD" };
      if (!isWithinForwardWindow(date, payload.fetchedAt)) continue;

      const name = group.name.trim();
      if (!name) continue;
      if (PRERELEASE_CARD_POOL_GAMES.has(game) && PRERELEASE_CARD_POOL_NAME.test(name)) continue;

      const abbreviation = group.abbreviation?.trim();

      const base = {
        origin: "tcgplayer" as const,
        game,
        externalIds: { tcgplayer: String(group.groupId) },
        name,
        code: abbreviation ? abbreviation : null,
        region: "GLOBAL" as const,
        url: groupsUrl(categoryId),
      };

      if (
        game === "disney-lorcana" &&
        date.kind === "EXACT" &&
        LORCANA_NUMBERED_SET_CODE.test(abbreviation ?? "")
      ) {
        candidates.push({ ...base, externalIds: { ...base.externalIds }, date, type: "PRERELEASE" });
        candidates.push({
          ...base,
          externalIds: { ...base.externalIds },
          date: { kind: "EXACT", date: new Date(date.date.getTime() + LORCANA_LOCAL_STORE_LEAD_DAYS * MS_PER_DAY) },
          type: "SHELF",
        });
        continue;
      }

      candidates.push({ ...base, date, type: "SHELF" });
    }
  }

  return candidates;
}

export const tcgcsvProvider: Provider = {
  key: PROVIDER_KEY,
  origin: "tcgplayer",
  tier: "RETAILER",
  games: TCGCSV_CATEGORIES.map((entry) => entry.game),
  fetch: fetchTcgcsv,
  parse: parseTcgcsv,
};

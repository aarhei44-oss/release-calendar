import { z } from "zod";
import { decodeValidators, encodeValidators, fetchConditional } from "../fetch";
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
 * Scryfall's set index -- every Magic set in one response, no pagination.
 *
 * **The reason this provider exists is `tcgplayer_id`.** Scryfall publishes,
 * for most physical sets, the TCGplayer group id that tcgcsv.ts also keys on.
 * Emitting both ids on the same candidate means identity.ts reconciles the two
 * origins on an integer rather than on a name, which is the difference between
 * "Bloomburrow" and "Bloomburrow Commander" being reliably distinct products
 * and being a coin flip. Measured against the live data on 2026-09-04: 372 of
 * 372 non-digital sets carrying a tcgplayer_id matched a tcgcsv group id
 * exactly.
 *
 * Tier: COMMUNITY, not OFFICIAL, matching what Phase 1's ORIGINS already
 * declares. Scryfall's set data is excellent but it is compiled from Wizards'
 * own Gatherer and product pages, so treating it as an independent official
 * observation would let one upstream mistake satisfy gate rule G1 on its own.
 * Nothing is lost by this: Scryfall and tcgplayer are independent lineages, so
 * an MTG date they agree on still publishes, via G2.
 */

const PROVIDER_KEY = "scryfall";
const SETS_URL = "https://api.scryfall.com/sets";
const GAME = "magic-the-gathering";

const setSchema = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  released_at: z.string().nullable().optional(),
  set_type: z.string(),
  digital: z.boolean(),
  card_count: z.number().int().optional(),
  tcgplayer_id: z.number().int().nullable().optional(),
  icon_svg_uri: z.string().nullable().optional(),
  scryfall_uri: z.string().nullable().optional(),
});

const listSchema = z.object({
  object: z.literal("list").optional(),
  has_more: z.boolean().optional(),
  data: z.array(setSchema),
});

/**
 * `set_type` values that are not a thing you can buy on a release day.
 *
 * Taken from what the live index actually contains (24 distinct types on
 * 2026-09-04), not from a guess:
 *
 *  - `token` (213) and `memorabilia` (99) are companion sets of tokens, art
 *    cards and oversized cards that ship *inside* another product. They share
 *    that product's date, so admitting them would put two to four duplicate
 *    entries on the calendar for every real release.
 *  - `minigame` (15) is the same story for insert minigame cards.
 *  - `alchemy` (18), `treasure_chest` (2) and `vanguard` (2) are Arena/Magic
 *    Online constructs with no physical printing at all.
 *
 * Everything else is kept, including `promo`, `funny` and `masterpiece`: those
 * are real printed products with their own TCGplayer groups, and the whole
 * value of this provider is the id join, which only works on sets tcgcsv also
 * lists.
 */
const EXCLUDED_SET_TYPES = new Set(["token", "memorabilia", "minigame", "alchemy", "treasure_chest", "vanguard"]);

async function fetchScryfall(ctx: FetchContext): Promise<RawPayloadRecord> {
  try {
    const result = await fetchConditional({
      url: SETS_URL,
      fetch: ctx.fetch,
      signal: ctx.signal,
      validators: decodeValidators(ctx.etag),
      // Scryfall answers 403 without a descriptive User-Agent *and* an explicit
      // Accept; fetchConditional sends both.
      accept: "application/json",
    });

    if (result.kind === "not-modified") {
      return notModifiedPayload({
        scanRunId: ctx.scanRunId,
        providerKey: PROVIDER_KEY,
        contentHash: ctx.contentHash ?? "",
        fetchedAt: ctx.now,
        etag: ctx.etag ?? null,
      });
    }

    const payload = okPayload({
      scanRunId: ctx.scanRunId,
      providerKey: PROVIDER_KEY,
      value: JSON.parse(result.body),
      fetchedAt: ctx.now,
      etag: encodeValidators(result.validators),
    });

    // Scryfall sends a weak ETag, which some intermediaries drop. The hash
    // comparison is the belt to that braces.
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

function parseScryfall(payload: RawPayloadRecord): Candidate[] {
  const decoded = listSchema.safeParse(decodePayloadBody(payload));
  if (!decoded.success) {
    const issue = decoded.error.issues[0];
    throw parseErrorFor(PROVIDER_KEY, issue.path.map(String).join(".") || "body", issue.message, decoded.error);
  }

  const candidates: Candidate[] = [];

  for (const set of decoded.data.data) {
    if (set.digital) continue;
    if (EXCLUDED_SET_TYPES.has(set.set_type)) continue;

    const raw = set.released_at?.trim();
    const parsed = raw ? parseIsoDateUtc(raw) : null;
    if (raw && !parsed) {
      throw parseErrorFor(PROVIDER_KEY, `data.${set.code}.released_at`, `unparseable date "${raw}"`);
    }

    const date: Candidate["date"] = parsed ? { kind: "EXACT", date: parsed } : { kind: "TBD" };
    if (!isWithinForwardWindow(date, payload.fetchedAt)) continue;

    // The join key. Emitted under the `tcgplayer` origin because that is whose
    // id space it belongs to -- identity.ts tries the candidate's own origin
    // first and then every cited sibling, so a set Scryfall has never seen
    // before still lands on the ProductSet tcgcsv already pinned.
    const externalIds: Record<string, string> = { scryfall: set.id };
    if (set.tcgplayer_id != null) externalIds.tcgplayer = String(set.tcgplayer_id);

    candidates.push({
      origin: "scryfall",
      game: GAME,
      externalIds,
      name: set.name.trim(),
      code: set.code.trim().toUpperCase() || null,
      date,
      region: "GLOBAL",
      type: "SHELF",
      url: set.scryfall_uri ?? SETS_URL,
      ...(set.icon_svg_uri ? { imageUrl: set.icon_svg_uri } : {}),
    });
  }

  return candidates;
}

export const scryfallProvider: Provider = {
  key: PROVIDER_KEY,
  origin: "scryfall",
  tier: "COMMUNITY",
  games: [GAME],
  fetch: fetchScryfall,
  parse: parseScryfall,
};

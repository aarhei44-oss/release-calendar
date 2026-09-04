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
 * YGOPRODeck's card-set index -- every Yu-Gi-Oh! set in one JSON array.
 *
 * Gives Yu-Gi-Oh! a second origin alongside tcgcsv, which is what lets a
 * Yu-Gi-Oh date satisfy gate rule G2 instead of waiting seven runs for G3.
 * COMMUNITY tier, declared in ORIGINS as deriving from konami-official, so it
 * never counts as an independent check on Konami's own feed.
 */

const PROVIDER_KEY = "ygoprodeck";
const SETS_URL = "https://db.ygoprodeck.com/api/v7/cardsets.php";
const GAME = "yugioh-tcg";

const cardSetSchema = z.object({
  set_name: z.string(),
  set_code: z.string(),
  num_of_cards: z.number().int().optional(),
  /** Absent for announced-but-unscheduled sets; those are TBD candidates, not dropped rows. */
  tcg_date: z.string().nullable().optional(),
  set_image: z.string().nullable().optional(),
});

const listSchema = z.array(cardSetSchema);

/**
 * The identity key for a YGOPRODeck set.
 *
 * `set_code` alone will not do, and this is not a hypothetical: on the live
 * index (2026-09-04) 142 of 646 distinct codes are shared by two or three
 * different sets -- "YS15" is three separate 2015 starter decks, "ABPF" covers
 * Absolute Powerforce, its Sneak Peek card and its Special Edition. Using the
 * bare code as an external id would pin all three onto one ProductSet, which is
 * precisely the un-undoable identity error identity.ts is written to avoid.
 * `set_name`, by contrast, is unique across all 1,035 rows, so the pair is
 * unique and stable. The bare code still travels as the candidate's `code`.
 */
function ygoExternalId(setCode: string, setName: string): string {
  return `${setCode}:${setName}`;
}

async function fetchYgoprodeck(ctx: FetchContext): Promise<RawPayloadRecord> {
  try {
    const result = await fetchConditional({
      url: SETS_URL,
      fetch: ctx.fetch,
      signal: ctx.signal,
      validators: decodeValidators(ctx.etag),
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
      // This endpoint sends Last-Modified and no ETag, so the stored validator
      // is the JSON form; see lib/ingest/fetch.ts's encodeValidators.
      etag: encodeValidators(result.validators),
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

function parseYgoprodeck(payload: RawPayloadRecord): Candidate[] {
  const decoded = listSchema.safeParse(decodePayloadBody(payload));
  if (!decoded.success) {
    const issue = decoded.error.issues[0];
    throw parseErrorFor(PROVIDER_KEY, issue.path.map(String).join(".") || "body", issue.message, decoded.error);
  }

  const candidates: Candidate[] = [];

  for (const set of decoded.data) {
    const raw = set.tcg_date?.trim();
    const parsed = raw ? parseIsoDateUtc(raw) : null;
    if (raw && !parsed) {
      throw parseErrorFor(PROVIDER_KEY, `${set.set_code}.tcg_date`, `unparseable date "${raw}"`);
    }

    // No tcg_date at all is a real state here (4 rows on the live index:
    // collaboration promos and an unscheduled World Championship pack). Those
    // are announced products with no date yet -- exactly what TBD is for.
    const date: Candidate["date"] = parsed ? { kind: "EXACT", date: parsed } : { kind: "TBD" };
    if (!isWithinForwardWindow(date, payload.fetchedAt)) continue;

    const name = set.set_name.trim();
    const code = set.set_code.trim();
    if (!name || !code) continue;

    candidates.push({
      origin: "ygoprodeck",
      game: GAME,
      externalIds: { ygoprodeck: ygoExternalId(code, name) },
      name,
      code,
      date,
      region: "GLOBAL",
      type: "SHELF",
      url: SETS_URL,
      ...(set.set_image ? { imageUrl: set.set_image } : {}),
    });
  }

  return candidates;
}

export const ygoprodeckProvider: Provider = {
  key: PROVIDER_KEY,
  origin: "ygoprodeck",
  tier: "COMMUNITY",
  games: [GAME],
  fetch: fetchYgoprodeck,
  parse: parseYgoprodeck,
};

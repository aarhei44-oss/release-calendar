import {
  isFuzzyProductSetNameMatch,
  isMatchableNormalizedName,
  normalizeProductSetName,
  productSetNameSimilarity,
  significantTokenSet,
} from "@/lib/crawler/dedup";
import type { Candidate, IdentityResolution, Origin } from "./types";

/**
 * Stage 3: work out which ProductSet a candidate is talking about.
 *
 * Four tiers, in descending order of how much the evidence is worth:
 *
 *   1. External id  -- a fact an upstream published about its own catalogue.
 *   2. Set code     -- a fact the *game* published about the product.
 *   3. Name         -- a guess we make about two strings.
 *   4. New          -- said plainly, rather than forcing a marginal match.
 *
 * The middle tier is the one this file exists for. v1 (and phase 2) had only
 * tiers 1 and 3, and that is not a tuning problem, it is a structural one:
 * TCGplayer names a Pokemon set "ME06: Delta Reign" while Bulbapedia names the
 * same physical product "Mega Evolution-Delta Reign". Those two strings share
 * one significant token out of five and score 0.571, comfortably under any
 * threshold that does not also start fusing "SV01: Scarlet & Violet" into
 * "SV02: Paldea Evolved". So the retailer claim and the wiki claim landed on
 * two different ProductSets, never met each other on one ReleaseEvent, and gate
 * rule G2 (two independent origins agreeing) could not fire for the game with
 * the most origins. Lowering the similarity cutoff trades that failure for the
 * false-merge failure v1 spent six commits on; matching on the *code* both
 * sources already print resolves it without touching the cutoff at all.
 *
 * Kept pure -- the existing sets, identities and the ambiguous-code set are
 * passed in, not queried -- so it is replayable and testable without a
 * database, like every stage after Fetch.
 */

// ---------------------------------------------------------------------------
// Set codes
// ---------------------------------------------------------------------------

/**
 * Codes that name nothing.
 *
 * Wikipedia's Magic set list carries the literal code "TBA" on every set
 * Wizards has slotted but not announced -- five of them at once on 2026-09-04.
 * Admitted as an identity key, "TBA" would fuse five unrelated products into
 * one ProductSet that no later pass could safely take apart, which is precisely
 * the failure this module exists to prevent, arriving through the back door.
 */
const PLACEHOLDER_CODE = /^(?:n\/?a|tba|tbd|tbc|unknown|none)$/i;

// ---------------------------------------------------------------------------
// Placeholder names
// ---------------------------------------------------------------------------

/** A cell that names nothing at all: "TBA", "—", "?", "n/a". */
const PLACEHOLDER_NAME_EXACT = /^(?:[—–\-?]+|n\/?a|tba|tbd|tbc|unknown|none)$/i;

/**
 * A name that is a *description of a gap* rather than a name: "Unnamed
 * Universes Beyond Set", "Untitled expansion", "TBA Universes Beyond set".
 *
 * The word boundary is load-bearing. Magic's un-sets are real products called
 * Unglued, Unhinged, Unstable, Unsanctioned and Unfinity, and a prefix match
 * without `\b` would delete all five from the calendar.
 */
const PLACEHOLDER_NAME_PREFIX = /^(?:unnamed|untitled|unannounced|unrevealed|undisclosed|tba|tbd)\b/i;

/**
 * Whether a name is a placeholder, and therefore must not be used to identify
 * anything.
 *
 * This is the name-shaped twin of PLACEHOLDER_CODE above, and it exists for a
 * failure that was measured rather than imagined: English Wikipedia's Magic set
 * list carries three separate rows all called "Unnamed Universes Beyond Set" --
 * three distinct products Wizards has slotted and not announced. Because
 * mediawiki.ts builds a row's external id as `${page}:${code ?? name}` and the
 * code column reads "TBA" on all three, the three rows produced one external id,
 * one ProductSet, and one release event that no later pass could take apart.
 *
 * A placeholder name disqualifies a row from the *name* tier here and, in
 * mediawiki.ts, from being emitted at all. Both, deliberately: the provider-side
 * refusal is what keeps three contentless rows off the calendar, and this one is
 * what stops any future provider re-introducing the merge through a different
 * door.
 */
export function isPlaceholderName(name: string | null | undefined): boolean {
  if (!name) return true;
  const trimmed = name.trim();
  if (!trimmed) return true;
  return PLACEHOLDER_NAME_EXACT.test(trimmed) || PLACEHOLDER_NAME_PREFIX.test(trimmed);
}

/**
 * Canonical form of a set code: upper case, separators removed, so that
 * "OP-13", "OP13" and "op 13" are one key rather than three.
 *
 * Returns null for anything that cannot serve as an identity key -- a
 * placeholder, or a single character (a bare "9" is a position in a sequence,
 * not a namespaced code, and is far too easy for two unrelated rows to share).
 */
export function normalizeSetCode(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const normalized = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (normalized.length < 2) return null;
  if (PLACEHOLDER_CODE.test(normalized)) return null;
  return normalized;
}

/**
 * A code printed at the front of a name: "ME06: Delta Reign", "OP-13 Royal
 * Blood", "GD04 Phantom Aria", "ST09 Destiny Ignition".
 *
 * Deliberately requires UPPER-CASE letters immediately followed by digits. Both
 * halves of that are load-bearing:
 *
 *  - digits, because a letters-only leading token is indistinguishable from an
 *    ordinary first word, and "EX Trainer Kit 1" / "POP Series 3" would then
 *    hand out "EX" and "POP" as identity keys to a dozen different products;
 *  - upper case, because "Set 8" and "Set 9" -- Wikipedia's placeholder names
 *    for unannounced Riftbound sets -- would otherwise yield the codes SET8 and
 *    SET9 and start a code-shaped argument about two rows that are not
 *    products yet.
 */
const LEADING_NAME_CODE = /^([A-Z]{1,5}[-–—]?\s?\d{1,3}[A-Z]{0,2})(?=\s*[:\-–—]\s|\s|$)/;

/**
 * A code printed in brackets at the end of a name: "Phantom Aria [GD04]",
 * "Extra Booster (EB-05)".
 *
 * Bounded to a single short token containing at least one letter, so that a
 * parenthetical *sentence* ("(2020 Date Reprint)", "(All-Foil Edition)") and a
 * bare year ("(2026)") are not mistaken for codes.
 */
const TRAILING_NAME_CODE = /[[(](?=[A-Za-z0-9-]*[A-Za-z])([A-Za-z0-9][A-Za-z0-9-]{1,8})[\])]\s*$/;

/**
 * Every code a candidate or an existing set carries, best first: its own code
 * column, then a leading code token in its name, then a trailing bracketed one.
 *
 * Order matters for matching (the first one that resolves wins) but not for the
 * disagreement check below, which treats them as a set.
 */
export function setCodesFor(input: { name?: string | null; code?: string | null }): string[] {
  const codes: string[] = [];
  const push = (raw: string | null | undefined) => {
    const normalized = normalizeSetCode(raw);
    if (normalized && !codes.includes(normalized)) codes.push(normalized);
  };

  push(input.code);

  const name = input.name?.trim();
  if (name) {
    push(LEADING_NAME_CODE.exec(name)?.[1]);
    push(TRAILING_NAME_CODE.exec(name)?.[1]);
  }

  return codes;
}

/**
 * Whether two things's codes actively disagree.
 *
 * This is the veto that makes the looser name matching below safe. "OP-13 Royal
 * Blood" and "OP-14 Royal Blood" reduce to the same name once their codes are
 * stripped, and by every string measure they are the same product; the only
 * thing that says otherwise is the code, so the code has to be allowed to say
 * it. A side with no code at all abstains rather than disagreeing -- most wiki
 * rows have no code column, and treating "silent" as "different" would undo the
 * whole point of the exercise.
 */
export function setCodesDisagree(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  return !a.some((code) => b.includes(code));
}

/**
 * Codes that must not be used as identity keys because one origin hands the
 * same code to several different products.
 *
 * Not a hypothetical. In the 2026-09-04 tcgcsv catalogue the Pokemon
 * `abbreviation` column reads "PR" for four unrelated promo sets, "POP" for all
 * nine POP Series releases, and "30C" for both "ME: 30th Celebration" and its
 * Classic Collection. Matching on those would merge nine products into one.
 *
 * Ambiguity is judged *within one origin*: the same origin giving one code to
 * two different products means the code is not an identifier in that catalogue.
 * Comparing across origins instead would be wrong in the other direction --
 * TCGplayer and Bulbapedia legitimately print different names for the same
 * product, and counting that as ambiguity would disqualify exactly the codes
 * that pair them.
 */
export function collectAmbiguousCodes(
  candidates: ReadonlyArray<{ origin: Origin; name: string; code?: string | null }>,
): Set<string> {
  // Nested rather than a composite string key, so no separator character has to
  // be reserved and no origin or code can forge a collision by containing one.
  const byOrigin = new Map<Origin, Map<string, Set<string>>>();

  for (const candidate of candidates) {
    const byCode = byOrigin.get(candidate.origin) ?? new Map<string, Set<string>>();
    for (const code of setCodesFor(candidate)) {
      const names = byCode.get(code) ?? new Set<string>();
      names.add(normalizeProductSetName(candidate.name));
      byCode.set(code, names);
    }
    byOrigin.set(candidate.origin, byCode);
  }

  const ambiguous = new Set<string>();
  for (const byCode of byOrigin.values()) {
    for (const [code, names] of byCode) {
      if (names.size > 1) ambiguous.add(code);
    }
  }
  return ambiguous;
}

// ---------------------------------------------------------------------------
// Name variants
// ---------------------------------------------------------------------------

/** The separators a source uses between an expansion-series prefix and the set's own name. */
const NAME_SEPARATOR = /[–—]|:\s|\s-\s/;

/** Removes a leading and/or trailing code token, leaving the name the sources actually share. */
export function stripSetCodeTokens(name: string): string {
  let out = name.trim();

  const trailing = TRAILING_NAME_CODE.exec(out);
  if (trailing && normalizeSetCode(trailing[1])) {
    const withoutTrailing = out.slice(0, trailing.index).trim();
    if (withoutTrailing) out = withoutTrailing;
  }

  const leading = LEADING_NAME_CODE.exec(out);
  if (leading && normalizeSetCode(leading[1])) {
    const withoutLeading = out
      .slice(leading[0].length)
      .replace(/^\s*[:\-–—]\s*/, "")
      .trim();
    if (withoutLeading) out = withoutLeading;
  }

  return out || name.trim();
}

type NameVariants = {
  /** The name as given, and the same name with its code tokens removed. */
  forms: string[];
  /** The segment after the first separator, when there is a usable one. */
  tail: string | null;
  /**
   * Whether the part *before* that separator is a bare code token.
   *
   * This is what stops tail matching from eating the catalogue. "ME06: Delta
   * Reign" and "Art Series: The Hobbit" have the same shape, and their tails
   * ("Delta Reign", "The Hobbit") are equally happy to match a bare set name --
   * but one of those is the product's real name with a code in front of it and
   * the other is a different product *derived* from the one it names. A
   * code-shaped head is the only reliable way to tell them apart, so a tail may
   * be compared against a whole name only when its head is one.
   */
  headIsCode: boolean;
};

/** "ME", "SV10", "OP-13" -- a single upper-case token, never a phrase like "Commander" or "Art Series". */
function isCodeShapedHead(head: string): boolean {
  return /^[A-Z][A-Z0-9]{0,5}(?:[-.][A-Z0-9]{1,4})?$/.test(head);
}

function nameVariants(name: string): NameVariants {
  const trimmed = name.trim();
  const stripped = stripSetCodeTokens(trimmed);
  const forms = stripped === trimmed ? [trimmed] : [trimmed, stripped];

  // Split the name as given, not the stripped form: stripping a leading code
  // takes the separator with it, and "SV10: Destined Rivals" would then have no
  // head to be recognised as code-shaped -- which is the one case where being
  // recognised matters most.
  const match = NAME_SEPARATOR.exec(trimmed);
  if (match && match.index > 0) {
    const head = trimmed.slice(0, match.index).trim();
    const tail = trimmed.slice(match.index + match[0].length).trim();
    const normalizedTail = normalizeProductSetName(tail);
    // A tail has to be a name in its own right. Anything that normalizes away
    // to nothing, or that is entirely edition/format boilerplate, would make an
    // excellent way to merge unrelated products.
    if (head && isMatchableNormalizedName(normalizedTail) && significantTokenSet(tail).size > 0) {
      return { forms, tail, headIsCode: isCodeShapedHead(head) };
    }
  }

  return { forms, tail: null, headIsCode: false };
}

/**
 * Whether two names refer to the same product with enough certainty to merge on
 * the strength of the name alone.
 *
 * Every comparison here is *exact* after normalization, never fuzzy, and that
 * is the safety margin. "ME: 30th Celebration" and "30th Celebration" have
 * identical tails and are the same set; "ME: 30th Celebration Classic
 * Collection" and "30th Celebration" score 0.8 against each other and are not.
 * Requiring exactness keeps the first and rejects the second, where a
 * similarity threshold could not have both.
 */
function variantsMatchExactly(a: NameVariants, b: NameVariants): boolean {
  const normalize = (value: string) => normalizeProductSetName(value);
  const formsA = a.forms.map(normalize).filter(isMatchableNormalizedName);
  const formsB = b.forms.map(normalize).filter(isMatchableNormalizedName);

  // Whole name against whole name, in either side's code-stripped form. Removing
  // a code token is a lossless operation, so this is as safe as comparing the
  // raw names: "OP-13 Royal Blood" really is "Royal Blood" with a code on it.
  if (formsA.some((value) => formsB.includes(value))) return true;

  const tailA = a.tail ? normalize(a.tail) : null;
  const tailB = b.tail ? normalize(b.tail) : null;

  // Tail against tail: "ME06: Delta Reign" vs "Mega Evolution-Delta Reign".
  // Still requires a code-shaped head on one side, and Bandai's accessory
  // naming is why: "Official Playmat - Flame-Flame Fruit Coliseum Edition",
  // "Limited Card Sleeve - Flame-Flame Fruit Coliseum Edition" and two more
  // share a tail exactly and are four different products. A shared tail means
  // "same thing, two naming conventions" only when one of the conventions is a
  // code; otherwise it means "same theme, several products".
  if (tailA && tailB && tailA === tailB && (a.headIsCode || b.headIsCode)) return true;

  // Tail against whole name -- only from a code-shaped head. See NameVariants.
  if (tailA && a.headIsCode && formsB.includes(tailA)) return true;
  if (tailB && b.headIsCode && formsA.includes(tailB)) return true;

  return false;
}

/**
 * Best fuzzy score between two names, comparing both raw and code-stripped
 * forms, and 0 when no pairing clears v1's threshold.
 *
 * The threshold itself stays inside isFuzzyProductSetNameMatch rather than
 * being restated here: one number, one owner, no chance of the two pipelines
 * drifting to different definitions of "similar enough".
 */
function bestSimilarity(a: NameVariants, b: NameVariants): number {
  let best = 0;
  for (const left of a.forms) {
    for (const right of b.forms) {
      if (!isFuzzyProductSetNameMatch(left, right)) continue;
      const score = productSetNameSimilarity(left, right);
      if (score > best) best = score;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/** One row of the SetIdentity table, reduced to what matching needs. */
export type SetIdentityRecord = {
  origin: Origin;
  externalId: string;
  productSetId: string;
};

/** One existing ProductSet, reduced to what code and name matching need. */
export type ExistingProductSet = {
  id: string;
  name: string | null;
  code?: string | null;
  /**
   * Whether `code` was invented at creation time (lib/ingest/orchestrate.ts)
   * rather than read from a source. A synthetic code exists only to satisfy
   * the column's NOT NULL/unique constraint -- it is not a fact any origin
   * published, so buildCodeIndex below must never hand it out as a match.
   */
  codeIsSynthetic?: boolean;
  /**
   * Optional belt-and-braces game scope. Callers already narrow `sets` to one
   * install, so this is normally absent; when both sides state a game they must
   * agree, so a caller that forgets to scope cannot silently match a Pokemon
   * set against a Gundam one.
   */
  game?: string | null;
};

export type IdentityContext = {
  identities: SetIdentityRecord[];
  /**
   * The sets the candidate could plausibly be. Callers scope this (normally to
   * one TcgProfileInstall) before calling: two games' catalogues should never
   * be name-matched against each other, and that scoping is a database
   * concern, not this function's.
   */
  sets: ExistingProductSet[];
  /**
   * Codes this run must not treat as identity keys, from
   * collectAmbiguousCodes over the run's own candidates. Optional: omitted, the
   * only ambiguity guard is the one derived from `sets` below, which is enough
   * for a unit test but not for a first run against an empty catalogue (where
   * every duplicate-coded product is still in the batch rather than the
   * database).
   */
  ambiguousCodes?: ReadonlySet<string>;
};

function identityKey(origin: Origin, externalId: string): string {
  // NUL separator so an origin or id containing the separator character can't
  // forge a collision with a different pair.
  return `${origin} ${externalId}`;
}

export function buildIdentityIndex(identities: SetIdentityRecord[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const identity of identities) {
    index.set(identityKey(identity.origin, identity.externalId), identity.productSetId);
  }
  return index;
}

/**
 * code -> the one set that owns it. A code claimed by two different sets is
 * dropped entirely rather than resolved to either: the store already contains
 * an ambiguity, and picking a winner would turn it into a merge.
 */
export function buildCodeIndex(sets: ExistingProductSet[]): Map<string, string> {
  const claims = new Map<string, Set<string>>();
  for (const set of sets) {
    if (set.codeIsSynthetic) continue;
    for (const code of setCodesFor(set)) {
      const owners = claims.get(code) ?? new Set<string>();
      owners.add(set.id);
      claims.set(code, owners);
    }
  }

  const index = new Map<string, string>();
  for (const [code, owners] of claims) {
    if (owners.size === 1) index.set(code, [...owners][0]);
  }
  return index;
}

export type IdentityCandidateInput = Pick<Candidate, "origin" | "externalIds" | "name"> &
  Partial<Pick<Candidate, "code" | "game">>;

function sameGame(candidate: IdentityCandidateInput, set: ExistingProductSet): boolean {
  if (!candidate.game || !set.game) return true;
  return candidate.game === set.game;
}

/**
 * Resolves a candidate to a ProductSet id.
 *
 * Returns `matchedBy: "new"` with a null id when nothing matches -- callers
 * create the set. Deliberately never returns a "maybe": a marginal name
 * similarity is a non-match here, and the cost of that is one duplicate the
 * dedup pass can merge later, versus the cost of a false positive, which is
 * two real products fused into one event that no automated pass can safely
 * take apart again.
 */
export function resolveSetIdentity(candidate: IdentityCandidateInput, context: IdentityContext): IdentityResolution {
  const index = buildIdentityIndex(context.identities);

  // -------------------------------------------------------------------------
  // (a) ID match. The candidate's *own* origin is tried first: a provider is
  // authoritative about its own id space, whereas an id it cites for a sibling
  // origin is second-hand and likelier to be stale or mistranscribed.
  // -------------------------------------------------------------------------
  const originsToTry: Origin[] = [
    ...(candidate.externalIds[candidate.origin] !== undefined ? [candidate.origin] : []),
    ...Object.keys(candidate.externalIds)
      .filter((origin) => origin !== candidate.origin)
      .sort(), // sorted so the resolution is deterministic on replay
  ];

  for (const origin of originsToTry) {
    const externalId = candidate.externalIds[origin];
    if (!externalId) continue;
    const productSetId = index.get(identityKey(origin, externalId));
    if (productSetId) {
      return { productSetId, matchedBy: "id", matchedOrigin: origin };
    }
  }

  const scopedSets = context.sets.filter((set) => sameGame(candidate, set));
  const candidateCodes = setCodesFor(candidate);

  // -------------------------------------------------------------------------
  // (b) Code match. Second only to an id, and for a good reason: a set code is
  // published by the game itself, so two origins printing the same one is a
  // shared *fact* rather than a shared choice of words.
  // -------------------------------------------------------------------------
  const ambiguous = context.ambiguousCodes;
  const codeIndex = buildCodeIndex(scopedSets);
  for (const code of candidateCodes) {
    if (ambiguous?.has(code)) continue;
    const productSetId = codeIndex.get(code);
    if (productSetId) {
      return { productSetId, matchedBy: "code", matchedCode: code };
    }
  }

  // -------------------------------------------------------------------------
  // (c) Name fallback. Still built on v1's helpers rather than a second
  // implementation of them -- those functions carry hard-won knowledge about
  // TCG naming (sequence labels, trailing set codes, the number-mismatch veto
  // that stops a sequel being merged into its predecessor) -- but now applied
  // to code-stripped and tail-split forms of each name, and vetoed outright
  // whenever the two sides' codes disagree.
  // -------------------------------------------------------------------------
  // A placeholder name identifies nothing, and three rows sharing one is not
  // evidence that they are one product -- it is evidence that none of them has
  // a name yet. Checked before the name tier and after the id/code tiers, so a
  // row that *is* pinned by an upstream id still resolves normally.
  if (isPlaceholderName(candidate.name)) {
    return { productSetId: null, matchedBy: "new" };
  }

  const candidateVariants = nameVariants(candidate.name);
  if (!candidateVariants.forms.some((form) => isMatchableNormalizedName(normalizeProductSetName(form)))) {
    // A name that normalizes to nothing usable (e.g. "(2026)") must not become
    // a grouping key -- every such set in an install would collide.
    return { productSetId: null, matchedBy: "new" };
  }

  const comparable = scopedSets
    // ...and symmetrically: a stored set that was created under a placeholder
    // name (by an earlier run, or by the v1 crawler) must not absorb anything.
    .filter((set) => set.name && !isPlaceholderName(set.name))
    .map((set) => ({ set, codes: setCodesFor(set), variants: nameVariants(set.name as string) }))
    // The code veto, applied before any string is compared: whatever the names
    // say, two products whose codes disagree are two products.
    .filter((entry) => !setCodesDisagree(candidateCodes, entry.codes));

  // Exact first, and separately: it is strictly stronger evidence than any
  // similarity score, so a perfect match can never lose a tiebreak to a
  // merely-good one.
  for (const entry of comparable) {
    if (variantsMatchExactly(candidateVariants, entry.variants)) {
      return { productSetId: entry.set.id, matchedBy: "name", score: 1 };
    }
  }

  let best: { id: string; score: number } | null = null;
  for (const entry of comparable) {
    const score = bestSimilarity(candidateVariants, entry.variants);
    if (score === 0) continue;
    // Strictly greater, so ties keep the first (oldest, since callers order by
    // createdAt) candidate -- deterministic on replay.
    if (!best || score > best.score) best = { id: entry.set.id, score };
  }

  if (best) return { productSetId: best.id, matchedBy: "name", score: best.score };

  return { productSetId: null, matchedBy: "new" };
}

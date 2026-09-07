/**
 * ProductSet name-similarity primitives for lib/ingest/identity.ts's name tier
 * (external id -> code -> name -> new). Moved here from lib/crawler/dedup.ts at
 * the v1 cutover -- this half of that file was always v2's real dependency;
 * the other half (findMatchingEvent/dispositionFor, v1's own date-proximity
 * event dedup) retired along with the rest of lib/crawler.
 */

const MIN_NORMALIZED_NAME_LENGTH = 3;

/**
 * Normalizes a ProductSet name for cross-source identity matching: lowercase,
 * strip parenthetical annotations (e.g. a trailing set-code like "(EB-05)"),
 * strip all non-alphanumeric characters. Deliberately more aggressive/lossy
 * than a provider's own slug (which preserves structure for a stable id) --
 * this only ever answers "do these two scraped names mean the same real
 * product," never used as an id itself.
 *
 * Returns "" for names that are entirely punctuation/parenthetical content
 * (e.g. "(2026)") -- callers must treat an empty (or otherwise too-short)
 * result as "not matchable," never as a valid grouping key, or every such
 * ProductSet in an install would collide with each other.
 */
export function normalizeProductSetName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\([^)]*\)/g, "")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

export function isMatchableNormalizedName(normalized: string): boolean {
  return normalized.length >= MIN_NORMALIZED_NAME_LENGTH;
}

const FUZZY_SIMILARITY_THRESHOLD = 0.75;

// Words that recur across many genuinely different real products in every
// TCG's naming conventions (edition/format descriptors, articles) -- kept
// out of the significant-token set so two unrelated products don't score as
// similar purely because both happen to say "Booster Set" or "The X".
// Deliberately NOT included: anything that could itself be a product's
// distinguishing name (e.g. "chapter", "special") -- those must count.
const GENERIC_NAME_STOPWORDS = new Set([
  "the", "a", "an", "of", "and", "&",
  "set", "booster", "box", "pack", "packs", "collection", "expansion",
  "edition", "series", "deck", "starter", "bundle", "case", "tin", "blister",
  "trading", "card", "cards", "game",
]);

// A leading "Set 1:", "Series 2 -", "Chapter 3:" style label is a common
// cross-source formatting difference where one source states the sequence
// number redundantly and another only uses the title (e.g. lorcana.gg's
// "Set 1: The First Chapter" vs. Wikipedia's "The First Chapter"). Stripped
// from the tokenized title so the redundant label text doesn't count toward
// the word-overlap score. Its number is tracked separately (`sequenceNumber`
// below) from other bare numbers in the name, since the two need different
// mismatch rules -- see productSetNameSimilarity.
const SEQUENCE_LABEL_PREFIX = /^(set|series|volume|vol|chapter|part)\s*#?(\d+)\s*[:\-–—]\s*/i;

// A trailing short alphanumeric token containing at least one letter (e.g.
// "Reality Fracture FRA", "The Hobbit HOB", "Fourth Edition 4ED") is a
// source formatting artifact, not a real word -- some sources append the
// set's own code to the display name. Deliberately excludes an ALL-DIGIT
// trailing token (e.g. "Magic 2010" ending in "2010"): that's a real
// year/sequence number the `numbers` veto below must still be able to
// catch, not a code to discard.
const TRAILING_SOURCE_CODE = /\s+(?=[A-Z0-9]*[A-Z])[A-Z0-9]{2,5}$/;

function stripTrailingSourceCode(name: string): string {
  return name.replace(TRAILING_SOURCE_CODE, "");
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const item of a) if (!b.has(item)) return false;
  return true;
}

function significantTokens(name: string): { tokens: Set<string>; numbers: Set<string>; sequenceNumber: string | null } {
  const withoutParens = name.replace(/\([^)]*\)/g, " ");
  const prefixMatch = withoutParens.match(SEQUENCE_LABEL_PREFIX);
  const withoutSequenceLabel = withoutParens.replace(SEQUENCE_LABEL_PREFIX, " ");
  const rawTokens = withoutSequenceLabel.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const numbers = new Set(rawTokens.filter((t) => /^\d+$/.test(t)));
  const tokens = new Set(rawTokens.filter((t) => !GENERIC_NAME_STOPWORDS.has(t)));
  return { tokens, numbers, sequenceNumber: prefixMatch?.[2] ?? null };
}

/**
 * The same significant (stopword-filtered) tokens productSetNameSimilarity
 * scores on, exposed for bucketing candidates before a pairwise fuzzy-match
 * scan: two names with zero tokens in common always score 0 (Dice's
 * numerator is literally the shared-token count, and the exact-match-after-
 * code-strip path requires a nonempty, equal token set, which also implies
 * overlap), so grouping by shared token first -- instead of comparing every
 * pair in an install -- drops zero true matches while turning an O(n^2) scan
 * into one bounded by how many *other* sets share a word with each set,
 * which stopword-filtering already keeps small.
 */
export function significantTokenSet(name: string): Set<string> {
  return significantTokens(name).tokens;
}

/**
 * Dice coefficient over significant (stopword-filtered) name tokens, for
 * catching cross-source ProductSet name variants that share no substring
 * after `normalizeProductSetName` -- e.g. a redundant sequence-label prefix
 * on one side. Returns 0 (never matches) whenever the two names disagree on
 * a number:
 *  - a bare number outside a sequence-label prefix (e.g. "Foo Set" vs. "Foo
 *    Set 2") is the single most common way these products name genuinely
 *    different sequential releases, so ANY such mismatch vetoes -- including
 *    one side having it and the other not.
 *  - two DIFFERENT sequence-label numbers (e.g. "Series 1: Foo" vs. "Series
 *    2: Foo") always veto too, but a label appearing on only one side does
 *    not (that's the redundant-label case this is meant to catch).
 * No generic token heuristic can safely tell a sequel apart from a real
 * duplicate, so an unexplained number always wins over textual similarity.
 *
 * Deliberately does not catch every real-world duplicate (e.g. a set code
 * folded into the name, like "The Zeta Set SLZ" vs "Secret Lair: The Zeta
 * Set", has almost no token overlap) -- that class needs identity resolution
 * against a canonical per-TCG source, not string similarity.
 *
 * Before scoring, checked separately: with a trailing source code (see
 * TRAILING_SOURCE_CODE) stripped from each side, do the two names reduce to
 * the exact same significant tokens? A short/stopword-heavy title like "The
 * Hobbit" ("The" is a stopword, leaving one significant token) loses too
 * much of its Dice score to a single appended code ("The Hobbit HOB") to
 * ever cross FUZZY_SIMILARITY_THRESHOLD via the general scoring below, even
 * though it's the same set. This exact-match-after-code-strip is a
 * high-confidence special case that a longer title's Dice score already
 * covers on its own (e.g. "Reality Fracture" vs "Reality Fracture FRA"
 * scores 0.8 unaided) -- it only changes the outcome for the short-title
 * case, and an unrelated extra word (e.g. "Commander" in "Reality Fracture
 * Commander FRC") still makes the stripped token sets unequal, so that
 * falls through to the general score below unaffected.
 */
export function productSetNameSimilarity(a: string, b: string): number {
  const ta = significantTokens(a);
  const tb = significantTokens(b);

  const numbersDiffer =
    [...ta.numbers].some((n) => !tb.numbers.has(n)) || [...tb.numbers].some((n) => !ta.numbers.has(n));
  if (numbersDiffer) return 0;

  if (ta.sequenceNumber && tb.sequenceNumber && ta.sequenceNumber !== tb.sequenceNumber) return 0;

  // Checked after the vetoes above (an unexplained number/sequence-number
  // mismatch must still win over this), before the general Dice score: with
  // a trailing source code stripped from each side, do the two names reduce
  // to the exact same significant tokens?
  const strippedA = significantTokens(stripTrailingSourceCode(a));
  const strippedB = significantTokens(stripTrailingSourceCode(b));
  if (strippedA.tokens.size > 0 && setsEqual(strippedA.tokens, strippedB.tokens)) {
    return 1;
  }

  if (ta.tokens.size === 0 || tb.tokens.size === 0) return 0;

  let intersection = 0;
  for (const token of ta.tokens) {
    if (tb.tokens.has(token)) intersection += 1;
  }
  return (2 * intersection) / (ta.tokens.size + tb.tokens.size);
}

export function isFuzzyProductSetNameMatch(a: string, b: string): boolean {
  return productSetNameSimilarity(a, b) >= FUZZY_SIMILARITY_THRESHOLD;
}

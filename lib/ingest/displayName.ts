import { leadingSetCodeToken, normalizeSetCode } from "./identity";

/**
 * Canonicalizes the two fields a ProductSet is *named* by, for every provider
 * at once.
 *
 * This is deliberately separate from lib/ingest/nameMatching.ts, which reduces
 * a name to a lossy key for comparison and would be useless as a display
 * string. What runs here is the opposite job: the name a reader will actually
 * see on the calendar, cleaned of the artefacts of however it was scraped.
 *
 * It sits in Normalize (see normalizePayload) rather than in each provider
 * because the artefacts are not provider-specific -- Bulbapedia handed us the
 * literal name `"FLO"`, quote marks and all, and TCGplayer handed us
 * `Labyrinth_of_Nightmare`, a wiki URL slug wearing a title's clothes. Fixing
 * those one provider at a time means fixing them again for the next provider,
 * so this runs once, over every candidate, after the schema has validated it.
 *
 * Note what it does *not* do: it never invents, translates or reorders words.
 * Every transform below is the removal of a character a source used as syntax,
 * or the promotion of a code the source itself printed. "Reject, never coerce"
 * still governs everything typed -- dates, shapes, ids; a display string is the
 * one thing in a candidate whose exact bytes were never a fact to begin with.
 */

/**
 * Quote characters wrapping a *whole* name. Anchored to the ends only, so an
 * apostrophe inside a real title ("Winner's Pack", "Illumineer's Quest") is
 * untouched -- it is only the pair around the outside that is a source's
 * punctuation rather than part of what the product is called.
 */
const WRAPPING_QUOTES = /^["'‘’“”«»]+|["'‘’“”«»]+$/g;

/** The separator a code prefix is joined to the rest of the name with. */
const CODE_PREFIX_SEPARATOR = /^\s*[:\-–—]\s*/;

/**
 * Cleans one candidate's name, and lifts a code out of it when the origin
 * printed none of its own.
 *
 * Returns the pair rather than mutating, so the caller decides whether to keep
 * a result that cleaned away to nothing (it does not -- see below).
 */
export function cleanCandidateNaming(input: { name: string; code: string | null }): {
  name: string;
  code: string | null;
} {
  let name = input.name.trim();

  // Underscores are never word separators in a product's real name; they are
  // what a wiki URL slug uses where a title has spaces.
  name = name.replace(/_/g, " ");
  name = name.replace(WRAPPING_QUOTES, "");
  name = name.replace(/\s+/g, " ").trim();

  // Cleaning is only ever allowed to improve a name. A string that was nothing
  // but punctuation keeps whatever it had, so a candidate can still be rejected
  // downstream on its merits rather than on an empty string this made.
  if (!name) return { name: input.name.trim(), code: input.code };

  const code = input.code?.trim() || null;
  const prefix = leadingSetCodeToken(name);
  if (!prefix) return { name, code };

  const withoutPrefix = name.slice(prefix.length).replace(CODE_PREFIX_SEPARATOR, "").trim();
  // A name that is *only* a code ("SLX Cards" is not, "UE22BT" would be) has
  // nothing left to show once the prefix goes, so the prefix stays.
  if (!withoutPrefix) return { name, code };

  // No code of its own: the prefix is the best identifier this candidate has,
  // so promote it rather than leaving identity to guess from the name later.
  if (!code) return { name: withoutPrefix, code: prefix };

  // The origin's own code already says what the prefix says, so the prefix is
  // duplication and the reader loses nothing by dropping it. When the two
  // disagree the prefix is carrying something the code column is not (Pokemon's
  // "ME06: Delta Reign" under the abbreviation DLR), and it stays.
  return normalizeSetCode(prefix) === normalizeSetCode(code)
    ? { name: withoutPrefix, code }
    : { name, code };
}

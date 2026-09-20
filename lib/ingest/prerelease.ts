import type { CandidateDate } from "./types";

/**
 * What each game's prerelease schedule actually is, and the pure date maths
 * that turns a shelf date into the prerelease dates it implies.
 *
 * ## Why this file exists
 *
 * Prerelease dates are the one part of a release announcement that almost
 * nobody publishes in a machine-readable form. Three of our origins state one
 * at all: English Wikipedia's Magic list ("Pre-release date"), its Lorcana
 * article ("Local game store release"), and Riot's own news posts ("Pre-Rift").
 * Only the last of those was ever *published* by the gate, because it is
 * OFFICIAL tier and satisfies G1 on its own. The two Wikipedia columns are a
 * lone COMMUNITY claim: G1 wants OFFICIAL, G2 wants a second independent
 * origin, G3 wants a retailer -- so no rule fires and the event is HELD on
 * every run it has ever had.
 *
 * A held event has nothing to show. The gate expresses "don't move it" by
 * restating the published date, and an event no rule has ever endorsed has no
 * published date to restate -- findOrCreateReleaseEvent creates the row
 * dateless precisely so that a claim cannot smuggle a date past the rules. So
 * every Magic and Lorcana prerelease sits at TBD in the undated tab
 * indefinitely, however long Wikipedia has been stating it.
 *
 * Scraping harder does not fix that, because there is no second origin to find.
 * What there *is* instead is a schedule: these games run their prereleases on a
 * fixed weekday relative to the street date, publicly and consistently. So the
 * schedule below plays two roles:
 *
 *  - It is the **date check** that lets a sourced prerelease claim publish
 *    alone (gate rule G8), which turns a frozen held event into an ordinary
 *    published one that re-evaluates every run. Wikipedia saying "the
 *    prerelease is 2026-10-16" for a set shelving on Friday 2026-10-23 is
 *    corroborated by the game's own convention, and that is a real check -- a
 *    mis-parsed cell lands nowhere near the expected Friday and is never
 *    endorsed.
 *  - Where no source states one at all -- which is Pokemon, Yu-Gi-Oh! and One
 *    Piece entirely -- it is what the derivation pass (./derivePrereleases.ts)
 *    computes a prerelease event *from*.
 *
 * ## Why some games have no rule
 *
 * A missing entry here is a deliberate statement, not an oversight: every
 * installed game slug appears below, and the ones with no slots carry the
 * reason. Encoding a plausible-sounding offset for a game that does not
 * actually follow one would put a wrong date on a public calendar, which is
 * strictly worse than showing nothing.
 *
 * Nothing in this module touches the database or the clock, so every rule here
 * is testable against a literal (tests/ingestPrerelease.test.ts).
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// UTC day numbers. Every date in the pipeline is parsed to UTC midnight
// (lib/ingest/dateParsing.ts), so weekday maths must be UTC too -- getDay()
// would silently shift a Friday to a Thursday for anyone west of London.
const SUNDAY = 0;
const FRIDAY = 5;
const SATURDAY = 6;

/**
 * One prerelease occurrence a game's schedule predicts, expressed relative to
 * the street date rather than as a fixed day offset.
 *
 * Weekday-anchored on purpose. "Magic prereleases are the Friday before the
 * shelf date" and "shelf minus seven days" are the same thing only while every
 * street date is itself a Friday; the first stays true when a set ships on a
 * Thursday for a holiday, and the second quietly produces a Thursday
 * prerelease.
 */
export type PrereleaseSlot = {
  /**
   * Stable identifier for this occurrence within its game. Written to
   * ReleaseEvent.derivedSlot, so renaming one orphans its rows -- treat these
   * as permanent once shipped.
   */
  key: string;
  /** What the game itself calls this event, for the derived row's sourceSummary. */
  label: string;
  /** UTC day of week the occurrence lands on. */
  weekday: number;
  /**
   * Which occurrence of `weekday` before the street date, counting back: 1 is
   * the nearest one strictly before it, 2 the one a week earlier. This is how
   * Pokemon's two prerelease Fridays are told apart.
   */
  occurrence: number;
};

export type PrereleaseSchedule = {
  slots: readonly PrereleaseSlot[];
  /** Why this game has the slots it has -- or, for an empty list, why it has none. */
  note: string;
};

/**
 * The furthest before a street date a derived prerelease is allowed to land.
 *
 * A backstop against a degenerate anchor rather than a rule anyone follows: the
 * weekday maths below is only well-behaved for the Friday street dates these
 * games actually use, and a set shelving on, say, a Sunday would push the
 * Sunday slot a full week out. Three weeks comfortably clears every real
 * schedule here (Pokemon's furthest slot is 14 days) while refusing anything
 * that has clearly come from a bad anchor.
 */
export const MAX_PRERELEASE_LEAD_DAYS = 21;

/**
 * Per-game prerelease schedules, keyed by TcgProfilePackage slug.
 *
 * Every installed slug is listed, including the ones with no schedule, so that
 * "this game has no rule" is a recorded decision with a reason attached rather
 * than an absence somebody has to re-research. tests/ingestPrerelease.test.ts
 * asserts the key set against prisma/seed.ts, so adding a game without
 * considering its prereleases is a test failure.
 */
export const PRERELEASE_SCHEDULES: Readonly<Record<string, PrereleaseSchedule>> = {
  "magic-the-gathering": {
    slots: [{ key: "friday-1", label: "Prerelease weekend", weekday: FRIDAY, occurrence: 1 }],
    note:
      "Wizards runs prerelease weekends at local game stores starting the Friday before the Friday street " +
      "date. This is also the date English Wikipedia's set list states in its own 'Pre-release date' column, " +
      "which is what lets that column publish under G8 instead of sitting held forever.",
  },
  "disney-lorcana": {
    slots: [{ key: "friday-1", label: "Local game store release", weekday: FRIDAY, occurrence: 1 }],
    note:
      "Ravensburger gives local game stores a one-week head start on every set: Hyperia City reached stores " +
      "on Friday 2026-10-16 and wide retail on Friday 2026-10-23. Wikipedia's 'Local game store release' " +
      "column states the same date, so G8 corroborates it the same way it does Magic's.",
  },
  "one-piece-tcg": {
    slots: [{ key: "friday-1", label: "Pre-release event", weekday: FRIDAY, occurrence: 1 }],
    note:
      "Bandai's English One Piece pre-release events open the Friday a week before the street date (OP-17: " +
      "events from 2026-08-21, release 2026-08-28). The event window then stays open for weeks, but the " +
      "date worth putting on a calendar is the day the cards become playable.",
  },
  "pokemon-tcg": {
    slots: [
      { key: "friday-1", label: "Prerelease (second weekend)", weekday: FRIDAY, occurrence: 1 },
      { key: "friday-2", label: "Prerelease (first weekend)", weekday: FRIDAY, occurrence: 2 },
    ],
    note:
      "Pokemon prerelease tournaments run across the two weekends before the street date, so both Fridays " +
      "get an event. 'First'/'second weekend' in the labels is chronological, which is why the earlier " +
      "weekend is the slot with the larger occurrence.",
  },
  "yugioh-tcg": {
    slots: [
      { key: "saturday-1", label: "Sneak Peek (Saturday)", weekday: SATURDAY, occurrence: 1 },
      { key: "sunday-1", label: "Sneak Peek (Sunday)", weekday: SUNDAY, occurrence: 1 },
    ],
    note:
      "Konami's Sneak Peek events run the Saturday and Sunday before the street date. Two separate " +
      "single-day events rather than one weekend-long RANGE, because a player picks a day and a range " +
      "spanning a weekend reads on the calendar as a product that ships over two days.",
  },
  riftbound: {
    slots: [],
    note:
      "No derived schedule, and deliberately so: Riot publishes the Pre-Rift date itself on its news site " +
      "and lib/ingest/providers/playriftbound.ts reads it, which is an OFFICIAL claim that publishes under " +
      "G1 with no help from us. Deriving alongside that would put a computed date next to a stated one.",
  },
  "gundam-card-game": {
    slots: [],
    note:
      "No schedule to encode. Bandai announces a per-set 'Release Event' window rather than an offset, and " +
      "those windows do not sit before the street date consistently -- the ST11-ST14 window ran " +
      "2026-09-25 to 2026-10-08, opening on release day rather than before it.",
  },
  "union-arena-tcg": {
    slots: [],
    note:
      "No schedule to encode. Union Arena's 'Super Pre-Release' events were run for the game's launch " +
      "(2024-08-23, ahead of a 2024-09-08 release) rather than per set, and the interval was not a weekly " +
      "offset. Nothing here would generalise.",
  },
  "digimon-card-game": {
    slots: [],
    note:
      "No derived schedule, and deliberately so: Bandai states the Pre-Release date itself on its product " +
      "index and lib/ingest/providers/bandaiDigimon.ts reads it, which is an OFFICIAL claim that publishes " +
      "under G1. Only boosters have one (BT-26: 2026-08-28, a week before its 2026-09-04 release); starter " +
      "decks and EX boosters state none, so a computed date would invent events Bandai never scheduled.",
  },
  "flesh-and-blood": {
    slots: [],
    note:
      "No schedule encoded. None of this game's origins state a prerelease date, and the offset between a " +
      "main set's pre-release and its street date has not been verified against Legend Story Studios' own " +
      "announcements. Armory Decks, Mastery Packs and GEM Packs also ship without one, so a guessed weekday " +
      "rule would put wrong dates on a public calendar. Revisit once an official source can be read.",
  },
};

/** The schedule for a game slug, or null when the game has none (or is unknown). */
export function prereleaseScheduleFor(game: string): PrereleaseSchedule | null {
  const schedule = PRERELEASE_SCHEDULES[game];
  if (!schedule || schedule.slots.length === 0) return null;
  return schedule;
}

/**
 * The `occurrence`-th `weekday` strictly before `anchor`, in UTC.
 *
 * "Strictly" is what makes the Magic case come out right: for a Friday anchor
 * and a Friday slot the nearest Friday before it is seven days earlier, not
 * the anchor itself.
 */
export function nthWeekdayBefore(anchor: Date, weekday: number, occurrence: number): Date {
  let back = (anchor.getUTCDay() - weekday + 7) % 7;
  if (back === 0) back = 7;
  back += (occurrence - 1) * 7;
  return new Date(anchor.getTime() - back * MS_PER_DAY);
}

/** One predicted prerelease, tagged with the slot it came from. */
export type PrereleaseOccurrence = {
  slotKey: string;
  label: string;
  date: CandidateDate;
};

/**
 * The prerelease dates a game's schedule predicts for one shelf date.
 *
 * Only an EXACT shelf date produces anything. A month or quarter window has no
 * weekday to count back from, and picking one would manufacture a precision the
 * source never stated -- "October 2026" would become a specific Friday that
 * nobody has announced, on a calendar whose whole point is that dates are
 * traceable to evidence.
 */
export function prereleaseOccurrencesFor(game: string, shelfDate: CandidateDate | null): PrereleaseOccurrence[] {
  const schedule = prereleaseScheduleFor(game);
  if (!schedule || !shelfDate || shelfDate.kind !== "EXACT") return [];

  const occurrences: PrereleaseOccurrence[] = [];
  for (const slot of schedule.slots) {
    const date = nthWeekdayBefore(shelfDate.date, slot.weekday, slot.occurrence);
    const leadDays = (shelfDate.date.getTime() - date.getTime()) / MS_PER_DAY;
    if (leadDays <= 0 || leadDays > MAX_PRERELEASE_LEAD_DAYS) continue;
    occurrences.push({ slotKey: slot.key, label: slot.label, date: { kind: "EXACT", date } });
  }
  return occurrences;
}

/**
 * Just the dates, for gate rule G8's check on a sourced prerelease claim.
 *
 * Separate from the full occurrence list because the gate must stay ignorant of
 * slots: it is deciding whether one claim's date is consistent with the game's
 * conventions, not which weekend of a schedule the claim is talking about.
 */
export function expectedPrereleaseDates(game: string, shelfDate: CandidateDate | null): CandidateDate[] {
  return prereleaseOccurrencesFor(game, shelfDate).map((occurrence) => occurrence.date);
}

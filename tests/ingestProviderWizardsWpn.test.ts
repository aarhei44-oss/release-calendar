import { describe, expect, it } from "vitest";
import { ParseError } from "@/lib/ingest/normalize";
import {
  MAX_DATES_PAGES,
  fetchWizardsWpn,
  parseWpnDateCell,
  setNameFromTitle,
  wizardsWpnProvider,
} from "@/lib/ingest/providers/wizardsWpn";
import { ORIGINS, originsAreIndependent, type Candidate } from "@/lib/ingest/types";
import { loadFixture, parseFixture } from "./fixtures/ingest/helpers";

/**
 * wizardsWpn.pages.json is a trimmed recording of wpn.wizards.com/en/news and its
 * three "Dates & Details" posts (Star Trek, Marvel: Darkhold Destiny, Reality
 * Fracture), captured 2026-10-14. Each page is cut down to the parts the parser
 * reads: the title, the post's publish line, the key-dates table, the Scheduled
 * Events section and the dates-page links.
 *
 * The three pages are deliberately the three year shapes Wizards uses: Darkhold
 * states years in the table, Star Trek leaves them out of the table but states
 * them in Scheduled Events, and Reality Fracture states them nowhere at all.
 */

const FETCHED_AT = new Date("2026-10-14T20:30:00.000Z");
const FIXTURE = loadFixture<{ index: string; pages: Record<string, string> }>("wizardsWpn.pages.json");

function parse(value: unknown = FIXTURE, fetchedAt = FETCHED_AT): Candidate[] {
  return parseFixture(wizardsWpnProvider, value, fetchedAt);
}

function find(candidates: Candidate[], name: string, type: Candidate["type"]): Candidate | undefined {
  return candidates.find((c) => c.name === name && c.type === type);
}

const utc = (iso: string) => new Date(`${iso}T00:00:00Z`);

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

describe("wizards-wpn provider: shape", () => {
  it("speaks for Wizards, at OFFICIAL tier", () => {
    expect(wizardsWpnProvider.origin).toBe("wizards-official");
    expect(wizardsWpnProvider.tier).toBe("OFFICIAL");
    expect(ORIGINS["wizards-official"].tier).toBe("OFFICIAL");
    expect(ORIGINS["wizards-official"].derivesFrom).toBeNull();
  });

  it("covers only Magic", () => {
    expect(wizardsWpnProvider.games).toEqual(["magic-the-gathering"]);
  });

  it("is independent of the retailer and the wiki but not of Scryfall, which derives from it", () => {
    expect(originsAreIndependent("wizards-official", "tcgplayer", ORIGINS)).toBe(true);
    expect(originsAreIndependent("wizards-official", "wikipedia", ORIGINS)).toBe(true);
    expect(originsAreIndependent("wizards-official", "scryfall", ORIGINS)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Field mapping
// ---------------------------------------------------------------------------

describe("wizards-wpn provider: field mapping", () => {
  it("reads a set's shelf date and prerelease window from the key-dates table", () => {
    const candidates = parse();
    expect(find(candidates, "Marvel: Darkhold Destiny", "SHELF")?.date).toEqual({ kind: "EXACT", date: utc("2027-04-09") });
    expect(find(candidates, "Marvel: Darkhold Destiny", "PRERELEASE")?.date).toEqual({
      kind: "RANGE",
      start: utc("2027-04-02"),
      end: utc("2027-04-08"),
    });
  });

  it("names the set from the page title, without the series prefix, trademark marks or site suffix", () => {
    const names = new Set(parse().map((c) => c.name));
    expect(names).toEqual(new Set(["Marvel: Darkhold Destiny", "Reality Fracture", "Star Trek"]));
  });

  it("yields exactly a SHELF and a PRERELEASE per page, with no code and the page as its id and URL", () => {
    const candidates = parse();
    expect(candidates).toHaveLength(6);
    const trek = find(candidates, "Star Trek", "SHELF");
    expect(trek).toMatchObject({
      origin: "wizards-official",
      game: "magic-the-gathering",
      code: null,
      region: "GLOBAL",
      url: "https://wpn.wizards.com/en/news/star-trek-dates-and-details",
    });
    expect(trek?.externalIds).toEqual({ "wizards-official": "star-trek-dates-and-details" });
  });

  it("does not turn the Commander Party, league or marketing-kit dates into events", () => {
    // Star Trek's page also states Commander Party weeks, a league running to
    // 2027-01-28 and a marketing-kit delivery window. None is a release.
    for (const candidate of parse().filter((c) => c.name === "Star Trek")) {
      expect(["SHELF", "PRERELEASE"]).toContain(candidate.type);
    }
    const dates = parse()
      .filter((c) => c.name === "Star Trek")
      .map((c) => c.date);
    expect(dates).toEqual([
      { kind: "EXACT", date: utc("2026-11-13") },
      { kind: "RANGE", start: utc("2026-11-06"), end: utc("2026-11-12") },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Years
// ---------------------------------------------------------------------------

describe("wizards-wpn provider: a table that omits the year", () => {
  it("takes it from Scheduled Events (Star Trek: 'November 6-12' + 'November 13')", () => {
    const candidates = parse();
    expect(find(candidates, "Star Trek", "SHELF")?.date).toEqual({ kind: "EXACT", date: utc("2026-11-13") });
    expect(find(candidates, "Star Trek", "PRERELEASE")?.date).toEqual({
      kind: "RANGE",
      start: utc("2026-11-06"),
      end: utc("2026-11-12"),
    });
  });

  it("takes it from the post's publish date when Scheduled Events states none (Reality Fracture)", () => {
    // 'September 25-October 1' / 'October 2', posted Sep 9, 2026: a range that
    // crosses a month, and a page with no year anywhere in its body.
    const candidates = parse();
    expect(find(candidates, "Reality Fracture", "SHELF")?.date).toEqual({ kind: "EXACT", date: utc("2026-10-02") });
    expect(find(candidates, "Reality Fracture", "PRERELEASE")?.date).toEqual({
      kind: "RANGE",
      start: utc("2026-09-25"),
      end: utc("2026-10-01"),
    });
  });

  it("drops a date it has no year for rather than guessing one", () => {
    const noYearAnywhere =
      "<html><head><title>Magic: The Gathering | Mystery Set - Dates &amp; Details | WPN</title></head><body>" +
      '<table class="key-dates"><tr><td>Prerelease</td><td>May 1-7</td></tr><tr><td>Release</td><td>May 8</td></tr></table>' +
      "</body></html>";
    expect(parse({ index: FIXTURE.index, pages: { "mystery-set-dates-and-details": noYearAnywhere } })).toEqual([]);
  });
});

describe("parseWpnDateCell", () => {
  it("prefers a year the cell states over any hint", () => {
    expect(parseWpnDateCell("April 9, 2027", 2026, null)).toEqual({ start: utc("2027-04-09"), end: utc("2027-04-09") });
    expect(parseWpnDateCell("April 2–8, 2027", 2026, null)).toEqual({ start: utc("2027-04-02"), end: utc("2027-04-08") });
  });

  it("accepts an en dash, an em dash or a hyphen in a range", () => {
    for (const dash of ["–", "—", "-", " - "]) {
      expect(parseWpnDateCell(`November 6${dash}12`, 2026, null)).toEqual({ start: utc("2026-11-06"), end: utc("2026-11-12") });
    }
  });

  it("reads a range that crosses a month, and one that crosses the year", () => {
    expect(parseWpnDateCell("September 25–October 1", 2026, null)).toEqual({
      start: utc("2026-09-25"),
      end: utc("2026-10-01"),
    });
    expect(parseWpnDateCell("December 29–January 4", 2026, null)).toEqual({
      start: utc("2026-12-29"),
      end: utc("2027-01-04"),
    });
  });

  it("puts a year-less date after its floor, rolling into the next year when it would not be", () => {
    // A January release after a late-December prerelease.
    const prereleaseEnd = utc("2026-12-31");
    expect(parseWpnDateCell("January 8", 2026, prereleaseEnd)).toEqual({ start: utc("2027-01-08"), end: utc("2027-01-08") });
    // ...and the usual case stays in the same year.
    expect(parseWpnDateCell("November 13", 2026, utc("2026-11-12"))).toEqual({ start: utc("2026-11-13"), end: utc("2026-11-13") });
  });

  it("falls back to the floor's own year when there is no hint", () => {
    expect(parseWpnDateCell("October 2", null, utc("2026-09-08"))).toEqual({ start: utc("2026-10-02"), end: utc("2026-10-02") });
    expect(parseWpnDateCell("February 5", null, utc("2026-12-01"))).toEqual({ start: utc("2027-02-05"), end: utc("2027-02-05") });
  });

  it("returns null for a year-less cell with nothing to anchor it, and for text it does not understand", () => {
    expect(parseWpnDateCell("November 13", null, null)).toBeNull();
    expect(parseWpnDateCell("TBA", 2026, null)).toBeNull();
    expect(parseWpnDateCell("", 2026, null)).toBeNull();
  });

  it("rejects a date that does not exist instead of rolling it into the next month", () => {
    expect(parseWpnDateCell("February 30, 2027", null, null)).toBeNull();
    expect(parseWpnDateCell("November 13–31", 2026, null)).toBeNull();
  });

  it("rejects a same-month range that runs backwards", () => {
    expect(parseWpnDateCell("November 12–6", 2026, null)).toBeNull();
  });
});

describe("setNameFromTitle", () => {
  it("strips the series prefix, trademark marks, the 'Dates & Details' suffix and the site name", () => {
    expect(setNameFromTitle("Magic: The Gathering® | Star Trek™ – Dates & Details | WPN")).toBe("Star Trek");
    expect(setNameFromTitle("Magic: The Gathering® | Marvel: Darkhold Destiny – Dates & Details | WPN")).toBe(
      "Marvel: Darkhold Destiny",
    );
  });

  it("handles a title with no series prefix", () => {
    expect(setNameFromTitle("Reality Fracture – Dates & Details | WPN")).toBe("Reality Fracture");
  });
});

// ---------------------------------------------------------------------------
// Tolerated shapes
// ---------------------------------------------------------------------------

describe("wizards-wpn provider: unusual key-dates tables", () => {
  const page = (rows: string) =>
    "<html><head><title>Magic: The Gathering | Test Set – Dates &amp; Details | WPN</title></head><body>" +
    "<p>Jan 5, 2027 — Events</p>" +
    `<table class="key-dates">${rows}</table></body></html>`;

  it("reads a row whose label carries Wizards' '(updated)' annotation", () => {
    const html = page(
      "<tr><td>Prerelease <span>(updated)</span></td><td>February 5-11, 2027</td></tr>" +
        "<tr><td>Release (updated)</td><td>February 12, 2027</td></tr>",
    );
    const candidates = parse({ index: FIXTURE.index, pages: { "test-set-dates-and-details": html } });
    expect(find(candidates, "Test Set", "SHELF")?.date).toEqual({ kind: "EXACT", date: utc("2027-02-12") });
    expect(find(candidates, "Test Set", "PRERELEASE")?.date).toMatchObject({ kind: "RANGE" });
  });

  it("emits only the shelf event when there is no prerelease row", () => {
    const html = page("<tr><td>Release</td><td>February 12, 2027</td></tr>");
    const candidates = parse({ index: FIXTURE.index, pages: { "test-set-dates-and-details": html } });
    expect(candidates.map((c) => c.type)).toEqual(["SHELF"]);
  });

  it("emits no shelf event for a release that is still 'TBA'", () => {
    const html = page("<tr><td>Prerelease</td><td>February 5-11, 2027</td></tr><tr><td>Release</td><td>TBA</td></tr>");
    const candidates = parse({ index: FIXTURE.index, pages: { "test-set-dates-and-details": html } });
    expect(candidates.map((c) => c.type)).toEqual(["PRERELEASE"]);
  });

  it("makes a one-day prerelease an EXACT date rather than a one-day range", () => {
    const html = page("<tr><td>Prerelease</td><td>February 5, 2027</td></tr><tr><td>Release</td><td>February 12, 2027</td></tr>");
    const candidates = parse({ index: FIXTURE.index, pages: { "test-set-dates-and-details": html } });
    expect(find(candidates, "Test Set", "PRERELEASE")?.date).toEqual({ kind: "EXACT", date: utc("2027-02-05") });
  });
});

// ---------------------------------------------------------------------------
// Forward window
// ---------------------------------------------------------------------------

describe("wizards-wpn provider: forward window", () => {
  it("drops a set whose dates are more than 90 days behind the fetch", () => {
    // On 2027-03-01 Reality Fracture (Oct 2) and Star Trek (Nov 13) have long
    // shipped; Darkhold Destiny (Apr 9) is still ahead.
    const names = new Set(parse(FIXTURE, new Date("2027-03-01T00:00:00Z")).map((c) => c.name));
    expect(names).toEqual(new Set(["Marvel: Darkhold Destiny"]));
  });
});

// ---------------------------------------------------------------------------
// Drift
// ---------------------------------------------------------------------------

describe("wizards-wpn provider: a site redesign fails loudly", () => {
  it("raises ParseError, naming the index, when the news list yields no dates-page links", () => {
    try {
      parse({ index: "<html><body><p>hello</p></body></html>", pages: {} });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ParseError);
      expect((error as ParseError).providerKey).toBe("wizards-wpn");
      expect((error as ParseError).path).toBe("index");
    }
  });

  it("raises ParseError when pages were fetched but none has a key-dates table", () => {
    const restyled = "<html><head><title>Magic | Star Trek – Dates &amp; Details | WPN</title></head><body><p>no table</p></body></html>";
    try {
      parse({ index: FIXTURE.index, pages: { "star-trek-dates-and-details": restyled } });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ParseError);
      expect((error as ParseError).path).toBe("pages");
    }
  });

  it("tolerates one table-less page among good ones", () => {
    const pages = { ...FIXTURE.pages, "other-dates-and-details": "<html><head><title>x</title></head><body></body></html>" };
    expect(parse({ index: FIXTURE.index, pages })).toHaveLength(6);
  });

  it("tolerates an index with links but no pages fetched, as on a replay of a trimmed payload", () => {
    expect(parse({ index: FIXTURE.index, pages: {} })).toEqual([]);
  });

  it("rejects a payload that is not the {index, pages} shape", () => {
    expect(() => parse({ index: "<html></html>" })).toThrow(ParseError);
    expect(() => parse({ index: 42, pages: {} })).toThrow(ParseError);
  });
});

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

describe("wizards-wpn provider: fetch", () => {
  const BASE = "https://wpn.wizards.com/en/news";
  const link = (slug: string) => `<a href="/en/news/${slug}">${slug}</a>`;
  const html = (...slugs: string[]) => `<html><body>${slugs.map(link).join("")}</body></html>`;

  /** A fake site: path -> html, anything else 404. Records what was requested. */
  function site(routes: Record<string, string>) {
    const requested: string[] = [];
    const fetchStub = (async (url: string) => {
      requested.push(url);
      const body = routes[url];
      return body === undefined ? new Response("missing", { status: 404 }) : new Response(body, { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    return { requested, fetchStub };
  }

  async function run(routes: Record<string, string>, contentHash?: string) {
    const { requested, fetchStub } = site(routes);
    const payload = await fetchWizardsWpn({ scanRunId: "test-run", fetch: fetchStub, now: FETCHED_AT, contentHash });
    return { payload, requested };
  }

  it("fetches every dates page the index links, and not the other posts", async () => {
    const { payload, requested } = await run({
      [BASE]: html("a-dates-and-details", "weekly-magic-leagues-a-habit-worth-building"),
      [`${BASE}/a-dates-and-details`]: "<html></html>",
    });
    expect(payload.status).toBe("OK");
    expect(requested).toEqual([BASE, `${BASE}/a-dates-and-details`]);
  });

  it("follows a dates page's links to older dates pages that have scrolled off the index", async () => {
    const { payload, requested } = await run({
      [BASE]: html("new-dates-and-details"),
      [`${BASE}/new-dates-and-details`]: html("old-dates-and-details"),
      [`${BASE}/old-dates-and-details`]: "<html></html>",
    });
    expect(payload.status).toBe("OK");
    expect(requested).toContain(`${BASE}/old-dates-and-details`);
  });

  it("fetches a page linked from several places once, and survives a link loop", async () => {
    const { requested } = await run({
      [BASE]: html("a-dates-and-details", "b-dates-and-details"),
      [`${BASE}/a-dates-and-details`]: html("b-dates-and-details", "a-dates-and-details"),
      [`${BASE}/b-dates-and-details`]: html("a-dates-and-details"),
    });
    expect(requested.filter((url) => url.endsWith("/a-dates-and-details"))).toHaveLength(1);
    expect(requested.filter((url) => url.endsWith("/b-dates-and-details"))).toHaveLength(1);
  });

  it("caps how many pages one run will fetch", async () => {
    const slugs = Array.from({ length: MAX_DATES_PAGES + 8 }, (_, i) => `set-${i}-dates-and-details`);
    const routes: Record<string, string> = { [BASE]: html(...slugs) };
    for (const slug of slugs) routes[`${BASE}/${slug}`] = "<html></html>";
    const { requested } = await run(routes);
    expect(requested.length).toBe(MAX_DATES_PAGES + 1);
    // The shared fetch layer leaves 400 ms between requests to one host, so
    // thirteen of them outlast vitest's default 5 s.
  }, 30_000);

  it("fails the provider when a page the index links cannot be fetched", async () => {
    const { payload } = await run({ [BASE]: html("gone-dates-and-details") });
    expect(payload.status).toBe("FAILED");
    expect(payload.error).toContain("gone-dates-and-details");
  });

  it("skips a page found only through a related-links block when it has been removed", async () => {
    const { payload } = await run({
      [BASE]: html("new-dates-and-details"),
      [`${BASE}/new-dates-and-details`]: html("removed-dates-and-details"),
    });
    expect(payload.status).toBe("OK");
  });

  it("fails the provider when the index itself cannot be fetched", async () => {
    const { payload } = await run({});
    expect(payload.status).toBe("FAILED");
  });

  it("stores pages without their scripts and styles", async () => {
    const { decodePayloadBody } = await import("@/lib/ingest/normalize");
    const heavy =
      "<html><head><title>t</title><style>.x{color:red}</style><script>window.__NUXT__={}</script></head>" +
      "<body><p>kept</p></body></html>";
    const { payload } = await run({ [BASE]: html("a-dates-and-details"), [`${BASE}/a-dates-and-details`]: heavy });
    const stored = decodePayloadBody(payload) as { pages: Record<string, string> };
    expect(stored.pages["a-dates-and-details"]).toContain("kept");
    expect(stored.pages["a-dates-and-details"]).not.toContain("__NUXT__");
    expect(stored.pages["a-dates-and-details"]).not.toContain("color:red");
  });

  it("reports NOT_MODIFIED, carrying the hash forward, when the assembled payload is unchanged", async () => {
    const routes = { [BASE]: html("a-dates-and-details"), [`${BASE}/a-dates-and-details`]: "<html></html>" };
    const first = await run(routes);
    const second = await run(routes, first.payload.contentHash);
    expect(second.payload.status).toBe("NOT_MODIFIED");
    expect(second.payload.contentHash).toBe(first.payload.contentHash);
  });

  it("round-trips: what fetch stores, parse reads", async () => {
    const trek = FIXTURE.pages["star-trek-dates-and-details"];
    const { payload } = await run({ [BASE]: FIXTURE.index, [`${BASE}/star-trek-dates-and-details`]: trek, [`${BASE}/marvel-darkhold-destiny-dates-and-details`]: FIXTURE.pages["marvel-darkhold-destiny-dates-and-details"], [`${BASE}/reality-fracture-dates-and-details`]: FIXTURE.pages["reality-fracture-dates-and-details"] });
    expect(payload.status).toBe("OK");
    const candidates = wizardsWpnProvider.parse(payload);
    expect(find(candidates, "Star Trek", "SHELF")?.date).toEqual({ kind: "EXACT", date: utc("2026-11-13") });
    expect(candidates).toHaveLength(6);
  });
});

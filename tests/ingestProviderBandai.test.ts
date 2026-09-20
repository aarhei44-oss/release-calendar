import { describe, expect, it } from "vitest";
import { DIGIMON_PAGES, bandaiDigimonProvider } from "@/lib/ingest/providers/bandaiDigimon";
import { GUNDAM_PAGES, bandaiGundamProvider } from "@/lib/ingest/providers/bandaiGundam";
import { ONE_PIECE_PAGES, bandaiOnePieceProvider } from "@/lib/ingest/providers/bandaiOnePiece";
import { bandaiUnionArenaProvider } from "@/lib/ingest/providers/bandaiUnionArena";
import { ParseError } from "@/lib/ingest/normalize";
import { FORWARD_WINDOW_DAYS } from "@/lib/ingest/providers/shared";
import { ORIGINS, originsAreIndependent, type Candidate } from "@/lib/ingest/types";
import { loadFixture, parseFixture } from "./fixtures/ingest/helpers";

/**
 * bandaiOnePiece.pages.json and bandaiGundam.pages.json are verbatim recordings
 * of en.onepiece-cardgame.com/products/ (pages 1-3) and
 * www.gundam-gcg.com/en/products/, captured on 2026-09-04.
 * bandaiUnionArena.pages.json is a trimmed recording of
 * unionarena-tcg.com/na/products/ and its COMING SOON products' own detail
 * pages, captured 2026-09-05.
 *
 * These three providers are the pipeline's OFFICIAL-tier origins, so they are
 * also the claims that can satisfy gate rule G1 -- one official source
 * publishing a date on its own. Before the first two, One Piece and Gundam had
 * tcgcsv alone and every date had to survive seven consecutive runs of G3's
 * retailer streak first; Union Arena is new to the registry entirely and never
 * had that problem to begin with, launching with tcgcsv (RETAILER) and this
 * provider (OFFICIAL) together.
 *
 * They are also the only providers that read an ordinary web page rather than an
 * API, which is why the drift tests below matter more here than anywhere else:
 * a redesign has to fail loudly in this file, not quietly in production.
 */

const FETCHED_AT = new Date("2026-09-04T20:00:00.000Z");
const ONE_PIECE_FIXTURE = loadFixture<Record<string, string>>("bandaiOnePiece.pages.json");
const GUNDAM_FIXTURE = loadFixture<Record<string, string>>("bandaiGundam.pages.json");
// world.digimoncard.com/products/, trimmed to ten of its <article> rows (boosters,
// starter decks, a Premium Bandai pack and box, and a playmat) on 2026-09-19.
const DIGIMON_FETCHED_AT = new Date("2026-09-19T12:00:00.000Z");
const DIGIMON_FIXTURE = loadFixture<Record<string, string>>("bandaiDigimon.pages.json");
const UNION_ARENA_FETCHED_AT = new Date("2026-09-05T12:00:00.000Z");
const UNION_ARENA_FIXTURE = loadFixture<{ index: string; products: Record<string, string> }>(
  "bandaiUnionArena.pages.json",
);

function parseOnePiece(value: unknown = ONE_PIECE_FIXTURE, fetchedAt = FETCHED_AT): Candidate[] {
  return parseFixture(bandaiOnePieceProvider, value, fetchedAt);
}

function parseGundam(value: unknown = GUNDAM_FIXTURE, fetchedAt = FETCHED_AT): Candidate[] {
  return parseFixture(bandaiGundamProvider, value, fetchedAt);
}

function parseUnionArena(value: unknown = UNION_ARENA_FIXTURE, fetchedAt = UNION_ARENA_FETCHED_AT): Candidate[] {
  return parseFixture(bandaiUnionArenaProvider, value, fetchedAt);
}

function parseDigimon(value: unknown = DIGIMON_FIXTURE, fetchedAt = DIGIMON_FETCHED_AT): Candidate[] {
  return parseFixture(bandaiDigimonProvider, value, fetchedAt);
}

function byName(candidates: Candidate[], fragment: string): Candidate | undefined {
  return candidates.find((candidate) => candidate.name.includes(fragment));
}

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

describe("Bandai providers: shape", () => {
  it("speaks for the publisher, at OFFICIAL tier", () => {
    for (const provider of [bandaiOnePieceProvider, bandaiGundamProvider, bandaiUnionArenaProvider, bandaiDigimonProvider]) {
      expect(provider.origin).toBe("bandai-official");
      expect(provider.tier).toBe("OFFICIAL");
      expect(ORIGINS["bandai-official"].tier).toBe("OFFICIAL");
      // A primary source, so nothing upstream of it -- which is what lets a
      // single claim publish under G1 rather than needing a second opinion.
      expect(ORIGINS["bandai-official"].derivesFrom).toBeNull();
    }
  });

  it("is independent of the retailer, so its games gain corroboration as well as authority", () => {
    expect(originsAreIndependent("bandai-official", "tcgplayer", ORIGINS)).toBe(true);
  });

  it("covers one game each, and fetches only the English sites", () => {
    expect(bandaiOnePieceProvider.games).toEqual(["one-piece-tcg"]);
    expect(bandaiGundamProvider.games).toEqual(["gundam-card-game"]);
    expect(bandaiUnionArenaProvider.games).toEqual(["union-arena-tcg"]);
    expect(bandaiDigimonProvider.games).toEqual(["digimon-card-game"]);
    for (const page of DIGIMON_PAGES) expect(page.url).toContain("world.digimoncard.com/products/");
    for (const page of ONE_PIECE_PAGES) expect(page.url).toContain("en.onepiece-cardgame.com");
    for (const page of GUNDAM_PAGES) expect(page.url).toContain("gundam-gcg.com/en/");
  });
});

// ---------------------------------------------------------------------------
// One Piece
// ---------------------------------------------------------------------------

describe("bandai-onepiece provider: field mapping", () => {
  it("reads a booster's name, code and exact street date", () => {
    const booster = byName(parseOnePiece(), "THE WORLD’S STRONGEST WARRIORS");
    expect(booster).toMatchObject({
      origin: "bandai-official",
      game: "one-piece-tcg",
      code: "OP-17",
      region: "GLOBAL",
      type: "SHELF",
      date: { kind: "EXACT", date: new Date("2026-08-28T00:00:00Z") },
      externalIds: { "bandai-official": "onepiece:op17" },
    });
    // The bracketed code is carried on `code`, not repeated in the name.
    expect(booster?.name).not.toContain("[OP-17]");
  });

  it("keeps a month-granularity release a month, not the first of it", () => {
    // Bandai's `datetime` attribute reads 2026-10-01 for a product it describes
    // as "October 2026". Reading the attribute would turn a month-wide official
    // window into an exact official date that nothing could contradict.
    const extra = byName(parseOnePiece(), "ONE PIECE HEROINES EDITION vol.2");
    expect(extra?.code).toBe("EB-05");
    expect(extra?.date).toEqual({
      kind: "WINDOW",
      granularity: "MONTH",
      start: new Date("2026-10-01T00:00:00Z"),
      end: new Date("2026-10-31T00:00:00Z"),
    });
  });

  it("ignores Premium Bandai 'Delivery Month' rows", () => {
    // A mail-order fulfilment window is not a street date, and at OFFICIAL tier
    // a single claim publishes unopposed -- so this filter is load-bearing.
    expect(byName(parseOnePiece(), "Live Action Edition vol.2 Baroque Works")).toBeUndefined();
    expect(byName(parseOnePiece(), "ONE PIECE Heroines Special Set")).toBeUndefined();
  });

  it("ignores rows with no date at all", () => {
    expect(byName(parseOnePiece(), "Chinese 3rd Anniversary Set")).toBeUndefined();
  });

  it("ignores accessories, which carry no set code", () => {
    // At OFFICIAL tier a lone claim publishes under G1 with nothing to
    // corroborate or contradict it, so an unfiltered product index would put
    // playmats and sleeves straight onto the calendar. Bandai prints a
    // bracketed set code on card products and on nothing else, which is the
    // filter -- and the four "Flame-Flame Fruit Coliseum Edition" accessories
    // are also four products that share a name tail exactly, so admitting them
    // would hand identity resolution a merge it should never have to refuse.
    for (const accessory of [
      "Official Playmat",
      "Limited Card Sleeve",
      "Official Storage Box",
      "Illustration Box",
      "OFFICIAL CARD SLEEVES",
    ]) {
      expect(byName(parseOnePiece(), accessory), accessory).toBeUndefined();
    }
    expect(parseOnePiece().every((candidate) => candidate.code)).toBe(true);
  });

  it("yields codes that pair with the retailer's abbreviations", () => {
    // The whole point: tcgcsv abbreviates these sets "OP17", "SD01", "ST-31",
    // "EB-05", and identity.ts normalizes both sides to one key. Without a
    // shared code these names would never match -- Bandai writes
    // "BOOSTER PACK -THE WORLD’S STRONGEST WARRIORS-" for what TCGplayer calls
    // "The World's Strongest Warriors".
    const codes = new Set(parseOnePiece().map((candidate) => candidate.code));
    for (const code of ["OP-17", "SD-01", "ST-36", "EB-05"]) {
      expect(codes, `${code} should be on the page`).toContain(code);
    }
  });

  it("applies the forward window, so an old page of the index costs nothing downstream", () => {
    const dates = parseOnePiece().map((candidate) => candidate.date);
    const cutoff = FETCHED_AT.getTime() - FORWARD_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    for (const date of dates) {
      const anchor = date.kind === "EXACT" ? date.date : date.kind === "TBD" ? null : date.start;
      if (anchor) expect(anchor.getTime()).toBeGreaterThanOrEqual(cutoff);
    }
    // ...and it really does exclude things: OP-13 shipped in November 2025 and
    // is on page 3 of the fixture.
    expect(byName(parseOnePiece(), "CARRYING ON HIS WILL")).toBeUndefined();
  });

  it("carries a per-product URL onto the claim, and an id that survives the two link shapes", () => {
    // The index links to a product two ways -- "/products/eb05.html" on one
    // page and "/products/boosters/op17/" on another -- so the external id is
    // the final path segment rather than the URL, which keeps one product on
    // one SetIdentity when Bandai moves it between the two.
    const booster = byName(parseOnePiece(), "THE WORLD’S STRONGEST WARRIORS");
    expect(booster?.url).toBe("https://en.onepiece-cardgame.com/products/boosters/op17/");
    expect(booster?.externalIds).toEqual({ "bandai-official": "onepiece:op17" });

    const extra = byName(parseOnePiece(), "ONE PIECE HEROINES EDITION vol.2");
    expect(extra?.url).toBe("https://en.onepiece-cardgame.com/products/eb05.html");
    expect(extra?.externalIds).toEqual({ "bandai-official": "onepiece:eb05" });
  });
});

// ---------------------------------------------------------------------------
// Gundam
// ---------------------------------------------------------------------------

describe("bandai-gundam provider: field mapping", () => {
  it("reads the booster carousel", () => {
    const booster = byName(parseGundam(), "Stardust Trails");
    expect(booster).toMatchObject({
      origin: "bandai-official",
      game: "gundam-card-game",
      name: "Stardust Trails",
      code: "GD06",
      region: "GLOBAL",
      type: "SHELF",
      date: { kind: "EXACT", date: new Date("2026-10-30T00:00:00Z") },
      externalIds: { "bandai-official": "gundam:gd06" },
    });
  });

  it("reads the starter-deck carousel, whose codes tcgcsv also publishes", () => {
    const decks = parseGundam().filter((candidate) => candidate.code?.startsWith("ST"));
    expect(decks.map((deck) => deck.code).sort()).toEqual(["ST11", "ST12", "ST13", "ST14"]);
    for (const deck of decks) {
      expect(deck.date).toEqual({ kind: "EXACT", date: new Date("2026-09-25T00:00:00Z") });
    }
  });

  it("ignores accessories, which carry no set code", () => {
    // Same reasoning as the One Piece filter: G1 publishes a lone OFFICIAL
    // claim, so an unfiltered index would put card cases and sleeves on the
    // calendar on the first run.
    for (const accessory of ["Official Card Case Set", "Official Card Sleeves", "Official Playmat"]) {
      expect(byName(parseGundam(), accessory), accessory).toBeUndefined();
    }
    expect(parseGundam().every((candidate) => candidate.code)).toBe(true);
  });

  it("reassembles a title broken across line breaks, and a date written without its space", () => {
    // The product grids write titles across <br> and print "September 25,2026"
    // where the carousels print "September 25, 2026". Exercised on a fragment
    // in the page's own shape because every grid row in the recording is
    // outside the ninety-day window.
    const fragment = `<div class="detailBox"><a href="pc09a.html"></a><div class="txtBox">
      <div class="date">October 30,2026</div>
      <h3 class="title">Premium Card Collection <br>GUNDAM ASSEMBLE Set <br><span>-Mobile Suit Gundam- [PC09A]</span></h3>
    </div></div>`;
    const [candidate] = parseGundam({ "gundam-products": fragment });
    expect(candidate.name).toBe("Premium Card Collection GUNDAM ASSEMBLE Set -Mobile Suit Gundam-");
    expect(candidate.code).toBe("PC09A");
    expect(candidate.date).toEqual({ kind: "EXACT", date: new Date("2026-10-30T00:00:00Z") });
  });

  it("emits each product once even though the page repeats blocks", () => {
    const slugs = parseGundam().map((candidate) => candidate.externalIds["bandai-official"]);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("applies the forward window", () => {
    // GD05 "Freedom Ascension" shipped 2026-07-24, inside the window; the
    // February 2026 GUNDAM ASSEMBLE sets are outside it.
    expect(byName(parseGundam(), "Freedom Ascension")).toBeDefined();
    expect(byName(parseGundam(), "GUNDAM ASSEMBLE")).toBeUndefined();
  });

  it("namespaces its external ids by game, since one origin covers two", () => {
    // SetIdentity is unique on (origin, externalId): an unprefixed "st11" would
    // collide with One Piece's ST-11 and pin two products to one ProductSet.
    for (const candidate of parseGundam()) {
      expect(candidate.externalIds["bandai-official"] ?? "gundam:").toMatch(/^gundam:/);
    }
    for (const candidate of parseOnePiece()) {
      expect(candidate.externalIds["bandai-official"] ?? "onepiece:").toMatch(/^onepiece:/);
    }
  });
});

// ---------------------------------------------------------------------------
// Union Arena
// ---------------------------------------------------------------------------

describe("bandai-unionarena provider: field mapping", () => {
  it("reads a booster's name, code and release date from the index plus its own detail page", () => {
    const booster = byName(parseUnionArena(), "D.Gray-man");
    expect(booster).toMatchObject({
      origin: "bandai-official",
      game: "union-arena-tcg",
      name: "D.Gray-man",
      code: "UE28BT",
      region: "GLOBAL",
      type: "SHELF",
      date: { kind: "EXACT", date: new Date("2026-11-20T00:00:00Z") },
      externalIds: { "bandai-official": "unionarena:boosters/dgm-1" },
      url: "https://www.unionarena-tcg.com/na/products/boosters/dgm-1.php",
    });
  });

  it("disambiguates a booster and a starter deck that share one franchise slug", () => {
    // Bandai reuses "upd-1" for both "boosters/upd-1.php" and "decks/upd-1.php"
    // -- two different products with two different codes. The category has to
    // be part of the identity key, or one would silently overwrite the other.
    const candidates = parseUnionArena().filter((c) => c.name === "Umamusume: Pretty Derby");
    expect(candidates).toHaveLength(2);
    const booster = candidates.find((c) => c.code === "UE27BT");
    const deck = candidates.find((c) => c.code === "UE27ST");
    expect(booster?.externalIds).toEqual({ "bandai-official": "unionarena:boosters/upd-1" });
    expect(deck?.externalIds).toEqual({ "bandai-official": "unionarena:decks/upd-1" });
  });

  it("ignores rows tagged as merchandise, which never carry a set code", () => {
    expect(byName(parseUnionArena(), "Anniversary")).toBeUndefined();
  });

  it("ignores rows outside the COMING SOON section, even a dated, coded one", () => {
    // "Already Out" sits under AVAILABLE NOW in the fixture; discovery is
    // scoped to COMING SOON only, on purpose -- see bandaiUnionArena.ts.
    expect(byName(parseUnionArena(), "Already Out")).toBeUndefined();
  });

  it("applies the forward window", () => {
    // "Ancient History" is dated May 1, 2026 -- more than 90 days before the
    // fixture's fetchedAt of September 5, 2026.
    expect(byName(parseUnionArena(), "Ancient History")).toBeUndefined();
  });

  it("ignores a row whose detail page carries no bracketed code", () => {
    expect(byName(parseUnionArena(), "Untitled Collaboration")).toBeUndefined();
    expect(parseUnionArena().every((candidate) => candidate.code)).toBe(true);
  });

  it("tolerates a product missing from a replayed payload without inventing drift", () => {
    // "Not Yet Fetched" is discoverable from the index but has no entry under
    // `products` in the fixture -- the same situation a 304 on that one page
    // would leave behind.
    expect(byName(parseUnionArena(), "Not Yet Fetched")).toBeUndefined();
    expect(parseUnionArena().length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Drift
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Digimon
// ---------------------------------------------------------------------------

describe("bandai-digimon provider: field mapping", () => {
  it("reads a booster's name, code and street date, with the game prefix and code stripped from the name", () => {
    const booster = parseDigimon().find((candidate) => candidate.code === "BT-26" && candidate.type === "SHELF");
    expect(booster).toMatchObject({
      origin: "bandai-official",
      game: "digimon-card-game",
      name: "TIMELESS BONDS",
      region: "GLOBAL",
      date: { kind: "EXACT", date: new Date("2026-09-04T00:00:00Z") },
      url: "https://world.digimoncard.com/products/pack/ver26/",
      externalIds: { "bandai-official": "digimon:pack/ver26" },
    });
  });

  it("turns a stated Pre-Release date into a PRERELEASE event for the same set", () => {
    const prerelease = parseDigimon().find((candidate) => candidate.code === "BT-26" && candidate.type === "PRERELEASE");
    expect(prerelease).toMatchObject({
      name: "TIMELESS BONDS",
      date: { kind: "EXACT", date: new Date("2026-08-28T00:00:00Z") },
      externalIds: { "bandai-official": "digimon:pack/ver26" },
    });
  });

  it("emits no PRERELEASE for a product that states none", () => {
    const candidates = parseDigimon().filter((candidate) => candidate.code === "EX-13");
    expect(candidates.map((candidate) => candidate.type)).toEqual(["SHELF"]);
    expect(candidates[0].date).toEqual({ kind: "EXACT", date: new Date("2026-10-02T00:00:00Z") });
  });

  it("reads starter decks, whose links are root-relative", () => {
    // ST-24 shipped 2026-05-15, which is outside the forward window of the
    // 2026-09-19 capture, so the same bytes are read as of a scan run that week.
    const deck = parseDigimon(DIGIMON_FIXTURE, new Date("2026-05-10T12:00:00Z")).find(
      (candidate) => candidate.code === "ST-24",
    );
    expect(deck).toMatchObject({
      name: "DIGIMON DATA SQUAD",
      url: "https://world.digimoncard.com/products/deck/st-24/",
      externalIds: { "bandai-official": "digimon:deck/st-24" },
    });
  });

  it("leaves out Premium Bandai items and goods, which state conflicting regional dates or are not cards", () => {
    const codes = parseDigimon().map((candidate) => candidate.code);
    expect(codes).not.toContain("LM-09");
    expect(codes).not.toContain("PB-26");
    for (const candidate of parseDigimon()) {
      expect(candidate.name).not.toMatch(/playmat|sleeve/i);
    }
  });

  it("drops products that shipped before the forward window", () => {
    // BT-25 released 2026-05-22, more than 90 days before the capture.
    expect(parseDigimon().some((candidate) => candidate.code === "BT-25")).toBe(false);
  });

  it("carries a code on every candidate, which is what pairs it with the retailer's row", () => {
    for (const candidate of parseDigimon()) expect(candidate.code).toMatch(/^[A-Z]{2}-\d{2}$/);
  });
});

describe("Bandai providers: a page redesign fails loudly", () => {
  it("raises ParseError when no product rows match", () => {
    // The failure this guards against is not a crash, it is a *silence*: a
    // provider that yields nothing looks healthy in every log while the events
    // it used to support age out through rule G7 as if cancelled.
    expect(() => parseOnePiece({ "op-products-1": "<html><body><p>hello</p></body></html>" })).toThrow(ParseError);
    expect(() => parseGundam({ "gundam-products": "<html><body><main></main></body></html>" })).toThrow(ParseError);
    expect(() =>
      parseUnionArena({ index: "<html><body><p>hello</p></body></html>", products: {} }),
    ).toThrow(ParseError);
  });

  it("raises ParseError when rows survive but the dates move", () => {
    const stripped = ONE_PIECE_FIXTURE["op-products-1"].replace(/<p class="linkListColDate"[\s\S]*?<\/p>/g, "");
    expect(() => parseOnePiece({ "op-products-1": stripped })).toThrow(/none carried a release date/);
  });

  it("names the provider and the field on the error, so a run diff can say what broke", () => {
    try {
      parseGundam({ "gundam-products": "<html></html>" });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ParseError);
      expect((error as ParseError).providerKey).toBe("bandai-gundam");
      expect((error as ParseError).path).toBe("rows");
    }
  });

  it("tolerates a page missing from a replayed payload without inventing drift", () => {
    // Replaying a payload captured when the index was two pages long must not
    // look like a redesign.
    const partial = { "op-products-1": ONE_PIECE_FIXTURE["op-products-1"] };
    expect(parseOnePiece(partial).length).toBeGreaterThan(0);
  });

  it("rejects a payload that is not a page map at all", () => {
    expect(() => parseGundam({ "gundam-products": 42 })).toThrow(ParseError);
  });

  it("names the provider and the field on the Union Arena index-drift error", () => {
    try {
      parseUnionArena({ index: "<html></html>", products: {} });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ParseError);
      expect((error as ParseError).providerKey).toBe("bandai-unionarena");
      expect((error as ParseError).path).toBe("index");
    }
  });

  it("throws a ParseError naming the Digimon provider when no product rows match", () => {
    try {
      parseDigimon({ "digimon-products": "<html><body><article data-url='x'></article></body></html>" });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ParseError);
      expect((error as ParseError).providerKey).toBe("bandai-digimon");
      expect((error as ParseError).path).toBe("rows");
    }
  });

  it("rejects a Union Arena payload that is not the {index, products} shape", () => {
    expect(() => parseUnionArena({ index: "<html></html>" })).toThrow(ParseError);
    expect(() => parseUnionArena({ index: 42, products: {} })).toThrow(ParseError);
  });
});

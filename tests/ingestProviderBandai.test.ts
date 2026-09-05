import { describe, expect, it } from "vitest";
import { GUNDAM_PAGES, bandaiGundamProvider } from "@/lib/ingest/providers/bandaiGundam";
import { ONE_PIECE_PAGES, bandaiOnePieceProvider } from "@/lib/ingest/providers/bandaiOnePiece";
import { ParseError } from "@/lib/ingest/normalize";
import { FORWARD_WINDOW_DAYS } from "@/lib/ingest/providers/shared";
import { ORIGINS, originsAreIndependent, type Candidate } from "@/lib/ingest/types";
import { loadFixture, parseFixture } from "./fixtures/ingest/helpers";

/**
 * bandaiOnePiece.pages.json and bandaiGundam.pages.json are verbatim recordings
 * of en.onepiece-cardgame.com/products/ (pages 1-3) and
 * www.gundam-gcg.com/en/products/, captured on 2026-09-04.
 *
 * These two providers are the pipeline's first OFFICIAL-tier origins, so they
 * are also the first claims that can satisfy gate rule G1 -- one official source
 * publishing a date on its own. Before them, One Piece and Gundam had tcgcsv
 * alone and every date had to survive seven consecutive runs of G3's retailer
 * streak first.
 *
 * They are also the only providers that read an ordinary web page rather than an
 * API, which is why the drift tests below matter more here than anywhere else:
 * a redesign has to fail loudly in this file, not quietly in production.
 */

const FETCHED_AT = new Date("2026-09-04T20:00:00.000Z");
const ONE_PIECE_FIXTURE = loadFixture<Record<string, string>>("bandaiOnePiece.pages.json");
const GUNDAM_FIXTURE = loadFixture<Record<string, string>>("bandaiGundam.pages.json");

function parseOnePiece(value: unknown = ONE_PIECE_FIXTURE, fetchedAt = FETCHED_AT): Candidate[] {
  return parseFixture(bandaiOnePieceProvider, value, fetchedAt);
}

function parseGundam(value: unknown = GUNDAM_FIXTURE, fetchedAt = FETCHED_AT): Candidate[] {
  return parseFixture(bandaiGundamProvider, value, fetchedAt);
}

function byName(candidates: Candidate[], fragment: string): Candidate | undefined {
  return candidates.find((candidate) => candidate.name.includes(fragment));
}

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

describe("Bandai providers: shape", () => {
  it("speaks for the publisher, at OFFICIAL tier", () => {
    for (const provider of [bandaiOnePieceProvider, bandaiGundamProvider]) {
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
// Drift
// ---------------------------------------------------------------------------

describe("Bandai providers: a page redesign fails loudly", () => {
  it("raises ParseError when no product rows match", () => {
    // The failure this guards against is not a crash, it is a *silence*: a
    // provider that yields nothing looks healthy in every log while the events
    // it used to support age out through rule G7 as if cancelled.
    expect(() => parseOnePiece({ "op-products-1": "<html><body><p>hello</p></body></html>" })).toThrow(ParseError);
    expect(() => parseGundam({ "gundam-products": "<html><body><main></main></body></html>" })).toThrow(ParseError);
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
});

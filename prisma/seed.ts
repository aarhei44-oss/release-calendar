import { prisma } from "../lib/prisma";
import type { SourceConfig } from "../lib/crawler/adapters/types";

// Real sources, spot-checked manually against live pages (Phase 6): each
// reliably yields dozens of dated sets via the generic html-table adapter.
// Tier is COMMUNITY for all three since none is the TCG publisher's own
// official site -- Wikipedia/tracker pages, not Pokémon/WotC/Bandai.
const POKEMON_SOURCES: SourceConfig[] = [
  {
    url: "https://en.wikipedia.org/wiki/List_of_Pok%C3%A9mon_Trading_Card_Game_sets",
    tier: "COMMUNITY",
    parser: "html-table",
    options: { codePrefix: "PKM", eventType: "SHELF", region: "GLOBAL" },
  },
  {
    url: "https://bulbapedia.bulbagarden.net/wiki/List_of_Pok%C3%A9mon_Trading_Card_Game_expansions",
    tier: "COMMUNITY",
    parser: "html-table",
    options: { codePrefix: "PKM", eventType: "SHELF", region: "GLOBAL" },
  },
  {
    url: "https://pokemoncardlist.net/sets",
    tier: "COMMUNITY",
    parser: "html-table",
    options: { codePrefix: "PKM", eventType: "SHELF", region: "GLOBAL" },
  },
  // Bulbapedia's "Set no." header wins the default "set" hint via startsWith
  // ahead of the real name column, so it's pinned explicitly. Japanese-name
  // cells glue native + translated text with no separator (a cheerio
  // artifact of the source markup, e.g. "拡張パックExpansion Pack") -- names
  // aren't display-clean, but dates and set identity are correct.
  {
    url: "https://bulbapedia.bulbagarden.net/wiki/List_of_Japanese_Pok%C3%A9mon_Trading_Card_Game_expansions",
    tier: "COMMUNITY",
    parser: "html-table",
    options: { codePrefix: "PKM", eventType: "SHELF", region: "JP", nameColumnHints: ["japanese name"] },
  },
];

const MTG_SOURCES: SourceConfig[] = [
  {
    url: "https://en.wikipedia.org/wiki/List_of_Magic:_The_Gathering_sets",
    tier: "COMMUNITY",
    parser: "html-table",
    options: { codePrefix: "MTG", eventType: "SHELF", region: "GLOBAL" },
  },
  // Community-run MTG wiki (self-hosted MediaWiki, not Fandom-hosted --
  // Fandom blocks the crawler's UA site-wide).
  {
    url: "https://mtg.wiki/page/List_of_Magic_releases",
    tier: "COMMUNITY",
    parser: "html-table",
    options: { codePrefix: "MTG", eventType: "SHELF", region: "GLOBAL" },
  },
  // Scryfall's public sets index (not their JS-heavy card search) uses a
  // literal "Date" header, which none of the default date hints match, so
  // it's pinned. Name cells pick up the set's code suffix via a sibling
  // span (e.g. "Star Trek TRK") -- noisy but not garbage.
  {
    url: "https://scryfall.com/sets",
    tier: "COMMUNITY",
    parser: "html-table",
    options: { codePrefix: "MTG", eventType: "SHELF", region: "GLOBAL", dateColumnHints: ["date"] },
  },
];

const ONE_PIECE_SOURCES: SourceConfig[] = [
  {
    url: "https://opboxindex.com/articles/one-piece-set-list-release-dates.html",
    tier: "COMMUNITY",
    parser: "html-table",
    options: {
      codePrefix: "OP",
      eventType: "SHELF",
      region: "GLOBAL",
      nameColumnHints: ["name"],
      dateColumnHints: ["en release", "release"],
    },
  },
  {
    url: "https://playvault.ae/pages/one-piece-card-game-set-list",
    tier: "COMMUNITY",
    parser: "html-table",
    options: { codePrefix: "OP", eventType: "SHELF", region: "GLOBAL" },
  },
  {
    url: "https://www.misprint.com/posts/one-piece-tcg-release-calendar",
    tier: "COMMUNITY",
    parser: "html-table",
    options: { codePrefix: "OP", eventType: "SHELF", region: "GLOBAL" },
  },
  // Uses full "Month Day, Year" dates, unlike the other two OP sources
  // (month-only) -- gives exact-date corroboration instead of just windows.
  {
    url: "https://japan-figure.com/blogs/news/one-piece-tcg-release-date",
    tier: "COMMUNITY",
    parser: "html-table",
    options: { codePrefix: "OP", eventType: "SHELF", region: "GLOBAL" },
  },
];

// Spot-checked manually against the live page: the Wikipedia table's "Set
// number" column would otherwise be picked up as the name column ahead of
// "Set name" since it also matches the default "set" hint, so both columns
// need to be pinned explicitly here.
const LORCANA_SOURCES: SourceConfig[] = [
  {
    url: "https://en.wikipedia.org/wiki/Disney_Lorcana",
    tier: "COMMUNITY",
    parser: "html-table",
    options: {
      codePrefix: "LOR",
      eventType: "SHELF",
      region: "GLOBAL",
      nameColumnHints: ["set name"],
      dateColumnHints: ["retail release"],
    },
  },
  {
    url: "https://tcg-pricetracker.com/en/blog/lorcana-sets-list",
    tier: "COMMUNITY",
    parser: "html-table",
    options: { codePrefix: "LOR", eventType: "SHELF", region: "GLOBAL" },
  },
  // "Set #" would otherwise win the default "set" hint via startsWith ahead
  // of the real name column ("Expansion Name"), so it's pinned explicitly.
  // Set names here match Wikipedia/tcg-pricetracker's naming exactly, so
  // productSetCode values line up for real corroboration -- rejected
  // lorcana.gg despite it parsing fine, since its "Set 1: The First
  // Chapter"-style names would slugify to a different code and spawn
  // duplicate, never-reconciled product sets instead.
  {
    url: "https://lorcanacollectors.com/lorcana-sets-release-order/",
    tier: "COMMUNITY",
    parser: "html-table",
    options: { codePrefix: "LOR", eventType: "SHELF", region: "GLOBAL", nameColumnHints: ["expansion name"] },
  },
];

// Wikipedia's Riftbound table's default "Set name"/"Release date" headers
// already match the adapter's default column hints -- no overrides needed.
const RIFTBOUND_SOURCES: SourceConfig[] = [
  {
    url: "https://en.wikipedia.org/wiki/Riftbound",
    tier: "COMMUNITY",
    parser: "html-table",
    options: { codePrefix: "RIFT", eventType: "SHELF", region: "GLOBAL" },
  },
  {
    url: "https://riftboundcardlist.com/guides/riftbound-sets-in-order",
    tier: "COMMUNITY",
    parser: "html-table",
    options: { codePrefix: "RIFT", eventType: "SHELF", region: "GLOBAL" },
  },
  // Covers forward-looking sets only (Radiance onward); complements
  // riftboundcardlist.com rather than duplicating it. inksighttcg.com tracks
  // 8 different TCGs on the same /guides/*.html template -- worth reusing
  // for other installs.
  {
    url: "https://inksighttcg.com/riftbound/guides/riftbound-2027-roadmap.html",
    tier: "COMMUNITY",
    parser: "html-table",
    options: { codePrefix: "RIFT", eventType: "SHELF", region: "GLOBAL" },
  },
];

// gundamcardlist.com covers booster sets, starter decks, and tokens/promos
// as three separate same-shaped tables on one page; the adapter scans every
// table, so all three feed in together (tokens/promos have no release date
// and land as TBD, which is correct). Dates on this site are ISO
// (2026-07-25), which is why parseFlexibleDate needed ISO support added.
const GUNDAM_SOURCES: SourceConfig[] = [
  {
    url: "https://gundamcardlist.com/sets",
    tier: "COMMUNITY",
    parser: "html-table",
    options: { codePrefix: "GDM", eventType: "SHELF", region: "GLOBAL" },
  },
  {
    url: "https://japan-figure.com/blogs/news/gundam-card-game-release-date",
    tier: "COMMUNITY",
    parser: "html-table",
    options: { codePrefix: "GDM", eventType: "SHELF", region: "GLOBAL" },
  },
  // Header is "Product", not "Name"/"Set", so the default name hints miss it
  // entirely -- pinned explicitly. Two not-yet-titled sets both show
  // literally "[Title TBA]", which slugify to the same code -- a real
  // collision until Bandai announces those titles, not an adapter bug.
  {
    url: "https://chobanovgamesltd.com/blog-article/gundam-card-game-release-schedule-2025-2026-dates-products-us-pre-order-links.html",
    tier: "COMMUNITY",
    parser: "html-table",
    options: { codePrefix: "GDM", eventType: "SHELF", region: "GLOBAL", nameColumnHints: ["product"] },
  },
  // A general history/rules guide article rather than a dedicated tracker
  // (three tables on the page; the pinned hints below also keep the adapter
  // from misfiring on the other two, a card-type glossary and a
  // pack-structure table). Included despite the less-dedicated source
  // since it verified cleanly (11/14 dated) and Gundam otherwise only had
  // two sources.
  {
    url: "https://cardsmania.fun/gundam-card-game-guide-history-japanese-cards-sets/",
    tier: "COMMUNITY",
    parser: "html-table",
    options: {
      codePrefix: "GDM",
      eventType: "SHELF",
      region: "GLOBAL",
      nameColumnHints: ["product"],
      dateColumnHints: ["english-us date"],
    },
  },
];

// Both spot-checked manually against live pages. Dates from both cross-
// verified against ICv2's 2026 TCG calendar (e.g. "Magnificent Monsters"
// Sept 4 2026 on both). Deliberately excludes Yugipedia's "Set chronology"
// page despite otherwise being the most complete source: it's one page with
// OCG (Japan), TCG (English), and Rush Duel set tables -- all using the
// *same* column headers -- interleaved as 27 separate <table>s under one URL
// with no way to select just the TCG ones (MediaWiki's action=render&section=
// was tried and just returns the full page here), so including it would
// label Japan-only OCG sets as GLOBAL/English releases under the wrong dates
// -- same call as rejecting lorcana.gg in LORCANA_SOURCES, for a worse reason.
const YUGIOH_SOURCES: SourceConfig[] = [
  {
    // "Set"/"Release" headers match the adapter's default hints, no
    // overrides needed. The name cell carries two secondary links ("card
    // list", "prices") after the real name on every single row -- initially
    // shipped assuming that was cosmetic noise like Bulbapedia's/Scryfall's,
    // but it isn't: identical boilerplate on ~1000 of this install's ~1040
    // product sets was inflating dedup.ts's fuzzy name-similarity score
    // across the board, wrongly merging unrelated sets (e.g. "Abyss Rising"
    // into "Rage of the Abyss") on the strength of shared chrome text alone.
    // nameStripSuffixes removes it outright rather than tolerating it.
    url: "https://yugiohcardlist.com/sets",
    tier: "COMMUNITY",
    parser: "html-table",
    options: {
      codePrefix: "YGO",
      eventType: "SHELF",
      region: "GLOBAL",
      nameStripSuffixes: ["card list · prices"],
    },
  },
  // Japan-only OCG release schedule -- Konami's OCG (Japan) and TCG
  // (English/global) product lines share set names but ship on different
  // dates (e.g. "Chaos Origins" OCG Apr 25 2026 vs. TCG Jul 3 2026), so this
  // is tagged region: "JP" rather than folded into the GLOBAL source above.
  // "Set Name"/"Release Date" headers also match the default hints as-is.
  {
    url: "https://japan-figure.com/blogs/news/yugioh-card-release-date",
    tier: "COMMUNITY",
    parser: "html-table",
    options: { codePrefix: "YGO", eventType: "SHELF", region: "JP" },
  },
];

const LAUNCH_PACKAGES = [
  {
    slug: "pokemon-tcg",
    name: "Pokémon Trading Card Game",
    version: "1.0.0",
    description: "Booster sets, prereleases, and promos for the Pokémon TCG.",
    discoveryConfig: { defaultStrategy: "html-table" },
    sourceConfigs: POKEMON_SOURCES,
    installedVersion: "1.0.0",
    productSets: [
      { code: "SV-STARTER", name: "Sample Booster Set", releaseQuarter: "2026-Q1" },
    ],
  },
  {
    slug: "magic-the-gathering",
    name: "Magic: The Gathering",
    version: "1.0.0",
    description: "Set releases and prereleases for Magic: The Gathering.",
    discoveryConfig: { defaultStrategy: "html-table" },
    sourceConfigs: MTG_SOURCES,
    installedVersion: "1.0.0",
    productSets: [
      { code: "MTG-STARTER", name: "Sample Expansion", releaseQuarter: "2026-Q1" },
    ],
  },
  {
    slug: "one-piece-tcg",
    name: "One Piece Card Game",
    version: "1.0.0",
    description: "Booster and starter deck releases for the One Piece Card Game.",
    discoveryConfig: { defaultStrategy: "html-table" },
    sourceConfigs: ONE_PIECE_SOURCES,
    installedVersion: "1.0.0",
    productSets: [
      { code: "OP-STARTER", name: "Sample Booster Set", releaseQuarter: "2026-Q1" },
    ],
  },
  {
    slug: "disney-lorcana",
    name: "Disney Lorcana",
    version: "1.0.0",
    description: "Set releases for Disney Lorcana.",
    discoveryConfig: { defaultStrategy: "html-table" },
    sourceConfigs: LORCANA_SOURCES,
    installedVersion: "1.0.0",
    productSets: [
      { code: "LOR-STARTER", name: "Sample Booster Set", releaseQuarter: "2026-Q1" },
    ],
  },
  {
    slug: "gundam-card-game",
    name: "Gundam Card Game",
    version: "1.0.0",
    description: "Booster and starter deck releases for the Gundam Card Game.",
    discoveryConfig: { defaultStrategy: "html-table" },
    sourceConfigs: GUNDAM_SOURCES,
    installedVersion: "1.0.0",
    productSets: [
      { code: "GDM-STARTER", name: "Sample Booster Set", releaseQuarter: "2026-Q1" },
    ],
  },
  {
    slug: "riftbound",
    name: "Riftbound",
    version: "1.0.0",
    description: "Set releases for Riftbound: League of Legends Trading Card Game.",
    discoveryConfig: { defaultStrategy: "html-table" },
    sourceConfigs: RIFTBOUND_SOURCES,
    installedVersion: "1.0.0",
    productSets: [
      { code: "RIFT-STARTER", name: "Sample Booster Set", releaseQuarter: "2026-Q1" },
    ],
  },
  {
    slug: "yugioh-tcg",
    name: "Yu-Gi-Oh! Trading Card Game",
    version: "1.0.0",
    description: "Core booster sets, structure decks, and special releases for the Yu-Gi-Oh! Trading Card Game.",
    discoveryConfig: { defaultStrategy: "html-table" },
    sourceConfigs: YUGIOH_SOURCES,
    installedVersion: "1.0.0",
    productSets: [
      { code: "YGO-STARTER", name: "Sample Booster Set", releaseQuarter: "2026-Q1" },
    ],
  },
] as const;

async function main() {
  for (const pkg of LAUNCH_PACKAGES) {
    const profilePackage = await prisma.tcgProfilePackage.upsert({
      where: { slug: pkg.slug },
      update: {
        name: pkg.name,
        version: pkg.version,
        description: pkg.description,
        discoveryConfig: pkg.discoveryConfig,
        sourceConfigs: pkg.sourceConfigs,
      },
      create: {
        slug: pkg.slug,
        name: pkg.name,
        version: pkg.version,
        description: pkg.description,
        discoveryConfig: pkg.discoveryConfig,
        sourceConfigs: pkg.sourceConfigs,
      },
    });

    const existingInstall = await prisma.tcgProfileInstall.findFirst({
      where: { packageId: profilePackage.id },
    });

    const install =
      existingInstall ??
      (await prisma.tcgProfileInstall.create({
        data: {
          packageId: profilePackage.id,
          installedVersion: pkg.installedVersion,
          enabled: true,
        },
      }));

    for (const set of pkg.productSets) {
      const productSet = await prisma.productSet.upsert({
        where: {
          tcgProfileInstallId_code: {
            tcgProfileInstallId: install.id,
            code: set.code,
          },
        },
        update: { name: set.name, releaseQuarter: set.releaseQuarter },
        create: {
          tcgProfileInstallId: install.id,
          code: set.code,
          name: set.name,
          releaseQuarter: set.releaseQuarter,
        },
      });

      const existingEvent = await prisma.releaseEvent.findFirst({
        where: { productSetId: productSet.id, type: "SHELF" },
      });

      if (!existingEvent) {
        const shelfDate = new Date();
        shelfDate.setDate(shelfDate.getDate() + 30);

        await prisma.releaseEvent.create({
          data: {
            productSetId: productSet.id,
            type: "SHELF",
            dateType: "EXACT",
            dateExact: shelfDate,
            status: "ANNOUNCED",
            confidence: 0.6,
            sourceSummary: "Seeded sample data",
          },
        });
      }
    }
  }

  console.log("Seed complete.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

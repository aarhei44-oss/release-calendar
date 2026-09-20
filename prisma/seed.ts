import { prisma } from "../lib/prisma";

// sourceConfigs is empty on every package below: it was v1 crawler config
// (lib/crawler/adapters/*, retired at the v1 cutover), and the v2 ingest
// pipeline's providers (lib/ingest/providers/*) are registered in code, not
// read from this column -- see ingest-v2-plan.md.
const LAUNCH_PACKAGES = [
  {
    slug: "pokemon-tcg",
    name: "Pokémon Trading Card Game",
    version: "1.0.0",
    description: "Booster sets, prereleases, and promos for the Pokémon TCG.",
    discoveryConfig: { defaultStrategy: "html-table" },
    sourceConfigs: [],
    installedVersion: "1.0.0",
    productSets: [
      { code: "SV-STARTER", name: "Sample Booster Set" },
    ],
  },
  {
    slug: "magic-the-gathering",
    name: "Magic: The Gathering",
    version: "1.0.0",
    description: "Set releases and prereleases for Magic: The Gathering.",
    discoveryConfig: { defaultStrategy: "html-table" },
    sourceConfigs: [],
    installedVersion: "1.0.0",
    productSets: [
      { code: "MTG-STARTER", name: "Sample Expansion" },
    ],
  },
  {
    slug: "one-piece-tcg",
    name: "One Piece Card Game",
    version: "1.0.0",
    description: "Booster and starter deck releases for the One Piece Card Game.",
    discoveryConfig: { defaultStrategy: "html-table" },
    sourceConfigs: [],
    installedVersion: "1.0.0",
    productSets: [
      { code: "OP-STARTER", name: "Sample Booster Set" },
    ],
  },
  {
    slug: "disney-lorcana",
    name: "Disney Lorcana",
    version: "1.0.0",
    description: "Set releases for Disney Lorcana.",
    discoveryConfig: { defaultStrategy: "html-table" },
    sourceConfigs: [],
    installedVersion: "1.0.0",
    productSets: [
      { code: "LOR-STARTER", name: "Sample Booster Set" },
    ],
  },
  {
    slug: "gundam-card-game",
    name: "Gundam Card Game",
    version: "1.0.0",
    description: "Booster and starter deck releases for the Gundam Card Game.",
    discoveryConfig: { defaultStrategy: "html-table" },
    sourceConfigs: [],
    installedVersion: "1.0.0",
    productSets: [
      { code: "GDM-STARTER", name: "Sample Booster Set" },
    ],
  },
  {
    slug: "riftbound",
    name: "Riftbound",
    version: "1.0.0",
    description: "Set releases for Riftbound: League of Legends Trading Card Game.",
    discoveryConfig: { defaultStrategy: "html-table" },
    sourceConfigs: [],
    installedVersion: "1.0.0",
    productSets: [
      { code: "RIFT-STARTER", name: "Sample Booster Set" },
    ],
  },
  {
    slug: "yugioh-tcg",
    name: "Yu-Gi-Oh! Trading Card Game",
    version: "1.0.0",
    description: "Core booster sets, structure decks, and special releases for the Yu-Gi-Oh! Trading Card Game.",
    discoveryConfig: { defaultStrategy: "html-table" },
    sourceConfigs: [],
    installedVersion: "1.0.0",
    productSets: [
      { code: "YGO-STARTER", name: "Sample Booster Set" },
    ],
  },
  {
    slug: "union-arena-tcg",
    name: "Union Arena",
    version: "1.0.0",
    description: "Booster and starter deck releases for the Union Arena Trading Card Game.",
    discoveryConfig: { defaultStrategy: "html-table" },
    sourceConfigs: [],
    installedVersion: "1.0.0",
    productSets: [
      { code: "UA-STARTER", name: "Sample Booster Set" },
    ],
  },
  {
    slug: "flesh-and-blood",
    name: "Flesh and Blood",
    version: "1.0.0",
    description: "Booster sets, Armory Decks, and Mastery Packs for the Flesh and Blood TCG.",
    discoveryConfig: { defaultStrategy: "html-table" },
    sourceConfigs: [],
    installedVersion: "1.0.0",
    productSets: [
      { code: "FAB-STARTER", name: "Sample Booster Set" },
    ],
  },
  {
    slug: "digimon-card-game",
    name: "Digimon Card Game",
    version: "1.0.0",
    description: "Booster and starter deck releases for the Digimon Card Game.",
    discoveryConfig: { defaultStrategy: "html-table" },
    sourceConfigs: [],
    installedVersion: "1.0.0",
    productSets: [
      { code: "DGM-STARTER", name: "Sample Booster Set" },
    ],
  },
] as const;

// Confirmed working, fetched and parsed by hand during the news-feed feature
// scoping pass (2026-09-17) -- see the published scoping doc for the full
// verification notes. Deliberately excludes gundam-card-game (no candidate
// found). Riftbound.gg was added in a follow-up pass (2026-09-18) once its
// feed and its relationship to the game's actual publishers were checked --
// its own footer discloses "Riftbound.gg is not affiliated with Riot Games
// and UVS Games", the same kind of unofficial-but-legitimate fan site as
// PokeBeach/YGOrganization/Lorcana Player above, so it's COMMUNITY tier too.
// Still excluded: Serebii (publicly confirmed to run no RSS feed at all --
// its own operator has said as much, to avoid cannibalizing site visits),
// the official en.onepiece-cardgame.com (no feed at any of the usual
// WordPress/Jekyll paths, and no <link rel="alternate"> autodiscovery tag
// on its /news/ page), and ICv2 (its https://icv2.com/rss is a real,
// working RSS 2.0 feed -- but it's whole-industry "geek culture" coverage,
// not per-game, and this repo's per-source model has no keyword-filter step
// to bucket it by game yet -- see the scoping doc's deferred cross-game-press
// decision. Seeding it today would dump comics/board-game/merch noise into
// every game's unfiltered feed; revisit once that filtering step exists).
//
// Second follow-up pass (2026-09-18), prompted by PokeBeach and Lorcana
// Player both 403ing from the production droplet's IP specifically (not a
// code/header issue -- confirmed the same URLs 200 from an unrelated
// machine, and still 403 from the droplet with a normal browser UA; reads
// as datacenter-IP blocking on their end). Added Lorcana.gg and PokeJungle's
// TCG-only category feed as extra per-game coverage, each verified 200 from
// the droplet itself before landing here. Lorcana.gg is a second full
// community-news source for Lorcana Player to lean on. PokeJungle's feed is
// scoped to its "tcg" category specifically (its site-wide feed is broader
// Pokemon-franchise coverage -- games, GO, anime -- with TCG as one category
// among many, same cross-game-noise shape as ICv2 above); it posts far less
// often than PokeBeach did (tied to official announcements, not daily
// community chatter), so treat it as a supplement, not PokeBeach's
// replacement. Gundam and Union Arena were re-checked and still have no
// working dedicated feed -- Union Arena's English release is barely a year
// old and hasn't grown dedicated fan press yet; Gundam's one candidate with
// a real feed (TCG Top Decks HQ) mixes in Naruto TCG and others sitewide
// with no per-category feed that actually filters (category feed URLs all
// redirect to its homepage), so it has the same cross-game problem as ICv2
// on top of being low-volume (last post over a month old at check time).
//
// Third pass (2026-09-19), adding flesh-and-blood and digimon-card-game.
// Digimon: With the Will's "Announcements and News" forum feed -- a
// dedicated Digimon fan site (200 from the droplet), but franchise-wide, so
// roughly a third of it is card game news (sets, box toppers, previews) and
// the rest anime/merch; it is the only live Digimon source reachable, and is
// worth dropping if the noise proves too much. Flesh and Blood has NONE, and
// the reasons are worth keeping: the official https://fabtcg.com/feed/ is the
// obvious source (live, per-game) but answers 403 from the droplet with any
// User-Agent -- the same datacenter-IP blocking as PokeBeach -- so it would
// only ever show as a failing source. The other candidates are dead
// (Total Cards' FAB and Digimon atoms stopped in 2024-25; Bleeding Cool's FAB
// tag stopped in 2024) or the wrong content (Bleeding Cool's Digimon tag is
// video game/anime news, not the card game).
const NEWS_FEED_SOURCES = [
  {
    packageSlug: "magic-the-gathering",
    label: "MTGGoldfish",
    feedUrl: "https://www.mtggoldfish.com/feed",
    tier: "COMMUNITY",
  },
  {
    packageSlug: "pokemon-tcg",
    label: "PokeBeach — Front Page News",
    feedUrl: "https://www.pokebeach.com/forums/forum/front-page-news.18/index.rss",
    tier: "COMMUNITY",
  },
  {
    packageSlug: "yugioh-tcg",
    label: "YGOrganization",
    feedUrl: "https://ygorganization.com/feed/",
    tier: "COMMUNITY",
  },
  {
    packageSlug: "yugioh-tcg",
    label: "Bleeding Cool — Yu-Gi-Oh!",
    feedUrl: "https://bleedingcool.com/games/tabletop/card-games/yu-gi-oh/feed/",
    tier: "COMMUNITY",
  },
  {
    packageSlug: "disney-lorcana",
    label: "Lorcana Player",
    feedUrl: "https://lorcanaplayer.com/feed/",
    tier: "COMMUNITY",
  },
  {
    packageSlug: "one-piece-tcg",
    label: "Total Cards — One Piece",
    feedUrl: "https://totalcards.net/blogs/one-piece.atom",
    tier: "RETAILER",
  },
  {
    packageSlug: "riftbound",
    label: "Riftbound.gg",
    feedUrl: "https://riftbound.gg/feed/",
    tier: "COMMUNITY",
  },
  {
    packageSlug: "disney-lorcana",
    label: "Lorcana.gg",
    feedUrl: "https://lorcana.gg/feed/",
    tier: "COMMUNITY",
  },
  {
    packageSlug: "pokemon-tcg",
    label: "PokeJungle — Pokemon TCG",
    feedUrl: "https://pokejungle.net/category/tcg/feed/",
    tier: "COMMUNITY",
  },
  {
    packageSlug: "digimon-card-game",
    label: "With the Will — Announcements & News",
    feedUrl: "https://withthewill.net/forums/announcements-and-news.10/index.rss",
    tier: "COMMUNITY",
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
        update: { name: set.name },
        create: {
          tcgProfileInstallId: install.id,
          code: set.code,
          name: set.name,
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

  for (const source of NEWS_FEED_SOURCES) {
    const profilePackage = await prisma.tcgProfilePackage.findUnique({
      where: { slug: source.packageSlug },
    });
    if (!profilePackage) continue;

    const install = await prisma.tcgProfileInstall.findFirst({
      where: { packageId: profilePackage.id },
    });
    if (!install) continue;

    await prisma.newsFeedSource.upsert({
      where: { feedUrl: source.feedUrl },
      update: { label: source.label, tier: source.tier, tcgProfileInstallId: install.id },
      create: {
        label: source.label,
        feedUrl: source.feedUrl,
        tier: source.tier,
        tcgProfileInstallId: install.id,
      },
    });
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

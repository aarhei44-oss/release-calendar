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
] as const;

// Confirmed working, fetched and parsed by hand during the news-feed feature
// scoping pass (2026-09-17) -- see the published scoping doc for the full
// verification notes. Deliberately excludes gundam-card-game (no candidate
// found) and riftbound (found but not cross-checked against the official
// domain) -- seed those once they've been checked, not before.
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

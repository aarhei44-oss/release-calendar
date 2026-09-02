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
];

const MTG_SOURCES: SourceConfig[] = [
  {
    url: "https://en.wikipedia.org/wiki/List_of_Magic:_The_Gathering_sets",
    tier: "COMMUNITY",
    parser: "html-table",
    options: { codePrefix: "MTG", eventType: "SHELF", region: "GLOBAL" },
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

import { prisma } from "../lib/prisma";

// Sample rows for the Playwright suite (tests/e2e) ONLY -- run by
// playwright.config.ts after prisma/seed.ts, never by the production boot
// seed. The e2e calendar tests need at least one event row on the upcoming
// tab; production data comes from the ingest pipeline alone, and placeholder
// releases must never be seeded there.
const SAMPLE_SETS = [
  { packageSlug: "pokemon-tcg", code: "SV-STARTER", name: "Sample Booster Set" },
  { packageSlug: "magic-the-gathering", code: "MTG-STARTER", name: "Sample Expansion" },
] as const;

async function main() {
  for (const sample of SAMPLE_SETS) {
    const profilePackage = await prisma.tcgProfilePackage.findUnique({ where: { slug: sample.packageSlug } });
    if (!profilePackage) throw new Error(`run prisma/seed.ts first: no package "${sample.packageSlug}"`);

    const install = await prisma.tcgProfileInstall.findFirst({ where: { packageId: profilePackage.id } });
    if (!install) throw new Error(`run prisma/seed.ts first: no install for "${sample.packageSlug}"`);

    const productSet = await prisma.productSet.upsert({
      where: { tcgProfileInstallId_code: { tcgProfileInstallId: install.id, code: sample.code } },
      update: { name: sample.name },
      create: { tcgProfileInstallId: install.id, code: sample.code, name: sample.name },
    });

    const existingEvent = await prisma.releaseEvent.findFirst({
      where: { productSetId: productSet.id, type: "SHELF" },
    });
    if (existingEvent) continue;

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

  console.log("E2E seed complete.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

import { prisma } from "../lib/prisma";
import { generateProductSetSlug } from "../data/ingest/ingestRepo";

/**
 * One-off backfill for ProductSet.slug, run manually after the migration
 * that added the column (`npx tsx prisma/backfillProductSetSlugs.ts`) --
 * see data/ingest/ingestRepo.ts's createProductSet, which generates a slug
 * the same way for every row created from here on. Reuses that exact
 * function rather than a second implementation so a backfilled row and a
 * freshly-ingested one can never disagree on how a slug was derived.
 *
 * Rows with a null `name` (only prisma/adminRepo.ts's placeholder sets) are
 * left alone -- there's nothing to derive a slug from, and a placeholder
 * shouldn't get a detail page anyway.
 *
 * Processed one row at a time, not in parallel: generateProductSetSlug
 * checks the database for a same-install collision, so two rows racing
 * each other could both see the same slug as free and pick it. Sequential
 * means each row's slug is written before the next row checks for one.
 */
async function main() {
  const sets = await prisma.productSet.findMany({
    where: { slug: null, name: { not: null } },
    select: { id: true, tcgProfileInstallId: true, name: true, code: true },
  });

  console.log(`Backfilling slugs for ${sets.length} ProductSet row(s)...`);

  let updated = 0;
  for (const set of sets) {
    const slug = await generateProductSetSlug(prisma, set.tcgProfileInstallId, set.name!, set.code);
    await prisma.productSet.update({ where: { id: set.id }, data: { slug } });
    updated++;
  }

  console.log(`Done. Backfilled ${updated} row(s).`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

import { randomUUID } from "node:crypto";
import type { Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { slugify } from "@/lib/slugify";

type Db = typeof prisma | Prisma.TransactionClient;

/**
 * A same-install-unique slug for a ProductSet, derived from its name.
 *
 * Mirrors how this same file's synthesizeProductSetCode-equivalent in
 * orchestrate.ts already disambiguates a synthetic `code`: try the natural
 * candidate first, then fall back to something less readable rather than
 * failing the create. The middle fallback (appending the set's own code)
 * is what actually matters in practice -- it's exactly what separates
 * Union Arena's same-named booster/starter-deck pair (see
 * lib/ingest/providers/bandaiUnionArena.ts), where `code` already carries
 * the BT/ST distinction a name-only slug can't.
 *
 * Lives in lib/ingest/, not data/ingest/ingestRepo.ts (its only caller
 * there, createProductSet), deliberately: the deployed production image
 * only ships lib/ and prisma/ as raw TypeScript (data/ and the rest of
 * app/ are compiled into .next only -- see ENVIRONMENT.md's "running an
 * arbitrary one-off script against prod"), and prisma/backfillProductSetSlugs.ts
 * needs to import this same logic to run as a plain one-off script there,
 * the same way prisma/seed.ts already does.
 */
export async function generateProductSetSlug(
  db: Db,
  tcgProfileInstallId: string,
  name: string,
  code: string,
): Promise<string> {
  const base = slugify(name);
  const candidates = [base, `${base}-${slugify(code)}`].filter(Boolean);

  for (const candidate of candidates) {
    const existing = await db.productSet.findFirst({
      where: { tcgProfileInstallId, slug: candidate },
      select: { id: true },
    });
    if (!existing) return candidate;
  }

  const fallbackBase = base || "set";
  return `${fallbackBase}-${randomUUID().replace(/-/g, "").slice(0, 6)}`;
}

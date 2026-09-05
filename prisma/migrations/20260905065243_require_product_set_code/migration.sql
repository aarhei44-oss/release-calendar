/*
  Warnings:

  - Made the column `code` on table `ProductSet` required. This step will fail if there are existing NULL values in that column.

  DESTRUCTIVE, DELIBERATE: this migration first deletes every ProductSet row
  (and, by ON DELETE CASCADE, every ReleaseEvent, SourceClaim, SetIdentity,
  ReviewItem, UserNote, EventFollow, EventPersonalNote, EventDismissal and
  EventReaction hanging off them) rather than backfilling a synthetic code
  for existing rows. v2 ingestion repopulates ProductSet/ReleaseEvent from
  scratch on its next run; the user-generated rows in that cascade
  (follows, personal notes, dismissals, reactions, comments) do not come
  back from any source and are gone for good. Confirmed with the site owner
  before this migration was written -- do not apply it to a database whose
  crawl and user data you want to keep.
*/
DELETE FROM "ProductSet";

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ProductSet" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tcgProfileInstallId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "codeIsSynthetic" BOOLEAN NOT NULL DEFAULT false,
    "name" TEXT,
    "releaseQuarter" TEXT,
    "meta" JSONB,
    "imageUrl" TEXT,
    "description" TEXT,
    "archivedAt" DATETIME,
    "mergedIntoId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ProductSet_tcgProfileInstallId_fkey" FOREIGN KEY ("tcgProfileInstallId") REFERENCES "TcgProfileInstall" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_ProductSet" ("archivedAt", "code", "createdAt", "description", "id", "imageUrl", "mergedIntoId", "meta", "name", "releaseQuarter", "tcgProfileInstallId", "updatedAt") SELECT "archivedAt", "code", "createdAt", "description", "id", "imageUrl", "mergedIntoId", "meta", "name", "releaseQuarter", "tcgProfileInstallId", "updatedAt" FROM "ProductSet";
DROP TABLE "ProductSet";
ALTER TABLE "new_ProductSet" RENAME TO "ProductSet";
CREATE INDEX "ProductSet_archivedAt_idx" ON "ProductSet"("archivedAt");
CREATE UNIQUE INDEX "ProductSet_tcgProfileInstallId_code_key" ON "ProductSet"("tcgProfileInstallId", "code");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- AlterTable
ALTER TABLE "ProductSet" ADD COLUMN "slug" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "ProductSet_tcgProfileInstallId_slug_key" ON "ProductSet"("tcgProfileInstallId", "slug");

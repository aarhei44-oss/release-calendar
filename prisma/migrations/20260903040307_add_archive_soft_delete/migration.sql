-- AlterTable
ALTER TABLE "ProductSet" ADD COLUMN "archivedAt" DATETIME;
ALTER TABLE "ProductSet" ADD COLUMN "mergedIntoId" TEXT;

-- AlterTable
ALTER TABLE "ReleaseEvent" ADD COLUMN "archivedAt" DATETIME;
ALTER TABLE "ReleaseEvent" ADD COLUMN "mergedIntoId" TEXT;
ALTER TABLE "ReleaseEvent" ADD COLUMN "movedFromProductSetId" TEXT;

-- AlterTable
ALTER TABLE "SourceClaim" ADD COLUMN "movedFromReleaseEventId" TEXT;

-- AlterTable
ALTER TABLE "UserNote" ADD COLUMN "movedFromReleaseEventId" TEXT;

-- CreateIndex
CREATE INDEX "ProductSet_archivedAt_idx" ON "ProductSet"("archivedAt");

-- CreateIndex
CREATE INDEX "ReleaseEvent_archivedAt_idx" ON "ReleaseEvent"("archivedAt");

-- CreateIndex
CREATE INDEX "ReleaseEvent_movedFromProductSetId_idx" ON "ReleaseEvent"("movedFromProductSetId");

-- CreateIndex
CREATE INDEX "SourceClaim_movedFromReleaseEventId_idx" ON "SourceClaim"("movedFromReleaseEventId");

-- CreateIndex
CREATE INDEX "UserNote_movedFromReleaseEventId_idx" ON "UserNote"("movedFromReleaseEventId");

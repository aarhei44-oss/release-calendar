-- AlterTable
ALTER TABLE "User" ADD COLUMN "removalDate" DATETIME;

-- CreateIndex
CREATE INDEX "User_removalDate_idx" ON "User"("removalDate");

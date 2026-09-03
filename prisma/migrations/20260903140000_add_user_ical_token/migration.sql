-- AlterTable
ALTER TABLE "User" ADD COLUMN "icalToken" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "User_icalToken_key" ON "User"("icalToken");

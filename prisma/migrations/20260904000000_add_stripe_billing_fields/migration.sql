-- AlterTable
-- SQLite doesn't support comma-separated ADD COLUMN clauses in one
-- ALTER TABLE -- each needs its own statement.
ALTER TABLE "User" ADD COLUMN "stripeCustomerId" TEXT;
ALTER TABLE "User" ADD COLUMN "stripeSubscriptionId" TEXT;
ALTER TABLE "User" ADD COLUMN "stripeSubscriptionStatus" TEXT;
ALTER TABLE "User" ADD COLUMN "premiumCurrentPeriodEnd" DATETIME;

-- CreateIndex
CREATE UNIQUE INDEX "User_stripeCustomerId_key" ON "User"("stripeCustomerId");

-- CreateIndex
CREATE UNIQUE INDEX "User_stripeSubscriptionId_key" ON "User"("stripeSubscriptionId");

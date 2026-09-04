-- AlterTable
ALTER TABLE "ScanRun" ADD COLUMN "retryOfRunId" TEXT;

-- AlterTable
ALTER TABLE "SourceClaim" ADD COLUMN "origin" TEXT;
ALTER TABLE "SourceClaim" ADD COLUMN "scanRunId" TEXT;

-- CreateTable
CREATE TABLE "SetIdentity" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "productSetId" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SetIdentity_productSetId_fkey" FOREIGN KEY ("productSetId") REFERENCES "ProductSet" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RawPayload" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scanRunId" TEXT NOT NULL,
    "providerKey" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "body" BLOB NOT NULL,
    "fetchedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ProviderRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scanRunId" TEXT NOT NULL,
    "providerKey" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "etag" TEXT,
    "candidates" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "startedAt" DATETIME NOT NULL,
    "finishedAt" DATETIME
);

-- CreateTable
CREATE TABLE "RunDiff" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scanRunId" TEXT NOT NULL,
    "changes" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ReviewItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "releaseEventId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "detail" JSONB NOT NULL,
    "summary" TEXT,
    "resolvedAt" DATETIME,
    "resolvedNote" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ReviewItem_releaseEventId_fkey" FOREIGN KEY ("releaseEventId") REFERENCES "ReleaseEvent" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ProviderEtag" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "providerKey" TEXT NOT NULL,
    "etag" TEXT,
    "lastFetchedAt" DATETIME NOT NULL,
    "contentHash" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "SetIdentity_productSetId_idx" ON "SetIdentity"("productSetId");

-- CreateIndex
CREATE UNIQUE INDEX "SetIdentity_origin_externalId_key" ON "SetIdentity"("origin", "externalId");

-- CreateIndex
CREATE INDEX "RawPayload_fetchedAt_idx" ON "RawPayload"("fetchedAt");

-- CreateIndex
CREATE UNIQUE INDEX "RawPayload_scanRunId_providerKey_key" ON "RawPayload"("scanRunId", "providerKey");

-- CreateIndex
CREATE INDEX "ProviderRun_providerKey_startedAt_idx" ON "ProviderRun"("providerKey", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderRun_scanRunId_providerKey_key" ON "ProviderRun"("scanRunId", "providerKey");

-- CreateIndex
CREATE UNIQUE INDEX "RunDiff_scanRunId_key" ON "RunDiff"("scanRunId");

-- CreateIndex
CREATE INDEX "ReviewItem_resolvedAt_idx" ON "ReviewItem"("resolvedAt");

-- CreateIndex
CREATE INDEX "ReviewItem_releaseEventId_idx" ON "ReviewItem"("releaseEventId");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderEtag_providerKey_key" ON "ProviderEtag"("providerKey");

-- CreateIndex
CREATE INDEX "ScanRun_retryOfRunId_idx" ON "ScanRun"("retryOfRunId");

-- CreateIndex
CREATE UNIQUE INDEX "SourceClaim_scanRunId_origin_releaseEventId_key" ON "SourceClaim"("scanRunId", "origin", "releaseEventId");


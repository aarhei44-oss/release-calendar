-- CreateTable
CREATE TABLE "TcgProfilePackage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "description" TEXT,
    "discoveryConfig" JSONB NOT NULL,
    "sourceConfigs" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "TcgProfileInstall" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "packageId" TEXT NOT NULL,
    "installedVersion" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "settings" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TcgProfileInstall_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "TcgProfilePackage" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ProductSet" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tcgProfileInstallId" TEXT NOT NULL,
    "code" TEXT,
    "name" TEXT,
    "releaseQuarter" TEXT,
    "meta" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ProductSet_tcgProfileInstallId_fkey" FOREIGN KEY ("tcgProfileInstallId") REFERENCES "TcgProfileInstall" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ReleaseEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "productSetId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "dateType" TEXT NOT NULL,
    "dateExact" DATETIME,
    "dateStart" DATETIME,
    "dateEnd" DATETIME,
    "windowGranularity" TEXT,
    "windowStart" DATETIME,
    "windowEnd" DATETIME,
    "region" TEXT NOT NULL DEFAULT 'GLOBAL',
    "status" TEXT NOT NULL DEFAULT 'RUMORED',
    "confidence" REAL NOT NULL DEFAULT 0,
    "sourceSummary" TEXT,
    "lastSeenAt" DATETIME,
    "isManualOverride" BOOLEAN NOT NULL DEFAULT false,
    "manualNotes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ReleaseEvent_productSetId_fkey" FOREIGN KEY ("productSetId") REFERENCES "ProductSet" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SourceClaim" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "releaseEventId" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "disposition" TEXT NOT NULL,
    "confidenceWeight" REAL NOT NULL,
    "url" TEXT NOT NULL,
    "host" TEXT,
    "dateExact" DATETIME,
    "dateStart" DATETIME,
    "dateEnd" DATETIME,
    "lastVerifiedAt" DATETIME,
    "raw" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SourceClaim_releaseEventId_fkey" FOREIGN KEY ("releaseEventId") REFERENCES "ReleaseEvent" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ScanRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scopeType" TEXT NOT NULL,
    "scopeId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "totals" JSONB,
    "trigger" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    CONSTRAINT "ScanRun_scopeId_fkey" FOREIGN KEY ("scopeId") REFERENCES "TcgProfileInstall" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DiscoveryHit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tcgProfileInstallId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT,
    "raw" JSONB,
    "seenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DiscoveryHit_tcgProfileInstallId_fkey" FOREIGN KEY ("tcgProfileInstallId") REFERENCES "TcgProfileInstall" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "JobLock" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobName" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "ownerId" TEXT,
    "acquiredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "image" TEXT,
    "emailVerified" DATETIME,
    "role" TEXT NOT NULL DEFAULT 'USER',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "refresh_token" TEXT,
    "access_token" TEXT,
    "expires_at" INTEGER,
    "token_type" TEXT,
    "scope" TEXT,
    "id_token" TEXT,
    "session_state" TEXT,
    CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionToken" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expires" DATETIME NOT NULL,
    CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "VerificationToken" (
    "identifier" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "tcgProfileInstallId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Subscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Subscription_tcgProfileInstallId_fkey" FOREIGN KEY ("tcgProfileInstallId") REFERENCES "TcgProfileInstall" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "UserNote" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "releaseEventId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "UserNote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "UserNote_releaseEventId_fkey" FOREIGN KEY ("releaseEventId") REFERENCES "ReleaseEvent" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "TcgProfilePackage_slug_key" ON "TcgProfilePackage"("slug");

-- CreateIndex
CREATE INDEX "TcgProfileInstall_packageId_idx" ON "TcgProfileInstall"("packageId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductSet_tcgProfileInstallId_code_key" ON "ProductSet"("tcgProfileInstallId", "code");

-- CreateIndex
CREATE INDEX "ReleaseEvent_productSetId_type_idx" ON "ReleaseEvent"("productSetId", "type");

-- CreateIndex
CREATE INDEX "ReleaseEvent_dateType_dateExact_dateStart_idx" ON "ReleaseEvent"("dateType", "dateExact", "dateStart");

-- CreateIndex
CREATE INDEX "SourceClaim_releaseEventId_lastVerifiedAt_idx" ON "SourceClaim"("releaseEventId", "lastVerifiedAt");

-- CreateIndex
CREATE INDEX "ScanRun_scopeId_idx" ON "ScanRun"("scopeId");

-- CreateIndex
CREATE UNIQUE INDEX "DiscoveryHit_tcgProfileInstallId_url_key" ON "DiscoveryHit"("tcgProfileInstallId", "url");

-- CreateIndex
CREATE UNIQUE INDEX "JobLock_jobName_scopeKey_key" ON "JobLock"("jobName", "scopeKey");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Account_provider_providerAccountId_key" ON "Account"("provider", "providerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_sessionToken_key" ON "Session"("sessionToken");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_token_key" ON "VerificationToken"("token");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_identifier_token_key" ON "VerificationToken"("identifier", "token");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_userId_tcgProfileInstallId_key" ON "Subscription"("userId", "tcgProfileInstallId");

-- CreateIndex
CREATE INDEX "UserNote_userId_releaseEventId_idx" ON "UserNote"("userId", "releaseEventId");

-- CreateTable
CREATE TABLE "NewsFeedSource" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "label" TEXT NOT NULL,
    "feedUrl" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "tcgProfileInstallId" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastFetchedAt" DATETIME,
    "lastEtag" TEXT,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "NewsFeedSource_tcgProfileInstallId_fkey" FOREIGN KEY ("tcgProfileInstallId") REFERENCES "TcgProfileInstall" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "NewsItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sourceId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "summary" TEXT,
    "publishedAt" DATETIME NOT NULL,
    "fetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archivedAt" DATETIME,
    CONSTRAINT "NewsItem_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "NewsFeedSource" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "NewsFeedSource_feedUrl_key" ON "NewsFeedSource"("feedUrl");

-- CreateIndex
CREATE INDEX "NewsFeedSource_tcgProfileInstallId_idx" ON "NewsFeedSource"("tcgProfileInstallId");

-- CreateIndex
CREATE UNIQUE INDEX "NewsItem_url_key" ON "NewsItem"("url");

-- CreateIndex
CREATE INDEX "NewsItem_sourceId_publishedAt_idx" ON "NewsItem"("sourceId", "publishedAt");

-- CreateIndex
CREATE INDEX "NewsItem_archivedAt_idx" ON "NewsItem"("archivedAt");

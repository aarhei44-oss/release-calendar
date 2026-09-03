-- CreateTable
CREATE TABLE "EventFollow" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "releaseEventId" TEXT NOT NULL,
    "movedFromReleaseEventId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EventFollow_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "EventFollow_releaseEventId_fkey" FOREIGN KEY ("releaseEventId") REFERENCES "ReleaseEvent" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "EventPersonalNote" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "releaseEventId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "movedFromReleaseEventId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "EventPersonalNote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "EventPersonalNote_releaseEventId_fkey" FOREIGN KEY ("releaseEventId") REFERENCES "ReleaseEvent" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "EventDismissal" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "releaseEventId" TEXT NOT NULL,
    "movedFromReleaseEventId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EventDismissal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "EventDismissal_releaseEventId_fkey" FOREIGN KEY ("releaseEventId") REFERENCES "ReleaseEvent" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "EventFollow_userId_releaseEventId_key" ON "EventFollow"("userId", "releaseEventId");

-- CreateIndex
CREATE INDEX "EventFollow_movedFromReleaseEventId_idx" ON "EventFollow"("movedFromReleaseEventId");

-- CreateIndex
CREATE UNIQUE INDEX "EventPersonalNote_userId_releaseEventId_key" ON "EventPersonalNote"("userId", "releaseEventId");

-- CreateIndex
CREATE INDEX "EventPersonalNote_movedFromReleaseEventId_idx" ON "EventPersonalNote"("movedFromReleaseEventId");

-- CreateIndex
CREATE UNIQUE INDEX "EventDismissal_userId_releaseEventId_key" ON "EventDismissal"("userId", "releaseEventId");

-- CreateIndex
CREATE INDEX "EventDismissal_movedFromReleaseEventId_idx" ON "EventDismissal"("movedFromReleaseEventId");

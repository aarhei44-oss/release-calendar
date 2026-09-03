-- CreateTable
CREATE TABLE "EventReaction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "releaseEventId" TEXT NOT NULL,
    "emoji" TEXT NOT NULL,
    "movedFromReleaseEventId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "EventReaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "EventReaction_releaseEventId_fkey" FOREIGN KEY ("releaseEventId") REFERENCES "ReleaseEvent" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "EventReaction_releaseEventId_emoji_idx" ON "EventReaction"("releaseEventId", "emoji");

-- CreateIndex
CREATE INDEX "EventReaction_movedFromReleaseEventId_idx" ON "EventReaction"("movedFromReleaseEventId");

-- CreateIndex
CREATE UNIQUE INDEX "EventReaction_userId_releaseEventId_key" ON "EventReaction"("userId", "releaseEventId");

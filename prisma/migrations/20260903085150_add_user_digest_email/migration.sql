-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "image" TEXT,
    "emailVerified" DATETIME,
    "role" TEXT NOT NULL DEFAULT 'USER',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "timezone" TEXT,
    "emailAlertsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "discordWebhookUrl" TEXT,
    "discordAlertsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "isPremium" BOOLEAN NOT NULL DEFAULT false,
    "dashboardCardIds" JSONB,
    "digestEmailEnabled" BOOLEAN NOT NULL DEFAULT false,
    "digestFrequency" TEXT NOT NULL DEFAULT 'DAILY',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_User" ("active", "createdAt", "dashboardCardIds", "discordAlertsEnabled", "discordWebhookUrl", "email", "emailAlertsEnabled", "emailVerified", "id", "image", "isPremium", "name", "role", "timezone", "updatedAt") SELECT "active", "createdAt", "dashboardCardIds", "discordAlertsEnabled", "discordWebhookUrl", "email", "emailAlertsEnabled", "emailVerified", "id", "image", "isPremium", "name", "role", "timezone", "updatedAt" FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

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
    "premiumOverride" BOOLEAN NOT NULL DEFAULT false,
    "stripeCustomerId" TEXT,
    "stripeSubscriptionId" TEXT,
    "stripeSubscriptionStatus" TEXT,
    "premiumCurrentPeriodEnd" DATETIME,
    "dashboardCardIds" JSONB,
    "digestEmailEnabled" BOOLEAN NOT NULL DEFAULT false,
    "digestFrequency" TEXT NOT NULL DEFAULT 'DAILY',
    "leadTimeReminderDays" INTEGER,
    "icalToken" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_User" ("active", "createdAt", "dashboardCardIds", "digestEmailEnabled", "digestFrequency", "discordAlertsEnabled", "discordWebhookUrl", "email", "emailAlertsEnabled", "emailVerified", "icalToken", "id", "image", "isPremium", "leadTimeReminderDays", "name", "premiumCurrentPeriodEnd", "role", "stripeCustomerId", "stripeSubscriptionId", "stripeSubscriptionStatus", "timezone", "updatedAt") SELECT "active", "createdAt", "dashboardCardIds", "digestEmailEnabled", "digestFrequency", "discordAlertsEnabled", "discordWebhookUrl", "email", "emailAlertsEnabled", "emailVerified", "icalToken", "id", "image", "isPremium", "leadTimeReminderDays", "name", "premiumCurrentPeriodEnd", "role", "stripeCustomerId", "stripeSubscriptionId", "stripeSubscriptionStatus", "timezone", "updatedAt" FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE UNIQUE INDEX "User_stripeCustomerId_key" ON "User"("stripeCustomerId");
CREATE UNIQUE INDEX "User_stripeSubscriptionId_key" ON "User"("stripeSubscriptionId");
CREATE UNIQUE INDEX "User_icalToken_key" ON "User"("icalToken");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

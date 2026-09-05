-- Freshness-alarm bookkeeping for the v2 ingest pipeline
-- (lib/ingest/freshness.ts). Purely an idempotency record: the *condition*
-- ("provider X has not returned data for 48h") is recomputed from ProviderRun
-- history on every pass, and this table only remembers whether anyone has
-- already been told, so an ongoing outage does not alarm once per run.
-- CreateTable
CREATE TABLE "ProviderAlarm" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "providerKey" TEXT NOT NULL,
    "openedAt" DATETIME NOT NULL,
    "notifiedAt" DATETIME NOT NULL,
    "lastOkAt" DATETIME,
    "clearedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "ProviderAlarm_providerKey_key" ON "ProviderAlarm"("providerKey");

-- CreateIndex
CREATE INDEX "ProviderAlarm_clearedAt_idx" ON "ProviderAlarm"("clearedAt");

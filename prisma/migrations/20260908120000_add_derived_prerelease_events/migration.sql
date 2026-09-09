-- Marks a PRERELEASE event this pipeline computed from a shelf date rather than
-- read from a source (lib/ingest/prerelease.ts), and which schedule slot it is.
--
-- Together these make derived rows a disjoint population from source-backed
-- ones, which is the property the whole design rests on: the gate's
-- findOrCreateReleaseEvent filters on derivedFromEventId IS NULL, so it can
-- never adopt a derived row and start writing verdicts onto something it has no
-- claims for; and the derivation pass only ever writes rows where it is NOT
-- NULL, so it can never clobber a date a real source published.
--
-- SQLite takes one ALTER TABLE per added column; do not fold these into one
-- statement with a comma (that is Postgres/MySQL syntax and would crash-loop
-- the container on deploy).
-- AlterTable
ALTER TABLE "ReleaseEvent" ADD COLUMN "derivedFromEventId" TEXT;

-- AlterTable
ALTER TABLE "ReleaseEvent" ADD COLUMN "derivedSlot" TEXT;

-- CreateIndex
-- One derived row per (anchor shelf event, slot). SQLite treats NULLs as
-- distinct in a unique index, so every existing row -- and every future
-- source-backed one -- has both columns NULL and is exempt. No backfill is
-- needed or wanted: nothing before this migration was derived.
CREATE UNIQUE INDEX "ReleaseEvent_derivedFromEventId_derivedSlot_key" ON "ReleaseEvent"("derivedFromEventId", "derivedSlot");

-- CreateIndex
-- The retraction sweep walks derived rows by anchor to ask whether the anchor
-- still qualifies, so this is the access path that runs every ingest.
CREATE INDEX "ReleaseEvent_derivedFromEventId_idx" ON "ReleaseEvent"("derivedFromEventId");

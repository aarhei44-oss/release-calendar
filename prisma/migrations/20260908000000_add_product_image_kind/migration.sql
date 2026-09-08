-- Records what ProductSet.imageUrl depicts, so the drawer can stop rendering a
-- Scryfall set glyph through the slot built for YGOPRODeck's box photography.
--
-- SQLite takes one ALTER TABLE per added column; do not fold further columns
-- into this statement with commas (that is Postgres/MySQL syntax and would
-- crash-loop the container on deploy).
-- AlterTable
ALTER TABLE "ProductSet" ADD COLUMN "imageKind" TEXT;

-- Classify the rows that already carry a URL. Going forward the *provider*
-- declares this (lib/ingest/providers/), and nothing in the app sniffs a URL
-- at runtime -- but every existing row was written before that field existed,
-- and enrichment only ever fills what is missing, so without a backfill here
-- these rows would stay unclassified until something rewrote imageUrl, which
-- for a stable catalogue is never. The sniff is sound for exactly the two
-- origins that have ever populated this column: Scryfall's icon_svg_uri (an
-- .svg, sometimes with a cache-busting query) and YGOPRODeck's set_image (a
-- .jpg). It is a one-time historical fix, not a rule.
UPDATE "ProductSet"
   SET "imageKind" = 'SYMBOL'
 WHERE "imageUrl" IS NOT NULL
   AND ("imageUrl" LIKE '%.svg' OR "imageUrl" LIKE '%.svg?%');

UPDATE "ProductSet"
   SET "imageKind" = 'ART'
 WHERE "imageUrl" IS NOT NULL
   AND "imageKind" IS NULL;

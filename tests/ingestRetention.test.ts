import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RETENTION_DAYS, retentionCutoffDays, runRetentionCleanupPass } from "@/lib/crawler/retention";
import { decodePayloadBody } from "@/lib/ingest/normalize";
import { packPayloadBody, runStagesFromPayloads } from "@/lib/ingest/orchestrate";
import { FORWARD_WINDOW_DAYS } from "@/lib/ingest/providers/shared";
import { PRODUCTION_PROVIDERS, registerProvider, unregisterProvider } from "@/lib/ingest/providers/registry";
import { bandaiGundamProvider } from "@/lib/ingest/providers/bandaiGundam";
import { bandaiOnePieceProvider } from "@/lib/ingest/providers/bandaiOnePiece";
import { bulbapediaProvider } from "@/lib/ingest/providers/bulbapedia";
import { scryfallProvider } from "@/lib/ingest/providers/scryfall";
import { tcgcsvProvider } from "@/lib/ingest/providers/tcgcsv";
import { wikipediaProvider } from "@/lib/ingest/providers/wikipedia";
import { ygoprodeckProvider } from "@/lib/ingest/providers/ygoprodeck";
import type { Provider } from "@/lib/ingest/providers/types";
import { prisma } from "@/lib/prisma";
import type { Candidate } from "@/lib/ingest/types";
import { loadFixture, parseFixture } from "./fixtures/ingest/helpers";

/** The instant every fixture in tests/fixtures/ingest was recorded at. */
const FIXTURE_FETCHED_AT = new Date("2026-09-04T20:00:00.000Z");

const FIXTURES: ReadonlyArray<readonly [Provider, string]> = [
  [bandaiGundamProvider, "bandaiGundam.pages.json"],
  [bandaiOnePieceProvider, "bandaiOnePiece.pages.json"],
  [bulbapediaProvider, "bulbapedia.pages.json"],
  [scryfallProvider, "scryfall.sets.json"],
  [tcgcsvProvider, "tcgcsv.groups.json"],
  [wikipediaProvider, "wikipedia.pages.json"],
  [ygoprodeckProvider, "ygoprodeck.cardsets.json"],
];

/**
 * Retention deletes unconditionally -- and must not start a churn loop doing it.
 *
 * The decision on record is that the purge takes an aged-out event whatever is
 * attached to it: follows, personal notes, dismissals, reactions and notes all
 * cascade, and there is deliberately no EXISTS guard sparing an event because
 * somebody once starred it. That decision is only safe because of one other
 * fact, which is what these tests pin:
 *
 *   an event old enough to be purged is old enough that no provider will
 *   still offer the row that would re-create it.
 *
 * Providers drop candidates dated more than FORWARD_WINDOW_DAYS in the past at
 * parse time, and retention's cutoff is floored at that same number. Break
 * either half and every night looks like v1's measured 3,196 events created /
 * 3,173 deleted -- the same rows, deleted and re-ingested forever, which is both
 * a pointless write load and what a site ban looks like from upstream.
 */

const GAME_SLUG = `ingest-retention-test-${crypto.randomUUID()}`;
const NOW = new Date("2026-09-04T20:00:00.000Z");
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function daysBeforeNow(days: number): Date {
  return new Date(NOW.getTime() - days * MS_PER_DAY);
}

/** Comfortably past the purge cutoff, and therefore past the forward window too. */
const PURGED_DATE = daysBeforeNow(FORWARD_WINDOW_DAYS + 30);
/** Past its release date but still inside the forward window: providers still list it, so it must survive. */
const RECENT_DATE = daysBeforeNow(RETENTION_DAYS + 5);

let installId: string;
let userId: string;

type WireRow = { id: string; name: string; code: string; date: string };

/**
 * The upstream page, unchanged between runs. That is the point: a real set list
 * keeps listing last quarter's releases, so "the source stopped mentioning it"
 * is not what protects a purged event -- the forward window is.
 */
const ROWS: WireRow[] = [
  { id: "ret-old", name: "Ancient Printing", code: "ANP", date: PURGED_DATE.toISOString() },
  { id: "ret-recent", name: "Recent Printing", code: "RCP", date: RECENT_DATE.toISOString() },
];

const provider: Provider = {
  key: "retention-test-official",
  origin: "pokemon-official",
  tier: "OFFICIAL",
  games: [GAME_SLUG],
  async fetch() {
    throw new Error("network access attempted");
  },
  parse(payload) {
    const rows = decodePayloadBody(payload) as WireRow[];
    return rows
      .map(
        (row): Candidate => ({
          origin: "pokemon-official",
          game: GAME_SLUG,
          externalIds: { "pokemon-official": row.id },
          name: row.name,
          code: row.code,
          date: { kind: "EXACT", date: new Date(row.date) },
          region: "GLOBAL",
          type: "SHELF",
          url: `https://retention.example/${row.id}`,
        }),
      )
      .filter((candidate) => {
        // The same filter every real provider applies, spelled out here rather
        // than imported, so this fake cannot silently diverge from the rule the
        // test is about.
        const anchor = candidate.date.kind === "EXACT" ? candidate.date.date : null;
        return !anchor || anchor.getTime() >= payload.fetchedAt.getTime() - FORWARD_WINDOW_DAYS * MS_PER_DAY;
      });
  },
};

async function runOnce(): Promise<void> {
  const run = await prisma.scanRun.create({
    data: {
      scopeType: "INSTALL",
      scopeId: installId,
      trigger: "SCHEDULED",
      status: "SUCCEEDED",
      startedAt: NOW,
      finishedAt: NOW,
    },
  });
  const { body, contentHash } = packPayloadBody(ROWS);
  await prisma.rawPayload.create({
    data: { scanRunId: run.id, providerKey: provider.key, contentHash, body, fetchedAt: NOW },
  });
  await prisma.providerRun.create({
    data: {
      scanRunId: run.id,
      providerKey: provider.key,
      status: "OK",
      candidates: ROWS.length,
      startedAt: NOW,
      finishedAt: NOW,
    },
  });
  await runStagesFromPayloads({
    scanRunId: run.id,
    now: NOW,
    installs: [{ id: installId, package: { slug: GAME_SLUG } }],
  });
}

async function eventNames(): Promise<string[]> {
  const events = await prisma.releaseEvent.findMany({
    where: { productSet: { tcgProfileInstallId: installId } },
    select: { productSet: { select: { name: true } } },
  });
  return events.map((event) => event.productSet.name ?? "(unnamed)").sort();
}

beforeAll(async () => {
  const pkg = await prisma.tcgProfilePackage.create({
    data: {
      slug: GAME_SLUG,
      name: "Ingest Retention Test",
      version: "1.0.0",
      discoveryConfig: {},
      sourceConfigs: {},
    },
  });
  const install = await prisma.tcgProfileInstall.create({
    data: { packageId: pkg.id, installedVersion: "1.0.0", enabled: true },
  });
  installId = install.id;
  const user = await prisma.user.create({ data: { email: `retention-${crypto.randomUUID()}@example.com` } });
  userId = user.id;
  registerProvider(provider);
});

afterAll(async () => {
  unregisterProvider(provider.key);
  await prisma.$disconnect();
});

describe("the retention cutoff and the forward window", () => {
  it("never purges an event a provider would still offer", () => {
    // The invariant in one line. Everything below is this statement made
    // concrete against the database.
    expect(retentionCutoffDays()).toBeGreaterThanOrEqual(FORWARD_WINDOW_DAYS);
    expect(retentionCutoffDays(1)).toBeGreaterThanOrEqual(FORWARD_WINDOW_DAYS);
    // A caller asking to keep events *longer* is always honoured.
    expect(retentionCutoffDays(365)).toBe(365);
  });

  it("is enforced by every production provider, measured against their recorded payloads", () => {
    // Not a claim about the fake provider above -- a claim about all seven real
    // ones, checked by parsing the recorded 2026-09-04 responses rather than by
    // reading the source. A provider that forgot the filter would ingest a
    // decade of history and hand retention a permanent supply of rows to purge
    // and re-create, which is the loop this whole file exists to rule out.
    const cutoff = FIXTURE_FETCHED_AT.getTime() - FORWARD_WINDOW_DAYS * MS_PER_DAY;

    for (const [registered, file] of FIXTURES) {
      const candidates = parseFixture(registered, loadFixture(file), FIXTURE_FETCHED_AT);
      expect(candidates.length, `${registered.key} parsed nothing`).toBeGreaterThan(0);
      for (const candidate of candidates) {
        if (candidate.date.kind === "TBD") continue;
        const anchor = candidate.date.kind === "EXACT" ? candidate.date.date : candidate.date.start;
        expect(anchor.getTime(), `${registered.key}: ${candidate.name}`).toBeGreaterThanOrEqual(cutoff);
      }
    }

    // ...and every registered production provider is covered by that sweep, so a
    // provider added later cannot skip the check by not being listed here.
    expect(new Set(PRODUCTION_PROVIDERS.map((registered) => registered.key))).toEqual(
      new Set(FIXTURES.map(([registered]) => registered.key)),
    );
  });
});

describe("a purged past event is not re-created by the next run", () => {
  it("ingests only the in-window row to begin with", async () => {
    await runOnce();
    // "Ancient Printing" is on the page and always will be; it never becomes a
    // candidate, because the forward window drops it at parse time.
    expect(await eventNames()).toEqual(["Recent Printing"]);
  });

  it("purges an aged-out event and everything attached to it, then leaves it purged", async () => {
    // "Ancient Printing" is the realistic shape of an aged-out event: some
    // earlier run created it while its date was still ahead, users followed it,
    // and it has since fallen out of the forward window -- while its row stays
    // on the upstream page forever, because set lists do not delete history.
    // That row is the thing that would re-create it, and the only reason it
    // cannot is the parse-time filter.
    const set = await prisma.productSet.create({
      data: { tcgProfileInstallId: installId, code: "ANP", name: "Ancient Printing" },
    });
    await prisma.setIdentity.create({
      data: { productSetId: set.id, origin: "pokemon-official", externalId: "ret-old" },
    });
    const event = await prisma.releaseEvent.create({
      data: {
        productSetId: set.id,
        type: "SHELF",
        dateType: "EXACT",
        dateExact: PURGED_DATE,
        status: "RELEASED",
        confidence: 0.9,
      },
    });
    await prisma.eventFollow.create({ data: { userId, releaseEventId: event.id } });

    const result = await runRetentionCleanupPass({ installIds: [installId] });

    expect(result.eventsDeleted).toBe(1);
    expect(await prisma.releaseEvent.findUnique({ where: { id: event.id } })).toBeNull();
    // The accepted decision, asserted rather than assumed: a user's follow does
    // not save an aged-out event, it goes with it.
    expect(await prisma.eventFollow.count({ where: { releaseEventId: event.id } })).toBe(0);

    // ...and the next run over the very same payload does not bring it back.
    // Three runs, so this is a fixed point rather than a slow oscillation.
    await runOnce();
    await runOnce();
    await runOnce();
    expect(await eventNames()).toEqual(["Recent Printing"]);
    expect(await prisma.releaseEvent.count({ where: { productSetId: set.id } })).toBe(0);
  });

  it("keeps an event that is past its date but still inside the forward window", async () => {
    // The other half of the same rule, and the one a naive 30-day purge got
    // wrong: providers still list a set that shipped five weeks ago, so purging
    // it at 30 days would delete it tonight and re-ingest it tomorrow, forever.
    const set = await prisma.productSet.create({
      data: { tcgProfileInstallId: installId, code: "RCP-KEEP", name: "Still Listed" },
    });
    const event = await prisma.releaseEvent.create({
      data: {
        productSetId: set.id,
        type: "SHELF",
        dateType: "EXACT",
        dateExact: RECENT_DATE,
        status: "RELEASED",
        confidence: 0.9,
      },
    });

    const result = await runRetentionCleanupPass({ installIds: [installId] });

    expect(result.eventsDeleted).toBe(0);
    expect(await prisma.releaseEvent.findUnique({ where: { id: event.id } })).not.toBeNull();
  });
});

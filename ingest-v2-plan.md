# Ingestion v2 — rebuild status and handoff

Rebuild of how release dates enter the system, replacing the v1 crawler in
`lib/crawler/`. Started 2026-09-04. **v1 is still the live production pipeline;
v2 is not cut over.**

Design doc (options analysis + full architecture, with the measured v1
diagnosis): https://claude.ai/code/artifact/eb5f4531-8d53-4683-946a-6ea917a7329b

## Why

v1 was measured, not guessed. Its last full scan created 3,196 events, marked
3,176 as already-released, and hard-deleted 3,173 — leaving **36 future-dated
events across all seven games**, 55% of live events with no usable date, and 0
of 2,274 live product sets carrying an image. It scraped ~20 community sites for
the full history of every game to surface a few dozen upcoming dates. That churn
was simultaneously the performance problem, the data-quality ceiling and the
site-ban risk.

Root causes: it harvested the past to find the future (no forward-window
filter); every source sat at `COMMUNITY` tier so the confidence model had no
real tier separation to work with; one brittle cheerio table parser served every
source; and there was no politeness budget beyond a concurrency constant.

## Decisions taken (don't relitigate)

- Budget: **< $50/month all-in**, including hosting. Net new spend is currently **$0**.
- **Claude API is deferred**, but the seam is kept — `Reviewer` interface with a
  no-op implementation, `ReviewItem.summary` nullable, `RunDiff` computed and
  stored regardless. Adding it later is one file plus an env var. Note a Claude
  Pro/Max subscription **cannot** fund this — server-side calls need Anthropic
  API credits, a separate billing relationship.
- **No human-in-the-loop as routine.** Correctness is structural: a deterministic
  gate, not editorial review. The review queue exists only for what the gate
  can't decide.
- All v1 scrape logic is considered **dropped**. It stays on disk only until cutover.
- Retention **hard-deletes**, including events with user interactions attached
  (`EventFollow`, `EventReaction`, etc. cascade). Accepted deliberately.
- Region is part of the v2 event key. Region badge shows on cards only when
  region is not `GLOBAL`.

## Architecture

Six stages, one direction. **Fetch is the only stage that touches the network**
and it persists raw payloads *before* anything parses them — which is what makes
every later stage a pure function, and therefore what makes replay work.

```
Fetch      providers/*        → RawPayload[]        (only impure stage)
Normalize  providers/*/parse  → Candidate[]         (zod; rejects, never coerces)
Resolve    identity.ts        → ResolvedCandidate[] (id → code → name → new)
Record     claims.ts          → SourceClaim[]       (immutable ledger)
Gate       gate.ts            → Verdict[]           (pure; the only publish decision)
Apply      apply.ts           → ScanRun.totals + RunDiff
```

Code lives in `lib/ingest/`, DB access in `data/ingest/ingestRepo.ts`.

### The gate — `lib/ingest/gate.ts`

Rules decide visibility; confidence is computed and stored for display and queue
ranking but **does not** decide what publishes. Thresholds live in one exported
`GATE_THRESHOLDS` const.

- **G1** — publish on one OFFICIAL claim.
- **G2** — else publish on two **independent** origins agreeing within ±3 days.
- **G3** — a lone RETAILER claim publishes after 7 consecutive unchanged runs.
- **G4** — SPECULATIVE never publishes a date.
- **G5** — two qualifying claims >3 days apart: hold the previous value, flag.
- **G6** — a published date moving >14 days flags even on unanimous agreement.
- **G7** — absence never unpublishes a future event; 14 days of unanimous
  absence marks it CANCELLED. Only cancels *future* events — a past-dated
  release dropping off its sources has shipped, not been cancelled.

**Independence is by declared origin lineage** (`ORIGINS` in `lib/ingest/types.ts`,
`derivesFrom`). Two origins where one derives from the other — or that share an
ancestor — count as one. This is the rule v1 lacked; four fan sites that all
copied TCGplayer are one source in four hats.

## Providers — `lib/ingest/providers/`

All free, all structured except the two Bandai pages. Fixtures in
`tests/fixtures/ingest/`; **tests never hit the network**.

| key | origin | tier | games |
|---|---|---|---|
| `tcgcsv` | tcgplayer | RETAILER | all 7 (categories: MTG 1, YGO 2, PKM 3, OP 68, LOR 71, GDM 86, RIFT 89) |
| `scryfall` | scryfall | COMMUNITY (`derivesFrom: wizards-official`) | MTG |
| `ygoprodeck` | ygoprodeck | COMMUNITY | Yu-Gi-Oh |
| `wikipedia` | wikipedia | COMMUNITY | MTG, PKM, LOR, RIFT |
| `bulbapedia` | bulbapedia | COMMUNITY | Pokémon incl. JP list |
| `bandaiOnePiece` | bandai-official | **OFFICIAL** | One Piece |
| `bandaiGundam` | bandai-official | **OFFICIAL** | Gundam |

**Per-game origins → publishing rule:** Pokémon/MTG (3 origins, G2), Yu-Gi-Oh /
Lorcana / Riftbound (2, G2), One Piece / Gundam (2 incl. publisher, **G1**).
No game is single-origin.

Key facts: Scryfall carries `tcgplayer_id` = TCGCSV `groupId` — **372/372
non-digital sets joined exactly**, which is what replaced fuzzy matching as the
primary mechanism. A **90-day forward-window filter** is applied by every
provider at parse time (`FORWARD_WINDOW_DAYS`) — this is what makes hard-delete
retention safe rather than a churn loop.

Skipped deliberately: **Riftbound** (Riot's site is a news landing page; no
product index exists) and **Lorcana** (dates only in per-product marketing prose
across ~28 pages, and its "Everywhere" date disagrees with TCGplayer's shelf date
by a week — would put every Lorcana set in permanent G5 conflict). Both already
have two origins and publish under G2, so skipping costs nothing.

## Status

| Phase | Commit | Landed |
|---|---|---|
| 1 | `6038310` | Schema substrate, six-stage skeleton, gate, replay/retry |
| 2 | `092af77` | Five structured providers, fixtures, polite fetch layer |
| 3 | `f5c3142` | Set-code identity tier (see below) |
| 3 | `0ae1039` | Bandai publisher providers — first OFFICIAL-tier origins |
| 4 | `6fa0d36` | Region in event key, region badge, placeholder-name fix, retention alignment |
| 5 | (pending) | Cron trigger route, provider health/replay/retry UI, freshness alarms, review queue UI |

**742 tests passing**, typecheck, lint, and a production build all clean.
Nothing pushed. One **pre-existing** lint error in
`app/calendar/MobileMonthCalendar.tsx` (`react-hooks/set-state-in-effect`) is
unrelated to this work.

### Two bugs this work uncovered, both real

1. **Phase 2's resolver was silently false-merging.** Seven Marvel Super Heroes
   products fused into one ProductSet at 0.86 similarity; also Star Trek +
   Star Trek Commander, Secret Lair Drop Series + Secret Lair Series, and three
   more. The Phase 3 identity fix made set counts go *up*, which is the tell.
2. **Retention was 30 days against a 90-day forward window.** Anything 30–90 days
   past its date was purged nightly and re-ingested the next run — v1's churn
   loop, rebuilt. Fixed by flooring the event purge at `FORWARD_WINDOW_DAYS`.

### Identity resolution — `lib/ingest/identity.ts`

Order: **external id → set code → name → new**, returned in `matchedBy`.
The code tier exists because TCGCSV prefixes codes (`ME06: Delta Reign`) while
wikis use expansion-series names (`Mega Evolution—Delta Reign`) — these scored
0.571 and did not match, so Pokémon would have published nothing.

Three guards keep the looser matching safe: **code disagreement vetoes a name
match**; a code one origin gives to several products is not a key (TCGCSV's
Pokémon `abbreviation` is `POP` for all nine POP Series sets); tail comparison
is exact-only. Placeholder codes and names (`TBA`, `TBD`, `Unnamed …`) are never
identity keys — the prefix rule stops at a word boundary because Unglued /
Unhinged / Unstable / Unfinity are real products.

## Phase 5 — done, not yet pushed

1. **Authenticated cron trigger route** — `POST /api/ingest/run`
   (`app/api/ingest/run/route.ts`). Bearer token from `INGEST_TRIGGER_TOKEN`
   compared with `timingSafeEqual`, **fails closed if the env var is unset**,
   also accepts an admin session (so the System tab can call it without
   handing the browser the shared secret). Returns 202 immediately; the run
   itself is fire-and-forget, logged on completion. Reuses `startIngest`'s
   existing `JobLock`, so it can't race a concurrent scan (v1's scheduler
   included — they still share one lock). v1's in-process scheduler is
   untouched and still the live trigger until cutover.
2. **Provider health + replay controls**, `app/admin/SystemTab.tsx` +
   `data/admin/adminRepo.ts`. Per-run per-provider status (OK/PARTIAL/FAILED,
   the PARTIAL case computed because `ScanRun.status` alone can't express
   "4 of 5 providers worked"), a per-provider freshness table, and Replay
   (no network, re-derives from stored payloads) / Retry-failed (re-fetches
   only FAILED providers) buttons wired to `lib/ingest/replay.ts`.
3. **Freshness alarms** — `lib/ingest/freshness.ts` + new `ProviderAlarm`
   table. Pure `evaluateFreshness` (testable at the hour, no clock/DB) plus
   `runProviderFreshnessAlarmPass`, idempotent by design: the *condition*
   (≥48h silent) is true every run for the length of an outage, but the
   `ProviderAlarm` row remembers whether anyone's been told, so a standing
   outage alarms once and then at most once per 24h repeat window, and a
   recovery sends its own distinct notice. Dispatches through a new
   `dispatchAdminAlarm` (`lib/notifications/dispatch.ts`) to every active
   admin's already-configured email/Discord channels — no new channel, no new
   opt-in.
4. **Review queue UI** — `app/admin/ReviewQueue.tsx`, wired into
   `ReviewTab.tsx` alongside (not merged with) v1's existing contradiction
   list, since the two pipelines' flags mean different things while both are
   live. Renders the raw claim comparison when `summary` is null (always,
   today) rather than fabricating one. "Accept" writes the claim's date onto
   the event and sets `isManualOverride` — `applyVerdictToEvent`
   (`data/ingest/ingestRepo.ts`) already skips the date write for an
   overridden event on every later scan, so this one flag is enough to make
   the decision stick. "Keep"/"Dismiss" just close the item.

Test coverage added alongside: `evaluateFreshness`'s 48h boundary and
never-succeeded case, `runProviderFreshnessAlarmPass`'s idempotency/repeat/
recovery behavior against a real DB, `dispatchAdminAlarm`'s per-channel/
per-recipient isolation, the trigger route's auth matrix (bearer token,
admin session, fail-closed-when-unset, malformed body, already-running), and
the review-resolution paths (accept/keep/dismiss, already-resolved,
out-of-range claim index) plus the System tab's health classification.

## Then — cutover (Phase 6)

1. **Golden set**: hand-verify every upcoming release across the seven games
   against publisher announcements (~40 events, an afternoon). Commit as a
   fixture the gate is tested against forever.
2. **Shadow run**: v2 nightly to a shadow table for two weeks, diffed daily
   against the golden set. Cut over when the diff is empty twice running — not
   when the code is finished.
3. Then delete `lib/crawler/`, `data/crawler/`, `tests/crawler*.test.ts`, the
   dead source configs in `prisma/seed.ts`, and the in-process scheduler.
4. `ProductSet.code` is nullable in a composite unique — SQLite allows unlimited
   NULLs, so nameless sets bypass the constraint entirely. Backfill a synthetic
   code and make it required. Marked `TODO(phase5)` in `prisma/schema.prisma`.

## Known risks / deferred

- **Bandai JP sites deferred.** Label is 発売日, dates read `2026.10.03(土)`,
  codes are full-width `【EB-05】`, and `TITLE_CODE` is the accessory filter —
  getting it wrong puts playmats on the calendar at OFFICIAL tier. Notes in
  `lib/ingest/providers/bandaiOnePiece.ts`.
- **Bandai pagination is by announcement, not release date.** Three pages covered
  the 90-day window with one page of margin; an announcement burst could push a
  near-future product to page 4. Widening it is one constant.
- **The code veto assumes origins agree on codes.** True across all seven
  providers today. A future origin with its own code vocabulary would split
  legitimate pairs rather than merge them — conservative, but it would show as a
  silent drop in the pairing rate. The per-game counts pinned in
  `tests/ingestIdentityFixtures.test.ts` are the tripwire.
- **TCGCSV is a courtesy mirror of TCGplayer's catalogue** with no uptime
  promise, and it's the widest provider. Every game keeps a second origin so its
  loss degrades coverage rather than emptying the calendar. Read its terms before
  launch; put a real contact address on the crawler's user-agent.
- Two JP rows collapsing onto one English product would be a within-JP G5
  conflict. Doesn't occur in the fixtures; the gate handles it as designed.

## Conventions

Providers are pluggable: implement `Provider` in `lib/ingest/providers/types.ts`
and register in `registry.ts`. Stages 2–6 stay **pure** — no I/O, no
`Date.now()` (inject `now`) — or replay breaks. Keep DB access in the repo
module. Log via `lib/logger.ts`'s `logEvent`. Comment *why*, matching the
surrounding code.

`ENVIRONMENT.md` is gitignored and machine-local. **The repo is public — never
commit hostnames, IPs, or secrets.**

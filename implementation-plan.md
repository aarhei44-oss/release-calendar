# Implementation Plan — TCG Release Calendar ("Release Watcher")

Status: Draft v1 (greenfield rewrite)
Audience: AI coding agents (Claude Sonnet/Opus) executing this plan phase-by-phase; each phase's steps are written to be directly tasked out.
Companion documents: [functional-spec.md](./functional-spec.md), [technical-spec.md](./technical-spec.md)

Ground rule (from project conventions): **the application must build and run successfully (via Docker Compose) before any phase is considered complete.** Verify this at the end of every phase, not just at the end of the project.

---

## Phase 0 — New Repository Scaffolding

**Goal**: Stand up a brand-new, empty-but-runnable Next.js app in a separate git repository, with tooling matching the technical spec.

Steps:
1. Initialize a new git repository (outside/independent of the current `tcg-calendar` workspace history).
2. Scaffold a Next.js (App Router) + TypeScript project; enable `strict` mode in `tsconfig.json`.
3. Add Tailwind CSS, ESLint config, Prettier (or project-standard formatter).
4. Add `prisma`, `@prisma/client`, and the SQLite driver adapter (`better-sqlite3` + Prisma's better-sqlite adapter) as dependencies.
5. Add `next-auth`, Google provider dependency, and the Prisma adapter for NextAuth.
6. Add `zod` for validation.
7. Add `date-fns` and `react-big-calendar`.
8. Add `cheerio` (or equivalent) for crawler HTML parsing.
9. Add `vitest` (unit/integration) and `playwright` (e2e) as dev dependencies with minimal starter config.
10. Copy over and adapt `Dockerfile`, `docker-compose.yml`, `Caddyfile`, `entrypoint.sh` from the prototype as a starting point (per technical spec §10), adjusting for the new repo's structure.
11. Write a fresh `README.md` describing the project (replace default scaffold text — a known prototype gap).
12. Commit the empty-but-building skeleton.

Verification checklist:
- [ ] `npm run build` succeeds locally.
- [ ] `docker compose up` builds and serves a default Next.js page through Caddy.
- [ ] TypeScript strict mode has zero errors on the empty scaffold.

---

## Phase 1 — Data Layer

**Goal**: Author the full Prisma schema per technical spec §3, generate the client, and stand up repo modules with seed data.

Steps:
1. Write `prisma/schema.prisma` with all models/enums from technical spec §3.1–3.2, including the new `Subscription` model and `User.role`-only admin flag (no `preferences.isAdmin`).
2. Run initial migration (`prisma migrate dev`) creating the SQLite schema.
3. Implement `lib/prisma.ts` singleton client using the SQLite driver adapter.
4. Write `prisma/seed.ts`: idempotent bootstrap of at least the launch TCG profile packages (e.g., Pokémon, MTG, One Piece) and their installs, with sample product sets, so the calendar has visible data immediately.
5. Implement repo module skeletons (empty but typed function signatures) for `calendarRepo`, `adminRepo`, `subscriptionsRepo`, `crawlerRepo` (technical spec §7).
6. Implement `calendarRepo.getFilteredEvents(filters)` and `getEventDetail(eventId)` against real data (used to validate the schema end-to-end).
7. Write unit tests for repo query-building logic (e.g., filter combination correctness).

Verification checklist:
- [ ] `prisma migrate dev` + `prisma db seed` run cleanly from a fresh DB.
- [ ] A script/test can fetch seeded events via `calendarRepo`.
- [ ] App still builds/runs via Docker Compose with the DB volume mounted.

---

## Phase 2 — Auth & Authorization

**Goal**: Working Google sign-in with database sessions, and the two shared guard helpers used everywhere downstream.

Steps:
1. Configure NextAuth v4 (`app/auth.ts`) with Google provider + Prisma adapter + database session strategy.
2. Implement `app/api/auth/[...nextauth]/route.ts`.
3. Implement first-sign-in admin bootstrap: on user creation, if email is in `ADMIN_EMAILS` env var, set `role = ADMIN`.
4. Implement `requireUser()` and `requireAdmin()` helpers (throw/return typed errors, no legacy cookie fallback).
5. Add session type augmentation (`types/next-auth.d.ts`) exposing `user.id` and `user.role`.
6. Add a minimal sign-in/sign-out UI affordance (header/site shell button).
7. Write integration tests: unauthenticated call to a `requireUser`-gated action fails; non-admin call to a `requireAdmin`-gated action fails; admin call succeeds.

Verification checklist:
- [ ] Google sign-in works end-to-end locally (test OAuth credentials).
- [ ] `ADMIN_EMAILS` bootstrap correctly assigns `ADMIN` role on first sign-in.
- [ ] No code path reads identity from a cookie other than the NextAuth session cookie.

---

## Phase 3 — Core Calendar UI

**Goal**: Public, no-login browsing experience: Calendar / Events List / Upcoming tabs with filtering and event detail.

Steps:
1. Build `app/calendar/page.tsx` reading query-string filters, calling `calendarRepo.getFilteredEvents`.
2. Build `mapEvents.ts` translating `ReleaseEvent` records (respecting `dateType` semantics: `EXACT`/`RANGE`/`WINDOW` placed on calendar grid, `TBD` excluded from grid but shown in list views) into calendar-library event shapes.
3. Build `ClientCalendar.tsx` (month view) using `react-big-calendar`.
4. Build `Tabs.tsx` (Calendar / Events List / Upcoming) with independent per-tab month state in the query string.
5. Build `MonthSwitcher.tsx` shared prev/next navigation.
6. Build `FilterBar.tsx`: install/type/status filters + search input, query-string driven, calling back into server-rendered results.
7. Build `EventDrawer.tsx`: shows date semantics, status, confidence, and the list of `SourceClaim`s for an event.
8. Add typed ambient/library types replacing the prototype's loose `any`-based contracts where practical.

Verification checklist:
- [ ] All three tabs render seeded events with correct date placement per `dateType`.
- [ ] Filters (install/type/status/search) correctly narrow results via URL state.
- [ ] Event drawer shows source claims for a seeded event.
- [ ] No login required for any of the above.

---

## Phase 4 — User Engagement Features (Comments & Subscriptions)

**Goal**: Signed-in personalization: comments and subscriptions, backed by relational storage (no JSON blobs).

Steps:
1. Implement `addComment(eventId, content)` Server Action: `requireUser`, zod validation (non-empty, max length), rate-limit check, persists `UserNote`.
2. Implement `deleteComment(commentId)` Server Action: `requireUser`, allowed only if requester is the author or an admin.
3. Build canonical `CommentsForEvent.tsx` component embedded in `EventDrawer.tsx` (single implementation — do not create a second duplicate component).
4. Implement `subscriptionsRepo` + Server Actions `subscribe(installId)` / `unsubscribe(installId)` writing to the relational `Subscription` table.
5. Build `app/subscriptions/page.tsx`: list of subscribable installs with subscribe/unsubscribe controls, and an "upcoming for my subscriptions" view (next 30 days).
6. Write integration tests: non-author cannot delete another user's comment; admin can delete any comment; subscribe/unsubscribe is idempotent and reflected immediately in the upcoming view.

Verification checklist:
- [ ] Comments persist and display correctly per event.
- [ ] Comment delete permission rules enforced server-side.
- [ ] Subscriptions persist in the `Subscription` table (verify via DB inspection, not just UI).
- [ ] Subscriptions page shows correct 30-day upcoming events for subscribed installs only.

---

## Phase 5 — Admin Console

**Goal**: Safe, fully-guarded admin tooling for profile/install management, user management, and system/data-quality oversight.

Steps:
1. Build `app/admin/page.tsx` + `AdminTabs.tsx` (Profiles / Users / System), gated by `requireAdmin` at the page/layout level (defense in depth alongside action-level guards).
2. **Profiles tab**: list packages/installs, toggle `enabled`, "Enable & Seed Selected" action calling into seed logic.
3. **Users tab**: list users, toggle `role` (USER/ADMIN) and `active` flag — single canonical `actions.ts` (do not recreate the prototype's `action.ts`/`actions.ts` duplication).
4. **System tab**: list recent `ScanRun`s (status/totals/timestamps) per install; button to trigger manual rescan; button to trigger a dedup pass over `ReleaseEvent`s.
5. Decide fate of the prototype's generic "DB CRUD console": either omit it, or reimplement it strictly `requireAdmin`-gated and scoped to an explicit allow-list of models (never an open passthrough). Document the decision in code comments/README.
6. Write integration tests confirming every admin Server Action rejects non-admin and unauthenticated callers, and confirming the resolved `UsersTab` has no leftover merge-conflict artifacts (prototype had stray conflict markers — ensure clean single implementation).

Verification checklist:
- [ ] Non-admin session gets 403/redirect on every admin action and admin page.
- [ ] Enable & Seed produces the expected product sets for a package.
- [ ] User role/active toggles persist and immediately affect authorization on next request.
- [ ] Scan run history displays correctly (can use fixture/mock scan runs until Phase 6 lands).

---

## Phase 6 — Crawler / Scraper Subsystem

**Goal**: Automated discovery of release information per technical spec §6, with at least one working source adapter per launch TCG profile.

Steps:
1. Implement `crawlerRepo`: persistence for `DiscoveryHit`, `SourceClaim`, `ScanRun`, `JobLock`.
2. Implement `JobLock` acquire/release helpers (prevent overlapping scans for the same scope).
3. Define the parser adapter interface (`{ key, fetch(config), parse(raw) }`) and an adapter registry keyed by parser key.
4. Implement at least one real adapter per launch TCG profile (e.g., an official/community release-date page per game), plus one fixture-based adapter used purely for automated tests.
5. Implement the scan orchestration function: create `ScanRun` → acquire lock → for each source, fetch → store `DiscoveryHit` → parse → upsert `SourceClaim`s → recompute affected `ReleaseEvent` confidence/status (skipping date fields when `isManualOverride` is true) → dedup check against existing events → finalize `ScanRun` totals/status → release lock.
6. Wire an admin-triggered manual scan (System tab button → Server Action → orchestration function).
7. Wire scheduled execution (container-level interval/cron or `CRAWLER_SCHEDULE` env-driven in-process scheduler) for enabled installs.
8. Write unit tests for parser adapters against fixture HTML, and unit tests for confidence computation and dedup matching logic.
9. Write an integration test that runs the orchestration function end-to-end against the fixture adapter and asserts `ReleaseEvent`/`SourceClaim`/`ScanRun` records are created as expected.

Verification checklist:
- [ ] Manual admin-triggered scan for one install completes and produces visible `ScanRun` totals.
- [ ] At least one real external source adapter succeeds against the live source (spot-checked manually).
- [ ] Duplicate scans do not create duplicate `ReleaseEvent`s (dedup verified).
- [ ] Manual override events are not overwritten by crawler-derived dates.
- [ ] Overlapping scan attempts for the same install are prevented by `JobLock`.

---

## Phase 7 — Deployment & Operations

**Goal**: Production-shaped self-hosted deployment matching technical spec §10–11.

Steps:
1. Finalize multi-stage `Dockerfile` (deps → build → runtime).
2. Finalize `docker-compose.yml` (app + caddy services, SQLite volume, environment variable wiring).
3. Finalize `Caddyfile` (reverse proxy + TLS config for the target domain).
4. Finalize `entrypoint.sh`: run migrations → run seed/enable-profiles bootstrap → optionally start the in-process crawler scheduler → start the app.
5. Implement `/api/health` route reporting DB connectivity.
6. Document all required environment variables (README or `.env.example`): `DATABASE_URL`, `NEXTAUTH_URL`, `NEXTAUTH_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `ADMIN_EMAILS`, `CRAWLER_SCHEDULE`.
7. Document backup strategy for the SQLite file (e.g., volume snapshot or scheduled file copy).

Verification checklist:
- [ ] `docker compose up` from a clean checkout builds, migrates, seeds, and serves the app behind Caddy.
- [ ] `/api/health` returns healthy status.
- [ ] Restarting the stack preserves data (volume persistence confirmed).

---

## Phase 8 — Hardening & Polish

**Goal**: Close remaining gaps before calling MVP complete.

Steps:
1. Accessibility pass: keyboard operability and ARIA labeling for tabs, filter bar, and drawer.
2. Mobile responsiveness pass for calendar/list/upcoming views and admin tabs.
3. Structured logging pass: consistent log shape for Server Actions and crawler runs (request/action id, user id, duration, outcome).
4. Test coverage pass: ensure unit tests exist for every repo module and every crawler adapter; integration tests exist for every authorization boundary (admin actions, comment delete, subscription actions).
5. Dead-code sweep: confirm no duplicate action files, no duplicate components, no leftover merge-conflict markers, no unused generic/unguarded admin endpoints remain (explicitly re-check the issues enumerated in the functional spec's business rules and technical spec's security section).
6. Final end-to-end smoke test (Playwright) covering: browse → filter → view detail → sign in → subscribe → comment → sign out; admin sign-in → toggle install → trigger manual scan → view scan run result.

Verification checklist:
- [ ] All items in this phase's steps are complete and demonstrated via passing automated tests where applicable.
- [ ] Full Docker Compose stack builds and runs cleanly from a fresh clone as the final gate.

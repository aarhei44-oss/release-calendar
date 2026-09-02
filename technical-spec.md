# Technical Specification — TCG Release Calendar ("Release Watcher")

Status: Draft v1 (greenfield rewrite)
Audience: AI coding agents (Claude Sonnet/Opus) and engineers implementing the system.
Companion documents: [functional-spec.md](./functional-spec.md), [implementation-plan.md](./implementation-plan.md)

---

## 1. Architecture Overview

Release Watcher is a single Next.js application (App Router only — no legacy Pages Router APIs) that serves both the UI and its backend via React Server Components, Server Actions, and Route Handlers. It talks to a SQLite database through Prisma. Authentication is handled by NextAuth (Google OAuth) with database-backed sessions. A background/cron-triggered crawler subsystem, implemented as part of the same app, discovers and proposes release event data from external sources.

```mermaid
flowchart LR
    Browser -->|HTTPS| Caddy
    Caddy -->|reverse proxy| NextApp[Next.js App\nApp Router + Server Actions]
    NextApp -->|Prisma| SQLite[(SQLite file\nvolume-mounted)]
    NextApp -->|OAuth| Google[Google OAuth]
    Scheduler[Container cron / admin trigger] -->|invokes| Crawler[Crawler subsystem\n(in-app module)]
    Crawler -->|HTTP fetch| ExternalSources[External TCG\nrelease sources]
    Crawler -->|Prisma writes| SQLite
```

Deployment unit: one Docker image running the Next.js app, fronted by Caddy (TLS termination + reverse proxy) via Docker Compose. The SQLite database file lives on a persistent volume.

## 2. Technology Stack

| Layer | Choice | Notes |
|---|---|---|
| Framework | Next.js (App Router) | Single routing system; Route Handlers under `app/api/**`, Server Actions co-located with pages/features. No `pages/api` directory. |
| Language | TypeScript (strict mode) | `strict: true`, no implicit `any`; ambient `.d.ts` files kept minimal and accurate. |
| UI | React 19 + Tailwind CSS | Reuse existing visual patterns (tabs, filter bar, drawer) from the prototype. |
| Calendar UI | `react-big-calendar` + `date-fns` | Same library as prototype; wrap with typed adapter instead of loose ambient types. |
| ORM / DB | Prisma + SQLite (via `better-sqlite3` driver adapter) | Single-file DB suitable for self-hosted small-scale deployment; Prisma migrations are the schema source of truth. |
| Auth | NextAuth v4 + Google provider + Prisma adapter | Database sessions only. No custom cookie-based identity path. |
| Validation | `zod` | Every Server Action and Route Handler validates its input with a zod schema before touching the database. |
| HTTP fetch (crawler) | native `fetch` + a thin HTML parsing layer (e.g. `cheerio`) | Per-source adapter pattern; see §6. |
| Containerization | Docker (multi-stage build) + Docker Compose | App container + Caddy container. |
| Reverse proxy / TLS | Caddy | `Caddyfile` at repo root, same pattern as prototype. |
| Testing | Vitest (unit/integration) + Playwright (smoke e2e) | See §9. |

## 3. Data Model

The data model carries forward the prototype's entities (they matched the domain well) with targeted corrections: subscriptions become a relational table, and the admin flag is unified onto `User.role`.

### 3.1 Entities

- **TcgProfilePackage** — `id, slug (unique), name, version, description?, discoveryConfig (json), sourceConfigs (json), createdAt, updatedAt`. One-to-many → `TcgProfileInstall`.
- **TcgProfileInstall** — `id, packageId, installedVersion, enabled, settings (json)?, createdAt, updatedAt`. Belongs to package; has many `ProductSet`, `DiscoveryHit`, `ScanRun` (optional scope), `Subscription`.
- **ProductSet** — `id, tcgProfileInstallId, code?, name?, releaseQuarter?, meta (json)?, createdAt, updatedAt`. Unique `(tcgProfileInstallId, code)`. Has many `ReleaseEvent`.
- **ReleaseEvent** — `id, productSetId, type (enum ReleaseEventType), dateType (enum DateType), dateExact?, dateStart?, dateEnd?, windowGranularity?, windowStart?, windowEnd?, region (enum Region), status (enum ReleaseStatus), confidence (float), sourceSummary?, lastSeenAt?, isManualOverride (bool), manualNotes?, createdAt, updatedAt`. Indexes: `(productSetId, type)`, `(dateType, dateExact, dateStart)`. Has many `SourceClaim`, `UserNote`.
- **SourceClaim** — `id, releaseEventId, tier (enum SourceTier), disposition (enum SourceDisposition), confidenceWeight (float), url, host?, dateExact?/dateStart?/dateEnd? (mirrors event date fields), lastVerifiedAt?, raw (json)?, createdAt, updatedAt`. Index `(releaseEventId, lastVerifiedAt)`.
- **ScanRun** — `id, scopeType (enum ScanScopeType), scopeId?, status (enum ScanStatus), totals (json)?, trigger (enum ScanTrigger), createdAt, updatedAt, startedAt?, finishedAt?`. Optional relation to `TcgProfileInstall` via `scopeId`.
- **DiscoveryHit** — `id, tcgProfileInstallId, url, title?, raw (json)?, seenAt, createdAt, updatedAt`. Unique `(tcgProfileInstallId, url)`.
- **JobLock** — `id, jobName, scopeKey, ownerId?, acquiredAt, expiresAt?, createdAt, updatedAt`. Unique `(jobName, scopeKey)`. Used by the crawler to prevent overlapping scan runs for the same scope.
- **User** — `id, email (unique), name, image?, emailVerified?, role (enum UserRole, default USER), createdAt, updatedAt, active (bool, default true)`. Has many `Account`, `Session`, `UserNote`, `Subscription`. **No `preferences.isAdmin`** — retired in favor of `role`.
- **Subscription** *(new, replaces JSON preferences)* — `id, userId, tcgProfileInstallId, createdAt`. Unique `(userId, tcgProfileInstallId)`. Belongs to `User` and `TcgProfileInstall`.
- **UserNote** *(comments)* — `id, userId, releaseEventId, content, createdAt, updatedAt`. Index `(userId, releaseEventId)`.
- **Account / Session / VerificationToken** — standard NextAuth Prisma adapter tables, unchanged in shape from the prototype.

### 3.2 Enums (carried forward)
`ReleaseEventType`, `DateType`, `WindowGranularity`, `Region`, `ReleaseStatus`, `SourceTier`, `SourceDisposition`, `ScanScopeType`, `ScanStatus`, `ScanTrigger`, `UserRole` (`USER`, `ADMIN`).

### 3.3 Migration notes from prototype
- Add `Subscription` model; write a one-time migration/backfill script if any prototype data must be carried over (parse `User.preferences.subscriptions` JSON → rows). Not required if starting with empty data.
- Drop reliance on `preferences.isAdmin`; seed initial admin(s) by email via an environment variable (`ADMIN_EMAILS`) applied at first sign-in.

## 4. Auth & Authorization

- NextAuth v4, Google provider, Prisma adapter, **database session strategy** (not JWT), matching prototype's proven approach.
- `app/auth.ts` exports the NextAuth config; a single `getSession()`/`auth()` helper is the only way server code reads identity.
- Two shared guard helpers, used by every Server Action and Route Handler that needs them:
  - `requireUser()` — throws/returns 401 if no session.
  - `requireAdmin()` — throws/returns 403 if session user's `role !== 'ADMIN'`.
- No endpoint or Server Action may perform an admin-only mutation without calling `requireAdmin()` first — this closes the prototype's gap where some admin routes had no guard or a commented-out guard.
- First-sign-in bootstrap: if the signing-in user's email is in `ADMIN_EMAILS` (env var, comma-separated), set `role = ADMIN` at account creation time.

## 5. API & Server Action Surface

All mutations and data fetches for interactive UI use **Server Actions** co-located with their feature folder. Route Handlers (`app/api/**`) are reserved for: NextAuth (`/api/auth/[...nextauth]`), health check, and any endpoint that must be called by non-browser clients (e.g., container entrypoint seed trigger).

### 5.1 Route Handlers
| Path | Method(s) | Purpose | Auth |
|---|---|---|---|
| `/api/auth/[...nextauth]` | GET/POST | NextAuth core | public |
| `/api/health` | GET | DB readiness probe | public |
| `/api/admin/enable-profiles` | POST | Seed-on-boot / admin bootstrap trigger | admin (or internal container secret for boot-time call) |

### 5.2 Server Actions (by feature)
- **Calendar** (`app/calendar/actions.ts`): `getFilteredEvents(filters)`, `getEventDetail(eventId)`.
- **Comments**: `addComment(eventId, content)` (requireUser, zod-validated, length-limited), `deleteComment(commentId)` (requireUser; allowed if author or admin).
- **Subscriptions** (`app/subscriptions/actions.ts`): `subscribe(installId)`, `unsubscribe(installId)`, `getMySubscriptionsUpcoming()` — all `requireUser`.
- **Admin — profiles** (`app/admin/actions.ts`): `listPackagesWithInstalls()`, `toggleInstallEnabled(installId, enabled)`, `enableAndSeedInstall(installId)` — all `requireAdmin`.
- **Admin — users**: `listUsers()`, `setUserRole(userId, role)`, `setUserActive(userId, active)` — all `requireAdmin`.
- **Admin — system**: `listScanRuns(installId?)`, `triggerRescan(installId)`, `triggerDedup()` — all `requireAdmin`.

A single generic "DB CRUD console" (present in the prototype) is **not** carried forward as-is; if retained, it must be restricted to `requireAdmin` and scoped to an explicit allow-list of models — never a fully generic unguarded Prisma passthrough.

## 6. Crawler / Scraper Subsystem (New for MVP)

### 6.1 Goals
Reduce manual data entry by periodically discovering candidate release information for each enabled `TcgProfileInstall` from its configured external sources, recording evidence, and safely upserting `ReleaseEvent`/`SourceClaim` data.

### 6.2 Configuration
- `TcgProfilePackage.discoveryConfig` (JSON): default discovery strategy for the TCG (e.g., candidate site list, URL templates).
- `TcgProfileInstall.sourceConfigs` is inherited/overridden per install — allows per-install source tuning without changing the shared package definition. *(Note: aligns fields with prototype schema; if `sourceConfigs` is package-level only in the final schema, installs inherit it — confirm during Phase 1 schema authoring.)*
- Each source config entry specifies: source URL/template, source `tier` (trust class), and a parser adapter key.

### 6.3 Execution model
1. A `ScanRun` is created (`trigger` = `SCHEDULED` or `MANUAL`, `scopeType` = `INSTALL` or `ALL`, `status` = `RUNNING`).
2. A `JobLock` is acquired for `(jobName="crawler", scopeKey=installId or "global")`; if already locked and not expired, the run is skipped/queued.
3. For each configured source: fetch the page (`fetch`), store a `DiscoveryHit` (url, title, raw snapshot, `seenAt`), then run the matching **parser adapter** (a small per-source module implementing a common `parse(html) -> ParsedCandidate[]` interface).
4. Each `ParsedCandidate` (product set name/code, event type, date fields, region) is converted into a `SourceClaim` on the matching/created `ReleaseEvent`, with `tier`/`confidenceWeight` from the source config and `disposition` computed by comparing to existing claims (supports/contradicts/supersedes).
5. `ReleaseEvent.confidence` and `status` are recomputed as a pure function of that event's current `SourceClaim`s (weighted by tier + recency), **unless** `isManualOverride` is true, in which case crawler writes to date fields are skipped (claims are still recorded for visibility).
6. Deduplication: before creating a new `ReleaseEvent`, match on `(productSetId, type, dateType, date proximity window)`; if a close match exists, attach the new `SourceClaim` to it instead of creating a duplicate.
7. On completion, `ScanRun.status` = `SUCCEEDED`/`FAILED`, `totals` (json) records counts (hits fetched, claims created, events created/updated), `finishedAt` set, `JobLock` released.

### 6.4 Scheduling
- Container-level scheduler (e.g., a lightweight cron entry in the app container, or an external scheduler hitting an authenticated trigger endpoint/Server Action) invokes a scan per enabled install on a configurable interval (default: daily).
- Admin System tab can trigger an immediate `MANUAL` scan for one install or all installs.

### 6.5 Parser adapters
- Each supported external source implements a small adapter: `{ key: string; fetch(config): Promise<RawFetchResult>; parse(raw): ParsedCandidate[] }`.
- Adapters live in a dedicated module (e.g. `lib/crawler/adapters/*`) and are registered in a lookup map keyed by the `parser` key from source config — this keeps adding a new source to a low-risk, additive change.
- Launch scope: implement at least one working adapter per launch TCG profile (per functional spec §Success Criteria).

## 7. Repository Pattern

All Prisma access is centralized in repo modules — no direct `prisma.*` calls from components, Server Actions bodies, or Route Handlers beyond calling into a repo function. Repos:
- `data/calendar/calendarRepo.ts` — event querying/filtering, event detail with claims.
- `data/admin/adminRepo.ts` — profile/install/user management, scan run queries.
- `data/subscriptions/subscriptionsRepo.ts` — subscribe/unsubscribe/list.
- `data/crawler/crawlerRepo.ts` — discovery hit / source claim / scan run / job lock persistence.

Server Actions and Route Handlers are thin: validate input (zod) → call a repo function → revalidate/return.

## 8. Frontend Structure

Reuses prototype UI patterns, cleaned up (no duplicate components):
- `app/calendar/page.tsx` — server component fetching filtered events via query-string-derived filters.
- `ClientCalendar.tsx` — month grid using `react-big-calendar`.
- `Tabs.tsx` — Calendar / Events List / Upcoming, each with independent month state persisted in the query string.
- `FilterBar.tsx` — install/type/status/search filters, query-string driven.
- `EventDrawer.tsx` — event detail + `CommentsForEvent.tsx` (single canonical comments component — the prototype's duplicate `CommentsForEventComponent.tsx` is removed).
- `MonthSwitcher.tsx` — prev/next month navigation shared across tabs.
- `app/subscriptions/page.tsx` — my subscriptions + upcoming-for-subscriptions view.
- `app/admin/*` — `AdminTabs.tsx` (Profiles/Users/System), one canonical actions file per tab (the prototype's `action.ts`/`actions.ts` duplication is resolved to a single `actions.ts`).

## 9. Validation & Testing Strategy

- **Validation**: every Server Action/Route Handler input is parsed with a `zod` schema; invalid input returns a typed error result, never throws unhandled to the client.
- **Unit tests**: repo functions (query building, dedup matching, confidence computation), crawler parser adapters (given fixture HTML → expected `ParsedCandidate[]`).
- **Integration tests**: Server Actions against a test SQLite database (comments create/delete permissions, subscribe/unsubscribe, admin guards reject non-admins).
- **E2E smoke** (Playwright): calendar loads and filters, sign-in flow, admin pages reject non-admin session, one full crawler dry-run against a fixture source.

## 10. Deployment

- `Dockerfile`: multi-stage build (deps → build → runtime), same shape as prototype.
- `docker-compose.yml`: `app` service (Next.js, port internal) + `caddy` service (reverse proxy/TLS), SQLite file on a named/bind volume for persistence.
- `entrypoint.sh`: runs Prisma migrations, then optionally calls the seed/enable-profiles trigger, then starts the app; crawler scheduling can be a simple in-process interval or an OS-level cron calling into the app.
- `Caddyfile`: reverse proxy rules, same pattern as prototype.
- Environment variables (minimum): `DATABASE_URL`, `NEXTAUTH_URL`, `NEXTAUTH_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `ADMIN_EMAILS`, `CRAWLER_SCHEDULE` (cron expression or interval minutes).

## 11. Observability

- `/api/health` reports DB connectivity/readiness.
- Admin System tab surfaces recent `ScanRun`s (status, totals, timestamps) as the primary crawler health signal.
- Server-side structured logging (request id/action name/user id/duration) for Server Actions and crawler runs, written to stdout for container log collection.

## 12. Security Considerations (OWASP-aligned)

- **Broken access control**: every admin mutation server-side gated via `requireAdmin()`; no reliance on hidden UI. Comment delete authorization checked server-side (author-or-admin).
- **Injection**: Prisma parameterizes all queries; no raw SQL string concatenation. Crawler-fetched HTML is parsed, never executed/evaluated.
- **Input validation**: zod schemas on every action/route boundary; comment content length-capped and sanitized before render (React auto-escapes; avoid `dangerouslySetInnerHTML`).
- **SSRF risk in crawler**: source URLs come only from admin-configured `discoveryConfig`/`sourceConfigs`, not user input; fetch targets are restricted to the configured allow-list.
- **Secrets management**: OAuth client secret, `NEXTAUTH_SECRET`, admin emails via environment variables only; never committed to source control.
- **Session security**: NextAuth database sessions with secure cookies; no parallel custom cookie-based identity mechanism (removes the prototype's dual-identity drift).
- **Rate limiting**: basic per-user rate limit on comment creation to deter spam/abuse.

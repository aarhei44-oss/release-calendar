# Functional Specification — TCG Release Calendar ("Release Watcher")

Status: Draft v1 (greenfield rewrite)
Audience: Product stakeholders, and AI coding agents (Claude Sonnet/Opus) implementing the system.
Companion documents: [technical-spec.md](./technical-spec.md), [implementation-plan.md](./implementation-plan.md)

---

## 1. Executive Summary

Release Watcher is a self-hosted web application that gives trading card game (TCG) collectors, players, and retailers a single, reliable calendar of upcoming product releases (booster sets, prereleases, promos, and special events) across multiple TCG brands (e.g., Pokémon, Magic: The Gathering, One Piece Card Game). The system aggregates release information from multiple external sources, tracks how confident it is in each date, lets visitors browse and filter events without an account, and lets signed-in users personalize their view via subscriptions and comments. An admin console lets a small set of trusted curators manage which TCGs/product lines are tracked and oversee data quality.

The rewrite preserves the proven product concept and UI patterns of the original prototype but corrects architectural drift (inconsistent auth/identity, inconsistent admin authorization, JSON-blob personalization, duplicate code) and adds a first-class **automated crawler/scraper** so release data does not depend solely on manual entry.

## 2. Goals

- G1: Provide an always-up-to-date, trustworthy calendar of TCG product releases.
- G2: Make it effortless to browse and filter releases with no login required.
- G3: Let signed-in users personalize their experience (subscribe to specific games/product lines, comment on events).
- G4: Reduce manual data-entry burden via an automated crawler that discovers and proposes release dates from external sources, with source attribution and confidence scoring.
- G5: Give admins simple, safe tools to manage tracked TCGs/product lines, users, and data quality — without exposing unsafe/ungated operations.
- G6: Ship a maintainable, secure, self-hostable system (single Docker Compose stack) that a small team (or solo maintainer) can operate.

### Success Criteria
- A visitor can find "what's releasing this month" for a given TCG in under 3 clicks, with no account.
- At least one working crawler source per launch TCG profile produces verifiable `SourceClaim`s that back calendar events.
- No admin-only action is reachable without a server-side role check (closes the authorization gaps found in the prototype).
- A signed-in user's subscriptions and comments persist reliably across sessions and devices (relational storage, not client-only state).

## 3. Target Users / Personas

| Persona | Description | Key needs |
|---|---|---|
| Anonymous Browser | A collector/player checking upcoming releases | Fast browse/filter/search, no login friction |
| Signed-in Collector | Wants a personalized view | Subscribe to specific TCGs/product lines, comment/discuss, see "my upcoming" view |
| Admin/Curator | Small trusted group (owner + moderators) | Enable/disable tracked TCGs & installs, manage users, monitor data quality/crawler health, resolve duplicate/incorrect events |
| System (Crawler) | Automated background actor | Periodically discover and propose release event data from configured external sources |

## 4. Scope

### 4.1 In Scope (MVP / Phase 1 launch)
- Public calendar (month view), events list view, and "upcoming" view.
- Filtering by TCG/profile install, event type, status, and free-text search.
- Event detail view showing date semantics, confidence, and supporting source claims.
- Google sign-in (NextAuth).
- Comments on events (signed-in users; author or admin can delete).
- Subscriptions to one or more TCG profile installs (signed-in users), with a "my subscriptions" upcoming view.
- Admin console: manage profile packages/installs (enable/disable, seed), manage users (role, active flag), view scan/crawler run history and trigger dedup/data-quality actions.
- Automated crawler/scraper subsystem that scans configured external sources per TCG profile, proposes/updates release events with source attribution and confidence, and records scan run history.
- Self-hosted deployment via Docker Compose + Caddy reverse proxy.

### 4.2 Explicitly Out of Scope (for MVP)
- Payments / e-commerce / marketplace features.
- Native mobile apps (a responsive web UI is in scope; native apps are not).
- Multi-tenant SaaS (separate orgs/tenants) — this is a single-deployment, single-community app.
- Push/email notifications (candidate for future expansion, see §9).
- Public write API / third-party integrations.

## 5. Use Cases / User Stories

### 5.1 Browse & Discover
- UC-1: As a visitor, I can view a month calendar of release events for all tracked TCGs so I can see what's coming up.
- UC-2: As a visitor, I can switch between Calendar, Events List, and Upcoming tabs, each with independent month/date state.
- UC-3: As a visitor, I can filter events by one or more TCG installs, event type (shelf/prerelease/promo/special), and status, and search by product set name.
- UC-4: As a visitor, I can click an event to open a detail drawer showing date type (exact/range/window/TBD), status, confidence level, and the list of source claims backing the date.

### 5.2 Personalization (Signed-in)
- UC-5: As a signed-in user, I can sign in with Google.
- UC-6: As a signed-in user, I can subscribe/unsubscribe to a TCG profile install so I can track only the games I care about.
- UC-7: As a signed-in user, I can view an "Upcoming for my subscriptions" list scoped to the next 30 days.
- UC-8: As a signed-in user, I can add a comment to a release event.
- UC-9: As a signed-in user, I can delete my own comment; an admin can delete any comment.

### 5.3 Admin / Curation
- UC-10: As an admin, I can view all available TCG profile packages and their installs, and enable/disable an install.
- UC-11: As an admin, I can trigger "enable & seed" for a profile install to bootstrap its product sets.
- UC-12: As an admin, I can view and manage users: toggle admin role and active/disabled flag.
- UC-13: As an admin, I can view scan run history (per install) including status, totals, and timestamps.
- UC-14: As an admin, I can trigger a manual rescan for an install, and trigger a dedup pass over release events.
- UC-15: As an admin, every admin action above is denied (403) if attempted by a non-admin, including via direct API/action calls (not just hidden UI).

### 5.4 Automated Crawler
- UC-16: As the system, on a schedule (and on-demand via admin trigger), scan each enabled profile install's configured external sources for release information.
- UC-17: As the system, record each fetch as a `DiscoveryHit`, parse it into candidate release data, and record a `SourceClaim` with a source tier, disposition, and confidence weight.
- UC-18: As the system, upsert `ReleaseEvent` records from aggregated source claims, computing an overall confidence and status, and avoid creating duplicate events for the same product set/date.
- UC-19: As the system, prevent overlapping scan runs for the same scope using a job lock.

## 6. Business Rules

### 6.1 Release Event Date Semantics
- `dateType` is one of: `EXACT` (single confirmed date), `RANGE` (start/end date span), `WINDOW` (coarser granularity, e.g., month/quarter), or `TBD` (unknown).
- `TBD` events are excluded from the calendar month grid (no date to place them on) but appear in the Events List/Upcoming views as "date unconfirmed".
- `WINDOW` events carry a `windowGranularity` (e.g., month, quarter) plus `windowStart`/`windowEnd` bounds.

### 6.2 Confidence & Status
- Each `ReleaseEvent` has a `status` (e.g., rumored, announced, confirmed, released, cancelled) and a `confidence` score.
- Confidence and status are derived from the aggregate of associated `SourceClaim`s: higher-tier sources and more corroborating claims increase confidence.
- Manual admin override (`isManualOverride` + `manualNotes`) always takes precedence over crawler-derived values.

### 6.3 Source Claims
- Each `SourceClaim` has a `tier` (source trustworthiness class), a `disposition` (supports/contradicts/superseded), and a `confidenceWeight`.
- Claims are immutable historical evidence; new information creates new claims rather than mutating old ones (an event's current date/status is derived, not hand-edited, except via explicit manual override).

### 6.4 Deduplication
- Within a single profile install, a product set is unique by its `code`. Release events are matched/deduped by product set + event type + date proximity to avoid duplicate calendar entries when multiple sources report the same release.

### 6.5 Authorization
- Only signed-in users may comment or subscribe.
- A comment may be deleted by its author or by any admin.
- All admin-only capabilities (profile/install management, user management, scan history/triggers) require the acting user to have the `ADMIN` role, checked server-side on every action/route — never solely by hiding UI.
- There is exactly one source of truth for "is this user an admin": the user's `role` field. (The prototype's parallel `preferences.isAdmin` flag is retired in this rewrite.)

### 6.6 Identity
- The only supported identity mechanism is an authenticated NextAuth session (Google sign-in). There is no cookie-based fallback identity path.

## 7. Non-Functional Requirements

- **Data freshness**: enabled installs are rescanned on a recurring schedule (configurable per install); admins can force an immediate rescan.
- **Reliability**: the app must build and run successfully via Docker Compose before any further feature work is considered complete (matches existing project convention).
- **Responsiveness**: the calendar, list, and drawer UI must be usable on mobile viewport widths, not just desktop.
- **Accessibility**: interactive controls (tabs, filters, drawer) must be keyboard-operable and have appropriate ARIA roles/labels.
- **Security**: all admin surfaces are guarded server-side; all user-submitted content (comments) is validated and length-limited; secrets (OAuth credentials) are provided via environment variables, never committed.
- **Operability**: a health-check endpoint reports database readiness; scan run history gives admins visibility into crawler health.

## 8. Domain Glossary

| Term | Meaning |
|---|---|
| Profile package | Definition of a TCG integration (e.g., "Pokémon TCG") including how to discover releases for it. |
| Profile install | An enabled/disabled instance of a profile package that owns product sets for that TCG. |
| Product set | A specific set/expansion (e.g., a named booster set) under a profile install. |
| Release event | A dated occurrence for a product set (shelf release, prerelease, promo, special event). |
| Source claim | A single piece of evidence (from a specific source) supporting a release event's date/status. |
| Scan run | A single execution of the crawler against one or more installs. |
| Discovery hit | A raw fetched page/document recorded during a scan run, prior to parsing. |
| Subscription | A signed-in user's association to a profile install they want to follow. |

## 9. Future Expansion (Post-MVP Candidates)
- Notifications (email/push) for subscribed installs' upcoming releases.
- Advanced search/filter (date range picker, saved filters).
- Public read API for third-party consumption.
- Analytics dashboard (traffic, popular installs, crawler accuracy over time).
- Granular access control (moderator role distinct from full admin).
- Import/sync from user-provided calendars (ICS export/import).

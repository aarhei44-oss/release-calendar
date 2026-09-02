# Release Watcher — TCG Release Calendar

A self-hosted calendar of upcoming trading card game (TCG) product releases
(Pokémon, Magic: The Gathering, One Piece Card Game, and others), aggregated
from multiple external sources with source attribution and confidence
scoring.

See the design docs for the full picture:

- [functional-spec.md](./functional-spec.md) — goals, personas, scope, business rules
- [technical-spec.md](./technical-spec.md) — architecture, data model, API surface
- [implementation-plan.md](./implementation-plan.md) — phase-by-phase build plan

## Stack

Next.js (App Router) + TypeScript (strict) + Tailwind CSS, Prisma + SQLite,
NextAuth (Google sign-in), Zod validation, an in-app crawler subsystem for
automated release discovery. Deployed as a Docker Compose stack (app + Caddy
reverse proxy).

## Local development

```bash
npm install
cp .env.example .env   # fill in secrets
npx prisma migrate dev
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Production (Docker Compose)

```bash
cp .env.example .env   # fill in production secrets
docker compose up --build
```

`app` runs migrations on boot and serves the app; `caddy` terminates TLS and
reverse-proxies to `app`. The SQLite database file persists on the `db-data`
volume.

### Deploying to a small server (prebuilt image via CI)

Building this image (`npm ci` + `next build`) wants well over 1GB of RAM --
comfortably possible on a laptop or a beefy CI runner, but it'll OOM a
small (e.g. 1GB) droplet. `.github/workflows/docker-publish.yml` builds on
GitHub's runners and pushes to GHCR on every push to `main`; the server
then only ever pulls:

```bash
git pull                                          # get docker-compose.registry.yml + .env template
cp .env.example .env                              # fill in production secrets
docker compose -f docker-compose.registry.yml pull
docker compose -f docker-compose.registry.yml up -d
```

That compose file has no Caddy service -- pair it with whatever reverse
proxy/TLS setup the server already has (e.g. nginx with its own cert), or
run `caddy` separately alongside it.

The GHCR package needs to be set **Public** once (Settings on the
package's GitHub page) so the server can pull without authenticating.

#### Continuous deployment

`docker-publish.yml`'s `deploy` job SSHes into the server and runs
`/root/deploy.sh` (which does the `git pull` + `docker compose pull/up`
above) automatically after every successful build on `main`. It
authenticates with a `DEPLOY_SSH_KEY` repo secret -- a **dedicated** key,
not anyone's personal one, and the server restricts it via a `command=`
forced-command in `authorized_keys` so that key can only ever run that one
script, never an arbitrary shell, even if the secret were ever exposed.

To point this at a different server: generate a fresh `ssh-keygen -t
ed25519` pair, add `command="/root/deploy.sh",no-port-forwarding,
no-X11-forwarding,no-agent-forwarding,no-pty <public key>` as one line in
that server's `~/.ssh/authorized_keys`, put the private key in the
`DEPLOY_SSH_KEY` secret, and update the `host`/`username` in the `deploy`
job.

### Environment variables

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | SQLite file path, e.g. `file:./dev.db`. Set automatically inside the container. |
| `NEXTAUTH_URL` | yes | Public URL of the deployment (e.g. `https://calendar.example.com`). |
| `NEXTAUTH_SECRET` | yes | Random secret for session encryption -- generate with `openssl rand -base64 32`. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | yes | OAuth credentials from the Google Cloud Console (Google sign-in is the only auth method). |
| `ADMIN_EMAILS` | yes | Comma-separated emails granted the `ADMIN` role on first sign-in. |
| `CRAWLER_SCHEDULE` | no | Minutes between scheduled crawler scans. Unset or `0` disables the schedule (manual rescan from the admin System tab still works). |
| `SITE_ADDRESS` | Docker Compose only | Domain Caddy serves and requests a TLS cert for, e.g. `calendar.example.com`. Defaults to `localhost` (no TLS). |
| `SEED_ON_BOOT` | Docker Compose only | `true` runs `prisma db seed` on container boot (idempotent). |

### Health check

`GET /api/health` returns `{ "status": "ok", "database": "up" }` (200) when
the app can reach the database, or 503 with an error message otherwise.

### Backing up the database

The entire app's state lives in one SQLite file on the `db-data` volume
(`/app/data/prod.db` inside the container). To back it up:

```bash
# snapshot the volume to a local tarball
docker run --rm -v release-calendar_db-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/release-calendar-backup-$(date +%Y%m%d).tar.gz -C /data .
```

To restore, stop the stack, extract that tarball back into a fresh
`db-data` volume, then start the stack again. Because it's a single file,
a straight file copy (`docker cp app:/app/data/prod.db ./backup.db`) while
the app is stopped works too, and is simplest for periodic cron-driven
backups on the host.

## Testing

```bash
npm run test        # vitest (unit/integration)
npm run test:e2e     # playwright (smoke e2e)
```

## Design decisions

- **No generic "DB CRUD console".** technical-spec.md §5.2 calls for a
  decision on this (the prototype had one): this rewrite omits it entirely.
  The admin console (`/admin`) exposes purpose-built, `requireAdmin()`-gated
  actions for exactly what curators need -- toggling installs, managing
  users, triggering scans/dedup -- rather than an unguarded passthrough to
  arbitrary Prisma models.
- **Every Server Action lives in one `actions.ts` per feature**
  (`app/calendar/actions.ts`, `app/subscriptions/actions.ts`,
  `app/admin/actions.ts`). No feature has more than one actions file.

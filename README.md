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

## Testing

```bash
npm run test        # vitest (unit/integration)
npm run test:e2e     # playwright (smoke e2e)
```

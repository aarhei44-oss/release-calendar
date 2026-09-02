#!/bin/sh
set -e

echo "[entrypoint] running prisma migrations..."
npx prisma migrate deploy

if [ -n "$SEED_ON_BOOT" ] && [ "$SEED_ON_BOOT" = "true" ]; then
  echo "[entrypoint] seeding database..."
  npx prisma db seed || echo "[entrypoint] seed skipped/failed (non-fatal)"
fi

echo "[entrypoint] starting app..."
exec "$@"

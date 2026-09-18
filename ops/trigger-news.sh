#!/bin/sh
# News-feed fetch trigger, run via cron on the droplet (not part of the
# CI/CD deploy pipeline -- this and its cron entry live only on the host,
# same as trigger-ingest.sh). Calls the app's own POST /api/news/run
# (app/api/news/run/route.ts) rather than running any fetch logic itself.
set -e

ENV_FILE="/root/release-calendar/.env"
TOKEN=$(grep '^NEWS_TRIGGER_TOKEN=' "$ENV_FILE" | cut -d= -f2- | tr -d '"')

if [ -z "$TOKEN" ]; then
  echo "[trigger-news] $(date -u +%FT%TZ) NEWS_TRIGGER_TOKEN not set in $ENV_FILE, aborting" >&2
  exit 1
fi

# Fire-and-forget on the server side (202 Accepted); this just confirms the
# trigger itself was accepted, not that every source fetched cleanly -- see
# the admin System tab's "News sources" block for that.
HTTP_CODE=$(curl -s -o /tmp/trigger-news-response.json -w '%{http_code}' \
  -X POST http://localhost:3000/api/news/run \
  -H "Authorization: Bearer $TOKEN")

echo "[trigger-news] $(date -u +%FT%TZ) HTTP $HTTP_CODE $(cat /tmp/trigger-news-response.json)"

case "$HTTP_CODE" in
  2??) exit 0 ;;
  *) exit 1 ;;
esac

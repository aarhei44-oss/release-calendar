#!/bin/sh
# Daily v2 ingest trigger, run via cron on the droplet (not part of the
# CI/CD deploy pipeline -- this and its cron entry live only on the host).
# Calls the app's own POST /api/ingest/run (app/api/ingest/run/route.ts)
# rather than running any crawl logic itself -- see that route's doc comment
# for why an external cron hitting an HTTP endpoint replaced v1's in-process
# scheduler (lib/crawler/scheduler.ts, disabled via CRAWLER_SCHEDULE=0 once
# this took over): a `setTimeout` living inside the app process means a
# deploy or a crash near the scheduled time silently skips the run, and
# nobody finds out until the calendar goes stale. This outlives the app and
# a non-2xx here is something cron's own mailer can shout about.
set -e

ENV_FILE="/root/release-calendar/.env"
TOKEN=$(grep '^INGEST_TRIGGER_TOKEN=' "$ENV_FILE" | cut -d= -f2- | tr -d '"')

if [ -z "$TOKEN" ]; then
  echo "[trigger-ingest] $(date -u +%FT%TZ) INGEST_TRIGGER_TOKEN not set in $ENV_FILE, aborting" >&2
  exit 1
fi

# No installId in the body -- scopeType ALL, one run covering every enabled
# game from whatever each shared provider (tcgcsv, wikipedia) fetches once.
# Fire-and-forget on the server side (202 Accepted); this just confirms the
# trigger itself was accepted, not that the run succeeded -- see the admin
# System tab or ScanRun for that.
HTTP_CODE=$(curl -s -o /tmp/trigger-ingest-response.json -w '%{http_code}' \
  -X POST http://localhost:3000/api/ingest/run \
  -H "Authorization: Bearer $TOKEN")

echo "[trigger-ingest] $(date -u +%FT%TZ) HTTP $HTTP_CODE $(cat /tmp/trigger-ingest-response.json)"

case "$HTTP_CODE" in
  2??) exit 0 ;;
  *) exit 1 ;;
esac

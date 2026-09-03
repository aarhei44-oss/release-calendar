#!/bin/sh
# Daily production DB backup, run via cron on the droplet (not part of the
# CI/CD deploy pipeline -- this and its cron entry live only on the host).
# See README.md's "Backing up the database" section for the manual version
# this automates.
set -e

DB_PATH="/var/lib/docker/volumes/release-calendar_db-data/_data/prod.db"
BACKUP_DIR="/root/backups"
RETENTION_DAYS=14

mkdir -p "$BACKUP_DIR"

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
DEST="$BACKUP_DIR/prod-$TIMESTAMP.db"

# sqlite3's .backup command uses SQLite's own online backup API, which
# takes a consistent snapshot even while the app is actively writing to the
# database -- safe to run against the live file, no need to stop the app.
sqlite3 "$DB_PATH" ".backup '$DEST'"
gzip "$DEST"

# Prune backups older than the retention window so this doesn't grow
# unbounded.
find "$BACKUP_DIR" -name 'prod-*.db.gz' -mtime "+$RETENTION_DAYS" -delete

echo "[backup-db] $(date -u +%FT%TZ) backed up to ${DEST}.gz"

#!/usr/bin/env bash
set -euo pipefail
APP_DIR="${APP_DIR:-/root/streamflow-github}"
BACKUP_DIR="${BACKUP_DIR:-/root/streamflow-backups}"
mkdir -p "$BACKUP_DIR"
TS=$(date +%Y%m%d-%H%M%S)
OUT="$BACKUP_DIR/streamflow-data-$TS.tar.gz"
cd "$APP_DIR"
tar -czf "$OUT" \
  .env \
  db/streamflow.db \
  db/sessions.db \
  public/uploads \
  logs 2>/dev/null || tar -czf "$OUT" .env db public/uploads

echo "$OUT"

#!/usr/bin/env bash
set -euo pipefail
APP_DIR="${APP_DIR:-/root/streamflow-github}"
BACKUP_FILE="${1:-}"
DOMAIN_OR_IP="${2:-${DOMAIN_OR_IP:-}}"

if [ -z "$BACKUP_FILE" ] || [ ! -f "$BACKUP_FILE" ]; then
  echo "Usage: $0 /path/streamflow-data-YYYYmmdd-HHMMSS.tar.gz [domain-or-ip]"
  exit 1
fi

systemctl stop streamflow.service || true
mkdir -p "$APP_DIR"
tar -xzf "$BACKUP_FILE" -C "$APP_DIR"

if [ -n "$DOMAIN_OR_IP" ]; then
  if [[ "$DOMAIN_OR_IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    DOMAIN="${DOMAIN_OR_IP}.nip.io"
  else
    DOMAIN="$DOMAIN_OR_IP"
  fi
  if [ -f "$APP_DIR/.env" ]; then
    if grep -q '^BASE_URL=' "$APP_DIR/.env"; then
      sed -i "s|^BASE_URL=.*|BASE_URL=https://${DOMAIN}|" "$APP_DIR/.env"
    else
      echo "BASE_URL=https://${DOMAIN}" >> "$APP_DIR/.env"
    fi
  fi
fi

systemctl start streamflow.service
systemctl restart caddy || true
systemctl is-active streamflow.service

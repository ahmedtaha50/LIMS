#!/usr/bin/env bash
# Backup of the EBR database: a custom-format dump with its SHA-256 next to it.
#   DATABASE_URL=postgres://... deploy/backup/backup.sh /backups
# Restore and verify: deploy/backup/restore.sh <dump> <new database url>
set -euo pipefail
dir="${1:?usage: backup.sh <backup folder>}"
: "${DATABASE_URL:?set DATABASE_URL}"
mkdir -p "$dir"
file="$dir/ebr-$(date -u +%Y%m%dT%H%M%SZ).dump"
pg_dump --format=custom --no-owner --no-privileges --file="$file" "$DATABASE_URL"
sha256sum "$file" | awk '{print $1}' > "$file.sha256"
echo "backup written: $file ($(stat -c %s "$file") bytes, sha256 $(cat "$file.sha256"))"

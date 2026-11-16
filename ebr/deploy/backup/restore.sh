#!/usr/bin/env bash
# Restores a backup into an EMPTY database and verifies it: the file's SHA-256, then the audit chain of the restored data.
#   deploy/backup/restore.sh /backups/ebr-....dump postgres://user:pw@host:5432/ebr_restored
# The restore runs in ONE transaction: it is complete or nothing. A dump written by newer client tools than the server
# (pg_dump 17 or 18 against PostgreSQL 16) carries session settings the server does not know (transaction_timeout); those
# lines only, and nothing else, are left out. The audit chain verification uses the built application (npm run build).
set -euo pipefail
file="${1:?usage: restore.sh <dump> <database url>}"; target="${2:?usage: restore.sh <dump> <database url>}"
if [ -f "$file.sha256" ]; then
  [ "$(sha256sum "$file" | awk '{print $1}')" = "$(cat "$file.sha256")" ] || { echo "the backup file does not match its SHA-256: not restored"; exit 1; }
fi
pg_restore --no-owner --no-privileges --file=- "$file" \
  | grep -v -E '^SET transaction_timeout = ' \
  | psql --quiet --no-psqlrc -v ON_ERROR_STOP=1 --single-transaction --dbname="$target" >/dev/null
here="$(cd "$(dirname "$0")/../.." && pwd)"
DATABASE_URL="$target" node --input-type=module -e "
  const { createPool } = await import('$here/dist/server/core/db.js');
  const { verifyChain } = await import('$here/dist/server/audit/index.js');
  const pool = createPool(process.env.DATABASE_URL, 2);
  const r = await verifyChain(pool); await pool.end();
  console.log('audit chain of the restored database: ' + JSON.stringify(r));
  process.exit(r.ok ? 0 : 1);"

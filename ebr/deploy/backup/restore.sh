#!/usr/bin/env bash
# Restores a backup into an EMPTY database and verifies it: the file's SHA-256, then the audit chain of the restored data.
#   deploy/backup/restore.sh /backups/ebr-....dump postgres://user:pw@host:5432/ebr_restored
# The audit chain verification uses the built application (npm run build): it must report ok, or the restore is not usable.
set -euo pipefail
file="${1:?usage: restore.sh <dump> <database url>}"; target="${2:?usage: restore.sh <dump> <database url>}"
if [ -f "$file.sha256" ]; then
  [ "$(sha256sum "$file" | awk '{print $1}')" = "$(cat "$file.sha256")" ] || { echo "the backup file does not match its SHA-256: not restored"; exit 1; }
fi
pg_restore --no-owner --no-privileges --exit-on-error --dbname="$target" "$file"
here="$(cd "$(dirname "$0")/../.." && pwd)"
DATABASE_URL="$target" node --input-type=module -e "
  const { createPool } = await import('$here/dist/server/core/db.js');
  const { verifyChain } = await import('$here/dist/server/audit/index.js');
  const pool = createPool(process.env.DATABASE_URL, 2);
  const r = await verifyChain(pool); await pool.end();
  console.log('audit chain of the restored database: ' + JSON.stringify(r));
  process.exit(r.ok ? 0 : 1);"

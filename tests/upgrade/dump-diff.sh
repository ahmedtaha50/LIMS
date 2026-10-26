#!/usr/bin/env bash
# Roadmap M04: "CI diffs the pg_dump of a fresh install against an upgraded one."
# A database installed fresh from drizzle/*.sql and a v0.1.0 installation (tests/upgrade/fixtures) upgraded by the same runner must have
# the same schema: tables, columns in the same order, defaults, constraints, indexes, functions and triggers, and the same journal checksums.
# Needs PostgreSQL client tools (psql, pg_dump) and a role that may CREATE DATABASE. Usage: tests/upgrade/dump-diff.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
export SQL_HOST=${SQL_HOST:-127.0.0.1} SQL_USER=${SQL_USER:-lims} SQL_PASSWORD=${SQL_PASSWORD:-lims}
export PGPASSWORD=$SQL_PASSWORD
PREFIX=${DUMPDIFF_DB_PREFIX:-lims_dumpdiff}_$$
FRESH=${PREFIX}_fresh; UPGRADED=${PREFIX}_upgraded
WORK=$(mktemp -d)
pg() { local db=$1; shift; PGOPTIONS='-c client_min_messages=warning' psql -h "$SQL_HOST" -U "$SQL_USER" -d "$db" -v ON_ERROR_STOP=1 -q "$@"; }
cleanup() { pg postgres -c "drop database if exists $FRESH" -c "drop database if exists $UPGRADED" >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

pg postgres -c "create database $FRESH" -c "create database $UPGRADED"

echo "== fresh install"
SQL_DB_NAME=$FRESH npx tsx src/server/boot/migrate-cli.ts migrate >/dev/null

echo "== v0.1.0 installation upgraded"
for f in v0.1.0.schema.sql v0.1.0.protections.sql v0.1.0.data.sql; do pg "$UPGRADED" -o /dev/null -f "tests/upgrade/fixtures/$f"; done
SQL_DB_NAME=$UPGRADED MIGRATION_BACKUP_PASSPHRASE=dump-diff-passphrase BACKUP_DIR="$WORK/backups" npx tsx src/server/boot/migrate-cli.ts migrate >/dev/null

dump() { pg_dump -h "$SQL_HOST" -U "$SQL_USER" --schema-only --no-owner --no-privileges "$1" | grep -v -E '^(\\restrict|\\unrestrict|--)' | cat -s; }
dump "$FRESH" > "$WORK/fresh.sql"
dump "$UPGRADED" > "$WORK/upgraded.sql"
journal() { pg "$1" -Atc "select id, sha256 from schema_migrations order by id"; }
journal "$FRESH" > "$WORK/fresh.journal"
journal "$UPGRADED" > "$WORK/upgraded.journal"

status=0
diff -u "$WORK/fresh.sql" "$WORK/upgraded.sql" || status=1
diff -u "$WORK/fresh.journal" "$WORK/upgraded.journal" || status=1
if [ $status -eq 0 ]; then echo "PASS fresh install and upgraded v0.1.0 installation have identical schema ($(wc -l < "$WORK/fresh.sql") lines of pg_dump) and journal"; else echo "FAIL schemas differ"; fi
exit $status

#!/usr/bin/env bash
# OQ-09: backup, verification and restore (URS-050). Needs running server + dist-server/backup-cli.cjs (npm run build) + a DB role that may CREATE DATABASE.
BASE=${BASE:-http://localhost:3000/api}; fail=0; J='content-type: application/json'
export SQL_HOST=${SQL_HOST:-127.0.0.1} SQL_USER=${SQL_USER:-lims} SQL_PASSWORD=${SQL_PASSWORD:-lims} SQL_DB_NAME=${SQL_DB_NAME:-lims}
export BACKUP_DIR=${BACKUP_DIR:-/tmp/bplims-backups-$$} BACKUP_PASSPHRASE='correct horse battery'; rm -rf "$BACKUP_DIR"
expect(){ [ "$2" = "$3" ] && echo "PASS $1" || { echo "FAIL $1 (got $2, want $3)"; fail=1; }; }
tok(){ curl -s -X POST $BASE/auth/login-local -H "$J" -d "{\"email\":\"$1\",\"password\":\"password\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])'; }
ADM=$(tok admin@gxp.com); QA=$(tok qa@gxp.com)
api(){ curl -s -o /tmp/bk-resp.json -w '%{http_code}' -X POST $BASE/admin/backup -H "Authorization: Bearer $1" -H "$J" -d "$2"; }
expect OQ09-backup-non-admin-refused "$(api $QA '{"password":"password","passphrase":"correct horse battery"}')" 403
expect OQ09-backup-wrong-password-refused "$(api $ADM '{"password":"nope","passphrase":"correct horse battery"}')" 401
expect OQ09-backup-short-passphrase-refused "$(api $ADM '{"password":"password","passphrase":"short"}')" 400
expect OQ09-backup-created-and-self-verified "$(api $ADM '{"password":"password","passphrase":"correct horse battery"}')" 200
cd "$(dirname "$0")/.."
SBD=${SERVER_BACKUP_DIR:-$PWD/backups}   # directory the SERVER writes to (BACKUP_DIR of the server process)
mkdir -p "$BACKUP_DIR"
F=$SBD/$(python3 -c 'import json;print(json.load(open("/tmp/bk-resp.json"))["file"])')
expect OQ09-backup-is-v2-stream-format "$(head -c 9 "$F")" BPLIMSBK2
expect OQ09-backup-run-recorded-append-only "$(PGPASSWORD=$SQL_PASSWORD psql -h $SQL_HOST -U $SQL_USER $SQL_DB_NAME -Atc "select count(*) from backup_runs where file_name='$(basename "$F")' and status='ok' and verified and kind='manual'")" 1
expect OQ09-status-reports-last-good-backup "$(curl -s $BASE/admin/backup/status -H "Authorization: Bearer $ADM" | python3 -c 'import sys,json;print(json.load(sys.stdin)["lastSuccessfulBackupAt"] is not None)')" True
expect OQ09-backup-event-in-audit-trail "$(PGPASSWORD=$SQL_PASSWORD psql -h $SQL_HOST -U $SQL_USER $SQL_DB_NAME -Atc "select count(*)>0 from audit_trail where action='BACKUP_CREATED'")" t
expect OQ09-verify-ok "$(BACKUP_FILE=$F node dist-server/backup-cli.cjs verify | python3 -c 'import sys,json;print(json.load(sys.stdin)["ok"])')" True
BACKUP_PASSPHRASE=wrong-passphrase-xx BACKUP_FILE=$F node dist-server/backup-cli.cjs verify >/dev/null 2>&1; expect OQ09-wrong-passphrase-refused $? 1
cp $F $BACKUP_DIR/t.bak; printf '\x00' | dd of=$BACKUP_DIR/t.bak bs=1 seek=100 conv=notrunc 2>/dev/null
BACKUP_FILE=$BACKUP_DIR/t.bak node dist-server/backup-cli.cjs verify >/dev/null 2>&1; expect OQ09-tampered-file-refused $? 1
expect OQ09-tampered-frame-is-named "$(BACKUP_FILE=$BACKUP_DIR/t.bak node dist-server/backup-cli.cjs verify 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin)["corruptFrame"])')" 0
RDB=lims_restore_$$; PGPASSWORD=$SQL_PASSWORD psql -h $SQL_HOST -U $SQL_USER postgres -qc "create database $RDB" || fail=1
R=$(RESTORE_DB_NAME=$RDB BACKUP_FILE=$F node dist-server/backup-cli.cjs restore 2>/dev/null)
expect OQ09-restore-counts-match "$(echo "$R" | python3 -c 'import sys,json;print(json.load(sys.stdin)["countsMatch"])')" True
expect OQ09-restore-audit-chain-intact "$(echo "$R" | python3 -c 'import sys,json;print(json.load(sys.stdin)["chainIntact"])')" True
expect OQ09-restore-every-table-and-timestamp-identical "$(echo "$R" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["hashesMatch"] and d["timestampsMatch"])')" True
# The restored database carries exactly the append-only triggers of the source database (audit_trail, audit_checkpoints, security_events, signatures: 8 since audit v2; at least 4 whatever else is added).
GXP_SRC=$(PGPASSWORD=$SQL_PASSWORD psql -h $SQL_HOST -U $SQL_USER $SQL_DB_NAME -Atc "select count(*) from pg_trigger where tgname like 'gxp_%'")
expect OQ09-source-db-has-immutability-triggers "$([ "$GXP_SRC" -ge 4 ] && echo yes || echo "no ($GXP_SRC)")" yes
expect OQ09-restored-db-has-immutability-triggers "$(PGPASSWORD=$SQL_PASSWORD psql -h $SQL_HOST -U $SQL_USER $RDB -Atc "select count(*) from pg_trigger where tgname like 'gxp_%'")" "$GXP_SRC"
RESTORE_DB_NAME=$RDB BACKUP_FILE=$F node dist-server/backup-cli.cjs restore >/dev/null 2>&1; expect OQ09-restore-never-overwrites-nonempty-db $? 1
PGPASSWORD=$SQL_PASSWORD psql -h $SQL_HOST -U $SQL_USER postgres -qc "drop database $RDB"
exit $fail

#!/usr/bin/env bash
# Re-collect the execution evidence of the validation package. Run from the repository root, after `npm run build`.
#
#   BASE=http://127.0.0.1:3000/api SQL_DB_NAME=lims validation/build/collect-evidence.sh
#
# Needs: a running, freshly seeded server for the shell OQ at BASE (the checks change data and expect the demo set), PostgreSQL access
# (a role that can create databases), xvfb for the desktop shell and upgrade runs, and Chromium + Playwright for the browser flows. Steps that cannot
# run are skipped only when named in SKIP (SKIP="vitest e2e desktop"); a skipped step leaves the older evidence file in place, and the RTM
# then shows the date of that file, never a result that was not obtained.
#
# Writes validation/evidence/{oq-run,backup-run,junit,e2e-run,desktop-run,iq-sandbox}-<date>.{txt,xml}, then `node validation/build/check.cjs`
# tells whether every Critical or High requirement is covered by a passed test. Rebuild the documents with `node validation/build/build.cjs`.
set -u; D=$(date -u +%F); E=validation/evidence; mkdir -p $E
export SQL_HOST=${SQL_HOST:-127.0.0.1} SQL_USER=${SQL_USER:-lims} SQL_PASSWORD=${SQL_PASSWORD:-lims} SQL_DB_NAME=${SQL_DB_NAME:-lims}
skip() { case " ${SKIP:-} " in *" $1 "*) return 0;; esac; return 1; }

if ! skip shell; then
  tests/security-controls.sh > $E/oq-run-$D.txt 2>&1; tests/backup-restore.sh > $E/backup-run-$D.txt 2>&1
fi
if ! skip vitest; then
  # JWT_SECRET and LIMS_MASTER_KEY must be unset: the suite sets what it needs
  env -u JWT_SECRET -u LIMS_MASTER_KEY npx vitest run --reporter=default --reporter=junit --outputFile.junit=$E/junit-$D.xml > $E/vitest-$D.log 2>&1
  tail -6 $E/vitest-$D.log
fi
if ! skip e2e; then
  node tests/e2e/run.cjs --out $E/e2e-run-$D.txt | tail -3
fi
if ! skip desktop; then
  # Electron under xvfb; each script prints "PASS <text>" lines. tests/desktop-smoke.cjs is not used: it does not supply the first administrator
  # that the first-run screen now requires and stops there (DEV-2026-10-25-08).
  : > $E/desktop-run-$D.txt
  for script in desktop-shell desktop-upgrade desktop-embedded; do
    timeout 300 xvfb-run -a node tests/$script.cjs 2>&1 | sed -n "s/^\(PASS\|FAIL\) \(.*\)$/\1 $script \2/p" >> $E/desktop-run-$D.txt
  done
  # node:test checks of the installer and release integrity (release R3): one "PASS|FAIL <name> <title>" line per test
  for f in tests/installer/*.test.cjs; do b=$(basename $f .test.cjs)
    node --test --test-reporter=tap $f 2>&1 | sed -n "s/^\(ok\|not ok\) [0-9]* - \(.*\)$/\1 $b \2/p" | sed 's/^ok /PASS /; s/^not ok /FAIL /' >> $E/desktop-run-$D.txt
  done
  grep -c '^PASS' $E/desktop-run-$D.txt; grep '^FAIL' $E/desktop-run-$D.txt
fi
{ echo "# IQ evidence $(date -u +%FT%TZ) - development sandbox, NOT the target PC"; echo "node $(node -v)"; echo "electron $(node -p "require('./node_modules/electron/package.json').version")"; echo "os $(uname -sr)"; echo "postgres $(psql --version)"
  P="env PGPASSWORD=$SQL_PASSWORD psql -h $SQL_HOST -U $SQL_USER -Atc"
  echo "tables $($P "select count(*) from information_schema.tables where table_schema='public'" $SQL_DB_NAME)"; echo "triggers $($P "select count(*) from pg_trigger where tgname like 'gxp_%'" $SQL_DB_NAME)"
  echo "migrations $($P "select count(*) from schema_migrations" $SQL_DB_NAME) (last $($P "select id from schema_migrations order by id desc limit 1" $SQL_DB_NAME))"
  sha256sum dist-server/server.cjs dist-server/init-db.cjs dist-server/backup-cli.cjs desktop/main.cjs desktop/preload.cjs desktop/schema.sql; echo "git $(git rev-parse HEAD)"; } > $E/iq-sandbox-$D.txt
grep -h -c FAIL $E/oq-run-$D.txt $E/backup-run-$D.txt
node validation/build/check.cjs

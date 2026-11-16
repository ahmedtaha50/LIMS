#!/usr/bin/env bash
# Collects the execution evidence of the validation package into validation/evidence/, dated and tied to the git commit.
#   bash validation/build/collect-evidence.sh            (from ebr/, PostgreSQL reachable as for npm test)
#   SKIP_PERF=1 bash validation/build/collect-evidence.sh  keeps the newest capacity result instead of running it again (2-3 min)
# Nothing in the package is typed as a result: every result is read from these files by results.cjs.
# Each file is the output of a run made by this script on THIS machine (a development sandbox, not the plant's server).
set -uo pipefail
cd "$(dirname "$0")/../.."
E=validation/evidence; D=$(date -u +%Y-%m-%d); mkdir -p $E
sha=$(git rev-parse HEAD); dirty=$(git status --porcelain -- . ':!validation/evidence' ':!validation/docs' | wc -l)

echo "== build (the browser tests and the IQ hashes use the built application)"
npm run build >/dev/null || { echo "build failed"; exit 1; }

echo "== whole suite on a fresh PostgreSQL database (Vitest JUnit)"
npx vitest run --reporter=default --reporter=junit --outputFile.junit=$E/junit-$D.xml | tail -4

echo "== browser tests of the built application, tablet and desktop (Playwright JUnit)"
PLAYWRIGHT_JUNIT_OUTPUT_NAME=$E/e2e-$D.xml npx playwright test --reporter=line,junit --trace off | tail -3

if [ -z "${SKIP_PERF:-}" ]; then
  echo "== capacity: 300 users, two instances behind a proxy, one stopped halfway"
  npm run test:perf >/dev/null 2>&1; cp tests/perf/results.json $E/perf-$D.json
elif ! ls $E/perf-*.json >/dev/null 2>&1; then cp tests/perf/results.json $E/perf-$D.json; fi

echo "== IQ record of this sandbox"
{ echo "# IQ evidence $(date -u +%FT%TZ): development sandbox, NOT the plant's server"
  echo "git $sha$([ "$dirty" -gt 0 ] && echo " (+$dirty uncommitted change(s))")"
  echo "node $(node -v)"; echo "os $(uname -sr)"; echo "postgres-client $(psql --version | awk '{print $3}')"
  echo "postgres-server $(psql "${TEST_ADMIN_URL:-postgres://ebr:ebr@127.0.0.1:5432/postgres}" -Atc 'show server_version' 2>/dev/null || echo unknown)"
  echo "migrations $(ls migrations/*.sql | wc -l) (last $(ls migrations/*.sql | sort | tail -1 | xargs basename))"
  echo "routes $(node -e "console.log(require('./tests/route-table.json').length)" 2>/dev/null || echo unknown)"
  (cd dist && find server -name '*.js' | sort | xargs sha256sum | sha256sum | awk '{print "sha256-of-server-build " $1}')
  (cd dist && find client -type f | sort | xargs sha256sum | sha256sum | awk '{print "sha256-of-client-build " $1}')
  sha256sum package-lock.json | awk '{print "sha256-package-lock " $1}'
} > $E/iq-sandbox-$D.txt
cat $E/iq-sandbox-$D.txt

echo "== traceability gate"
node validation/build/check.cjs

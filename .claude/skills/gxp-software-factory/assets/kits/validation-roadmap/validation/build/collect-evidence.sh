#!/usr/bin/env bash
# Collects the execution evidence of the validation package into validation/evidence/, dated and tied to the git commit.
# (kit validation-roadmap of the gxp-software-factory skill; proven on the EBR project.)
#   bash validation/build/collect-evidence.sh            from the project folder, with the test database reachable
#   SKIP_PERF=1 bash validation/build/collect-evidence.sh  keeps the newest capacity result instead of running it again
# Nothing in the package is typed as a result: every result is read from these files by results.cjs.
# CHANGE IN A NEW PROJECT: the build, test, browser and capacity commands; the facts of the IQ record.
set -uo pipefail
cd "$(dirname "$0")/../.."
E=validation/evidence; D=$(date -u +%Y-%m-%d); mkdir -p $E
sha=$(git rev-parse HEAD); dirty=$(git status --porcelain -- . ':!validation/evidence' ':!validation/docs' | wc -l)

echo "== build (the browser tests and the IQ hashes use the built application)"
npm run build >/dev/null || { echo "build failed"; exit 1; }

echo "== whole suite on a fresh database (Vitest JUnit; classname = the test file)"
npx vitest run --reporter=default --reporter=junit --outputFile.junit=$E/junit-$D.xml | tail -4

if [ -f playwright.config.ts ] || [ -f playwright.config.js ]; then
  echo "== browser tests of the built application (Playwright JUnit)"
  PLAYWRIGHT_JUNIT_OUTPUT_NAME=$E/e2e-$D.xml npx playwright test --reporter=line,junit --trace off | tail -3
fi

if [ -z "${SKIP_PERF:-}" ] && npm run | grep -q '^  test:perf$'; then
  echo "== capacity test"
  npm run test:perf >/dev/null 2>&1; [ -f tests/perf/results.json ] && cp tests/perf/results.json $E/perf-$D.json
fi

echo "== IQ record of this machine"
{ echo "# IQ evidence $(date -u +%FT%TZ): $(hostname), a development machine unless stated otherwise"
  echo "git $sha$([ "$dirty" -gt 0 ] && echo " (+$dirty uncommitted change(s))")"
  echo "node $(node -v)"; echo "os $(uname -sr)"
  [ -d dist ] && (cd dist && find . -type f | sort | xargs sha256sum | sha256sum | awk '{print "sha256-of-build " $1}')
  [ -f package-lock.json ] && sha256sum package-lock.json | awk '{print "sha256-package-lock " $1}'
} > $E/iq-$D.txt
cat $E/iq-$D.txt

echo "== traceability gate"
node validation/build/check.cjs

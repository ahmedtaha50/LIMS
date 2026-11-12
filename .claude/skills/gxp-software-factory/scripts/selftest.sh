#!/usr/bin/env bash
# Proves the tools of this skill work on this machine (Node 18+). Run it after installing or editing the skill.
set -u; cd "$(dirname "$0")"; fail=0
ok(){ if [ "$2" = "$3" ]; then echo "PASS $1"; else echo "FAIL $1 (got $2, want $3)"; fail=1; fi; }
node roadmap-lint.cjs ../assets/examples/roadmap.example.json >/dev/null 2>&1; ok "roadmap-lint accepts the example roadmap" $? 0
node roadmap-lint.cjs fixtures/roadmap.broken.json >/dev/null 2>&1; ok "roadmap-lint refuses the broken roadmap" $? 1
ok "roadmap-lint finds all 6 planted errors" "$(node roadmap-lint.cjs fixtures/roadmap.broken.json --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).errors.length))')" 6
T=$(mktemp -d)
echo '{"track":"a","status":"complete","done":["x"],"notDone":[],"filesChanged":[],"testsAdded":[],"testEvidence":"npm test: 12 passed, 0 failed","decisionsForUser":[],"needsFromOtherTracks":[]}' > $T/report-a.json
node reports-digest.cjs $T --expect a >/dev/null 2>&1; ok "reports-digest: all reports in" $? 0
node reports-digest.cjs $T --expect a,b >/dev/null 2>&1; ok "reports-digest: a missing report stops the gate" $? 2
v(){ printf '%b' "$1" | node ci-log-digest.cjs - --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s)[0].verdict))'; }
ok "ci-log-digest: empty log" "$(v '')" NEVER_STARTED
ok "ci-log-digest: download 504" "$(v '##[group]Run build\n  x cannot resolve https://example.com/a.zip: status code 504\n##[error]Process completed with exit code 1.\n')" INFRA_DOWNLOAD
ok "ci-log-digest: failing test" "$(v '##[group]Run npm test\nnot ok 2 - saves the record\n# pass 5\n# fail 1\n##[error]Process completed with exit code 1.\n')" TEST_FAILURE
ok "ci-log-digest: green suite, unhandled error" "$(v '##[group]Run npm test\nUnhandled Error\n Tests  20 passed (20)\n Errors  1 error\n##[error]Process completed with exit code 1.\n')" UNHANDLED_AFTER_GREEN
ok "ci-log-digest: timeout" "$(v "##[group]Run smoke\nstarting\n##[error]The action 'Smoke' has timed out after 8 minutes.\n")" TIMEOUT
ok "ci-log-digest: clean log" "$(v '##[group]Run npm test\nok\n')" OK
printf 'a\nb\n' | node ratchet.cjs --baseline $T/b.json --update --allow-grow --reason first >/dev/null 2>&1; ok "ratchet: first baseline" $? 0
printf 'a\nb\n' | node ratchet.cjs --baseline $T/b.json >/dev/null 2>&1; ok "ratchet: nothing new" $? 0
printf 'a\nb\nc\n' | node ratchet.cjs --baseline $T/b.json >/dev/null 2>&1; ok "ratchet: a new finding fails" $? 1
printf 'a\nb\nc\n' | node ratchet.cjs --baseline $T/b.json --update >/dev/null 2>&1; ok "ratchet: the baseline cannot grow silently" $? 1
printf 'a\n' | node ratchet.cjs --baseline $T/b.json --strict-stale >/dev/null 2>&1; ok "ratchet: a stale entry fails in strict mode" $? 1
M=$(mktemp -d); mkdir -p $M/src; echo '{"dependencies":{"express":"1","zod":"1"}}' > $M/package.json; echo "import express from 'express'; import { z } from 'zod';" > $M/src/a.ts
printf 'Stack: Express, Zod.\n' > $M/AGENTS.md; node manual-check.cjs --repo $M >/dev/null 2>&1; ok "manual-check: a manual that matches the code" $? 0
printf 'Stack: Express, Zod, Firebase Auth, RabbitMQ.\n' > $M/AGENTS.md; node manual-check.cjs --repo $M >/dev/null 2>&1; ok "manual-check: a manual naming what is not installed" $? 1
rm -rf $M
rm -rf $T; [ $fail = 0 ] && echo "selftest OK" || echo "selftest FAILED"; exit $fail

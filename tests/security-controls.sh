#!/usr/bin/env bash
# Black-box checks that the GX-xx controls actually refuse (see docs/gxp-audit-findings.csv).
# Requires a running, seeded server (BASE defaults to http://localhost:3000/api).
BASE=${BASE:-http://localhost:3000/api}; fail=0
J='content-type: application/json'
code(){ curl -s -o /dev/null -w '%{http_code}' "$@"; }
expect(){ [ "$2" = "$3" ] && echo "PASS $1" || { echo "FAIL $1 (got $2, want $3)"; fail=1; }; }
login(){ curl -s -X POST $BASE/auth/login-local -H "$J" -d "{\"email\":\"$1\",\"password\":\"password\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("token",""))'; }

expect GX-02-register-demo-gone "$(code -X POST $BASE/auth/register-demo -H "$J" -d '{"uid":"x","email":"x@x","name":"x","role":"Admin"}')" 404
expect GX-03-unknown-user-rejected "$(code -X POST $BASE/auth/login-local -H "$J" -d '{"email":"nobody@evil.com","password":"x"}')" 401

# GX-01: a token signed with the old hardcoded secret must no longer verify
FORGED=$(python3 -c "
import hmac,hashlib,base64,json
b=lambda d:base64.urlsafe_b64encode(d).rstrip(b'=')
h=b(json.dumps({'alg':'HS256','typ':'JWT'}).encode());p=b(json.dumps({'id':'usr-admin'}).encode())
print((h+b'.'+p+b'.'+b(hmac.new(b'super-secret-gxp-jwt-key-2026',h+b'.'+p,hashlib.sha256).digest())).decode())")
expect GX-01-old-secret-token-rejected "$(code $BASE/samples -H "Authorization: Bearer $FORGED")" 401

AN=$(login analyst1@gxp.com); QA=$(login qa@gxp.com)
expect GX-06-analyst-cannot-read-audit "$(code $BASE/audit -H "Authorization: Bearer $AN")" 403
expect GX-06-qa-can-read-audit "$(code $BASE/audit -H "Authorization: Bearer $QA")" 200
# GX-05: an Approved sample cannot be moved back to Testing
expect GX-05-invalid-transition-refused "$(code -X POST $BASE/samples/SMP-2026-00001/transition -H "Authorization: Bearer $QA" -H "$J" -d '{"action":"submit","expectedVersion":2}')" 400

# --- Signed workflow end to end: GX-04/05/07/08 -------------------------------------------------
SQL(){ PGPASSWORD=${SQL_PASSWORD:-lims} psql -h ${SQL_HOST:-127.0.0.1} -U ${SQL_USER:-lims} ${SQL_DB_NAME:-lims} -Atc "$1" 2>&1; }
RV=$(login reviewer@gxp.com)
# M29 (r2-custody-labels): testing starts only on a received sample, so each sample created below is received first
recv(){ curl -s -o /dev/null -X POST "$BASE/custody/samples/$1/receipt" -H "Authorization: Bearer $AN" -H "$J" -d '{"condition":"Intact","sealIntact":true,"requiredStorage":"Ambient","quantity":100,"unit":"g"}'; }
post(){ curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/samples/$1/transition" -H "Authorization: Bearer $2" -H "$J" -d "$3"; }
SID=$(curl -s -X POST $BASE/samples -H "Authorization: Bearer $AN" -H "$J" -d "{\"material\":\"Paracetamol 500mg Finished Tablets\",\"batch\":\"B-$RANDOM\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
recv $SID
ver(){ SQL "select version from samples where id='$SID'"; }
# M10 (r1-results-oos): review needs every result entered, while the sample is in Testing, by an Analyst or Admin. fill <sample> <token>
# enters each result at the middle of its limits (in specification).
fill(){ for row in $(SQL "select id||'|'||version||'|'||round(((coalesce(spec_min,0)+coalesce(spec_max,0))/2)::numeric,4) from results where sample_id='$1'"); do
  IFS='|' read -r rid rv val <<< "$row"
  curl -s -o /dev/null -X PUT "$BASE/samples/$1/results/$rid" -H "Authorization: Bearer $2" -H "$J" -d "{\"value\":\"$val\",\"reason\":\"routine entry\",\"expectedVersion\":$rv}"
done; }
expect GX-05-analyst-cannot-skip-to-approve "$(post $SID $AN "{\"action\":\"approve\",\"expectedVersion\":$(ver),\"password\":\"password\"}")" 400
expect workflow-start "$(post $SID $AN "{\"action\":\"submit\",\"expectedVersion\":$(ver)}")" 200
fill $SID $AN
expect GX-04-bad-password-refused "$(post $SID $AN "{\"action\":\"review\",\"expectedVersion\":$(ver),\"password\":\"wrong\"}")" 401
expect GX-04-failure-audited-and-persisted "$(SQL "select count(*)>0 from audit_trail where action='SignatureFailed' and entity_id='$SID'")" t
expect GX-04-counter-persisted "$(SQL "select failed_attempts>0 from users where id='usr-analyst1'")" t
SQL "update users set failed_attempts=0, locked_at=null where id='usr-analyst1'" >/dev/null
expect sign-review "$(post $SID $AN "{\"action\":\"review\",\"expectedVersion\":$(ver),\"password\":\"password\"}")" 200
expect GX-05-wrong-role-cannot-approve "$(post $SID $AN "{\"action\":\"approve\",\"expectedVersion\":$(ver),\"password\":\"password\"}")" 400
expect sign-approve "$(post $SID $RV "{\"action\":\"approve\",\"expectedVersion\":$(ver),\"password\":\"password\",\"reason\":\"ok\"}")" 200
for sig in $(SQL "select id from signatures where sample_id='$SID'"); do
  expect GX-08-signature-verifies "$(curl -s -H "Authorization: Bearer $QA" $BASE/signatures/verify/$sig | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["valid"] and d["contentHashMatches"])')" True
done
expect GX-07-audit-head-reported "$(curl -s -H "Authorization: Bearer $QA" $BASE/audit/head | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["sequence"]>0 and len(d["hash"])==64)')" True
expect GX-09-audit-update-refused "$(SQL "update audit_trail set reason='tamper' where sequence=1" | grep -c 'not permitted')" 1
expect GX-09-audit-delete-refused "$(SQL "delete from audit_trail" | grep -c 'not permitted')" 1
expect GX-09-signature-delete-refused "$(SQL "delete from signatures" | grep -c 'not permitted')" 1
expect GX-09-truncate-refused "$(SQL "truncate audit_trail" | grep -c 'not permitted')" 1
expect GX-11-new-hash-has-per-user-salt "$(cd "$(dirname "$0")/.." && npx tsx -e "import {generatePasswordHash as g} from './src/db/utils'; const a=g('x'),b=g('x'); console.log(a.startsWith('scrypt\$')&&a!==b)" 2>/dev/null | tail -1)" true

# --- Additional OQ checks ---------------------------------------------------------------------
expect URS-AUTH-unauthenticated-request-refused "$(code $BASE/samples)" 401
expect URS-VAL-strict-schema-rejects-server-field "$(curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/samples -H "Authorization: Bearer $AN" -H "$J" -d '{"material":"Paracetamol 500mg Finished Tablets","batch":"X1","state":"Approved"}')" 400
SID2=$(curl -s -X POST $BASE/samples -H "Authorization: Bearer $AN" -H "$J" -d "{\"material\":\"Paracetamol 500mg Finished Tablets\",\"batch\":\"B-$RANDOM\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
recv $SID2
expect URS-CONC-stale-version-rejected "$(post $SID2 $AN '{"action":"submit","expectedVersion":99}')" 409
# training guardrail: a user without completed training cannot sign
SQL "update users set has_completed_software_training=false where id='usr-analyst1'" >/dev/null
post $SID2 $AN "{\"action\":\"submit\",\"expectedVersion\":$(SQL "select version from samples where id='$SID2'")}" >/dev/null
fill $SID2 $AN
# M07/M10: the sample signature goes through signRecord, which answers 403 TRAINING_REQUIRED (it was a 400)
expect URS-TRN-untrained-user-cannot-sign "$(post $SID2 $AN "{\"action\":\"review\",\"expectedVersion\":$(SQL "select version from samples where id='$SID2'"),\"password\":\"password\"}")" 403
SQL "update users set has_completed_software_training=true where id='usr-analyst1'" >/dev/null
# e-signature lockout after 3 failed attempts, then even the right password is refused
for i in 1 2 3; do post $SID2 $AN "{\"action\":\"review\",\"expectedVersion\":$(SQL "select version from samples where id='$SID2'"),\"password\":\"bad$i\"}" >/dev/null; done
expect URS-SIG-lockout-after-3-failures "$(post $SID2 $AN "{\"action\":\"review\",\"expectedVersion\":$(SQL "select version from samples where id='$SID2'"),\"password\":\"password\"}")" 401
SQL "update users set failed_attempts=0, locked_at=null where id='usr-analyst1'" >/dev/null
expect URS-AUD-chain-verification-intact "$(curl -s -X POST $BASE/audit/verify -H "Authorization: Bearer $QA" | python3 -c 'import sys,json;print(json.load(sys.stdin)["isValid"])')" True

# --- Checks previously verified by code reading only (DEV-07) -------------------------------------
# URS-005: TOTP enforced at login
SQL "update users set totp_secret='JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', totp_enabled=true where id='usr-qa'" >/dev/null
R=$(curl -s -X POST $BASE/auth/login-local -H "$J" -d '{"email":"qa@gxp.com","password":"password"}')
expect URS-005-totp-required-no-session-issued "$(echo "$R" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("requiresTotp") is True and "token" not in d)')" True
TEMP=$(echo "$R" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("tempToken",""))')
expect URS-005-wrong-totp-refused "$(code -X POST $BASE/auth/totp-verify -H "$J" -d "{\"tempToken\":\"$TEMP\",\"code\":\"000000\"}")" 401
CODE=$(cd "$(dirname "$0")/.." && npx tsx -e "import {generateSync} from 'otplib'; console.log(generateSync({secret:'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'}))" 2>/dev/null | tail -1)
expect URS-005-correct-totp-issues-session "$(curl -s -X POST $BASE/auth/totp-verify -H "$J" -d "{\"tempToken\":\"$TEMP\",\"code\":\"$CODE\"}" | python3 -c 'import sys,json;print("token" in json.load(sys.stdin))')" True
SQL "update users set totp_secret=null, totp_enabled=false where id='usr-qa'" >/dev/null
# URS-006: login lockout after 3 failed logins, even with the right password afterwards
for i in 1 2 3; do code -X POST $BASE/auth/login-local -H "$J" -d '{"email":"reviewer@gxp.com","password":"wrong"}' >/dev/null; done
expect URS-006-account-locked-after-failed-logins "$(code -X POST $BASE/auth/login-local -H "$J" -d '{"email":"reviewer@gxp.com","password":"password"}')" 401
SQL "update users set login_failed_attempts=0, login_locked_until=null, failed_attempts=0, locked_at=null, active=true where id='usr-reviewer'" >/dev/null
RV=$(login reviewer@gxp.com)
# URS-012: segregation of duties - a person who entered results cannot approve the sample
SID3=$(curl -s -X POST $BASE/samples -H "Authorization: Bearer $AN" -H "$J" -d "{\"material\":\"Paracetamol 500mg Finished Tablets\",\"batch\":\"B-$RANDOM\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
recv $SID3
post $SID3 $AN "{\"action\":\"submit\",\"expectedVersion\":$(SQL "select version from samples where id='$SID3'")}" >/dev/null
RID=$(SQL "select id||'|'||version from results where sample_id='$SID3' order by id limit 1")
# M10 (r1-results-oos): a Reviewer reviews results and no longer enters them (it was 200); the Administrator, who may both enter and
# approve, is the person whose own entry must block the approval.
expect URS-012-reviewer-cannot-enter-result "$(curl -s -o /dev/null -w '%{http_code}' -X PUT $BASE/samples/$SID3/results/${RID%%|*} -H "Authorization: Bearer $RV" -H "$J" -d "{\"value\":\"99.5\",\"reason\":\"routine entry\",\"expectedVersion\":${RID##*|}}")" 403
AD=$(login admin@gxp.com)
fill $SID3 $AD
post $SID3 $AN "{\"action\":\"review\",\"expectedVersion\":$(SQL "select version from samples where id='$SID3'"),\"password\":\"password\"}" >/dev/null
expect URS-012-result-enterer-cannot-approve "$(post $SID3 $AD "{\"action\":\"approve\",\"expectedVersion\":$(SQL "select version from samples where id='$SID3'"),\"password\":\"password\",\"reason\":\"x\"}")" 400
exit $fail

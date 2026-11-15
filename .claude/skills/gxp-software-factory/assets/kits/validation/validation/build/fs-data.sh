#!/usr/bin/env bash
# Refreshes the data files the Functional Specification is generated from (validation/build/data/). Run from the repository root.
# Needs an installed database (init-db) for the signature meanings and the table list: SQL_HOST / SQL_USER / SQL_PASSWORD / SQL_DB_NAME.
set -eu; D=validation/build/data; mkdir -p $D
P="env PGPASSWORD=${SQL_PASSWORD:-lims} psql -h ${SQL_HOST:-127.0.0.1} -U ${SQL_USER:-lims} ${SQL_DB_NAME:-lims} -Atc"
$P "select json_agg(json_build_object('code',code,'text',text,'roles',allowed_roles,'reason',requires_reason) order by code) from signature_meanings where active" > $D/signature-meanings.json
$P "select json_agg(tablename order by tablename) from pg_tables where schemaname='public'" > $D/tables.json
npx tsx -e "import {ENTITY_STATES} from './src/server/workflow/entityStates'; import {SampleWorkflow} from './src/server/workflow/transitions'; console.log(JSON.stringify({entities: ENTITY_STATES, sample: SampleWorkflow.map(r => ({from: r.from, to: r.to, roles: r.allowedRoles, signature: r.requiresSignature, meaning: r.signatureMeaning || '', sod: !!r.validateSoD}))}, null, 1))" > $D/states.json
grep -rhoE "\{ name: '[a-z.]+', cron: [^,]+, type: '[^']+', description: '([^'\\\\]|\\\\.)+'" src/server | node -e "
const L=require('fs').readFileSync(0,'utf8').trim().split('\n');
console.log(JSON.stringify(L.map(l=>{const m=l.match(/name: '([^']+)', cron: (.+?), type: '[^']+', description: '(.*)'$/);return {name:m[1],cron:(m[2].match(/'([^']+)'\s*$/)||[,m[2]])[1],description:m[3].replace(/\\\\'/g,\"'\")};}).sort((a,b)=>a.name<b.name?-1:1),null,1))" > $D/schedules.json
wc -c $D/*.json

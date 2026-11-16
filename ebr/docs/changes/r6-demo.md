# r6-demo: demo installation and run guide (E33)

- `server/demo/index.ts`: on an EMPTY installation (nothing but the first administrator; anything else is refused with
  `not_empty`), creates `demo-operator`, `demo-operator2`, `demo-supervisor`, `demo-qa` with the password of
  `EBR_DEMO_PASSWORD` (policy-checked first), then works as they would: demo-qa reviews the built-in logbook types; the
  supervisor creates MIX-01, BAL-01 and RM-101; the operator cleans and calibrates them; the supervisor creates two
  materials and receives a lot of each, demo-qa releases them; the supervisor writes recipe PCM-500 (dispensing, mixer,
  water with limits, calculated ratio, a verified and a signed step, yield limits 97 to 101 %) and signs it to QA, demo-qa
  approves it and makes it effective. Every step is a real service call with a real signature and audit entry.
- `server/demo/cli.ts`: `npm run demo-data`, `npm run demo-data:built`, and inside Docker `node dist/server/demo/cli.js`;
  migrates first; exits non-zero with the reason when refused.
- `README.md`: run guide (Docker, Windows service, first sign-in, demo data, a whole batch step by step), with a short
  Arabic quick start.

Gate needs: `package.json` scripts; the CI compose job runs the demo inside the container and signs demo-supervisor in.

Evidence: `tests/api/demo.test.ts` 6 passed (weak password refused before writing; accounts, ready equipment, released lots,
effective recipe; signatures by the demo accounts themselves and the chain verifies; a second run refused; the supervisor
signs in and creates a 7-step batch; every command and file the guide names exists). The built command run twice on a
scratch database: written, then refused (exit 1).

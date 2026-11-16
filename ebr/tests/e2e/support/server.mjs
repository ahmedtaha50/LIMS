// Starts the BUILT server (dist/) on a fresh database for the browser tests and drops the database when stopped.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import pg from 'pg';

const admin = process.env.TEST_ADMIN_URL ?? 'postgres://ebr:ebr@127.0.0.1:5432/postgres';
const name = `ebr_test_e2e_${randomBytes(4).toString('hex')}`;
const url = new URL(admin); url.pathname = '/' + name;
const q = async (sql) => { const c = new pg.Client({ connectionString: admin }); await c.connect(); try { await c.query(sql); } finally { await c.end(); } };
await q(`CREATE DATABASE "${name}"`);
// accounts for the browser tests, created through the real migrations and password hashing of the built server
const { migrate } = await import('../../../dist/server/migrate/runner.js');
const { hashPassword } = await import('../../../dist/server/identity/password.js');
{
  const c = new pg.Pool({ connectionString: url.toString(), max: 2 });
  await migrate(c, new URL('../../../migrations', import.meta.url).pathname);
  // E28: the built-in logbook types as reviewed by QA at installation qualification (the review itself is an API test)
  await c.query("UPDATE logbook_type_versions SET needs_qa_review = false, qa_reviewed_by = 'e2e setup (QA review at IQ)', qa_reviewed_at = now() WHERE needs_qa_review");
  const pw = await hashPassword('e2e password long enough');
  await c.query("INSERT INTO users (username, display_name, password_hash, roles, must_change_password) VALUES ('e2e-operator', 'E2E Operator', $1, '{operator}', false), ('e2e-new-tablet', 'E2E New tablet', $1, '{operator}', true), ('e2e-new-desktop', 'E2E New desktop', $1, '{operator}', true)", [pw]);
  // logbooks (r1-logbook): a supervisor, a QA account with a known authenticator secret, and one equipment and one room
  // logbook per viewport, so the two runs never write into the same logbook
  await c.query("INSERT INTO users (username, display_name, password_hash, roles, must_change_password, totp_secret, totp_enabled) VALUES ('e2e-supervisor', 'E2E Supervisor', $1, '{supervisor}', false, NULL, false), ('e2e-qa', 'E2E QA', $1, '{qa}', false, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', true)", [pw]);
  // batches (r2-execution): a second operator for verifications, and one effective recipe per viewport
  await c.query("INSERT INTO users (username, display_name, password_hash, roles, must_change_password) VALUES ('e2e-operator2', 'E2E Operator Two', $1, '{operator}', false)", [pw]);
  const steps = [{ key: 'clearance', label: 'Line clearance', type: 'verified', text: 'Room and mixer free of the previous product', critical: false },
    { key: 'water', label: 'Water added', type: 'data', unit: 'L', min: 10, max: 14, decimals: 1, critical: false },
    { key: 'ratio', label: 'Water per kg', type: 'calculation', formula: 'water / 60', unit: 'L/kg', min: 0.15, max: 0.25, decimals: 3, critical: false }];
  // R2 wave 2: a released and an expired lot, a mixer per viewport (dirty: never cleaned), and one recipe per viewport for
  // dispensing, for mixing and for review
  await c.query("INSERT INTO materials (code, name, unit) VALUES ('RM-E2E', 'E2E powder', 'kg')");
  await c.query("INSERT INTO material_lots (material_code, lot_number, status, expiry_date, created_by, decided_by, decided_at) VALUES ('RM-E2E', 'E2E-LOT-OK', 'released', '2099-12-31', 'e2e', 'e2e', now()), ('RM-E2E', 'E2E-LOT-OLD', 'released', '2020-01-31', 'e2e', 'e2e', now())");
  const design = (steps) => JSON.stringify({ batchSize: { value: 10, unit: 'kg' }, phases: [{ key: 'p', label: 'Phase', steps }] });
  const effective = async (code, name, steps) => {
    const id = (await c.query('INSERT INTO mbr_masters (code, product_name) VALUES ($1, $2) RETURNING id', [code, name])).rows[0].id;
    await c.query("INSERT INTO mbr_versions (master_id, version_no, status, design, author_id, author_name, approved_by, approved_at, effective_at) VALUES ($1, 1, 'effective', $2, 'e2e', 'e2e', 'e2e', now(), now())", [id, design(steps)]);
  };
  for (const vp of ['tablet', 'desktop']) {
    await c.query("INSERT INTO logbooks (type_id, object_kind, object_code, name) VALUES ('00000000-0000-4000-8000-000000000e01', 'equipment', $1, $2)", [`MX-E2E-${vp}`, `Interlock mixer ${vp}`]);
    await effective(`E2E-DISP-${vp}`, `Dispensing E2E ${vp}`, [{ key: 'powder', label: 'E2E powder', type: 'material', material: 'RM-E2E', quantity: 10, unit: 'kg', tolerancePct: 1, critical: false }]);
    await effective(`E2E-MIX-${vp}`, `Mixing E2E ${vp}`, [{ key: 'mixer', label: 'Mixer', type: 'equipment', objectKind: 'equipment', purpose: '', critical: false }]);
    await effective(`E2E-REV-${vp}`, `Review E2E ${vp}`, [{ key: 'ph', label: 'pH', type: 'data', unit: 'pH', min: 6, max: 7, decimals: 1, critical: false }]);
  }
  for (const vp of ['tablet', 'desktop']) {
    const m = (await c.query("INSERT INTO mbr_masters (code, product_name) VALUES ($1, $2) RETURNING id", [`E2E-PCM-${vp}`, `Paracetamol E2E ${vp}`])).rows[0].id;
    await c.query("INSERT INTO mbr_versions (master_id, version_no, status, design, author_id, author_name, approved_by, approved_at, effective_at) VALUES ($1, 1, 'effective', $2, 'e2e', 'e2e', 'e2e', now(), now())", [m, JSON.stringify({ batchSize: { value: 60, unit: 'kg' }, phases: [{ key: 'granulation', label: 'Granulation', steps }] })]);
  }
  for (const vp of ['tablet', 'desktop']) {
    await c.query("INSERT INTO logbooks (type_id, object_kind, object_code, name, location, settings) VALUES ('00000000-0000-4000-8000-000000000e01', 'equipment', $1, $2, 'Granulation', '{\"cleanHoldHours\":72}'), ('00000000-0000-4000-8000-000000000e02', 'room', $3, $4, 'Block B', '{}')", [`MIX-E2E-${vp}`, `Mixer for ${vp}`, `RM-E2E-${vp}`, `Room for ${vp}`]);
  }
  await c.end();
}
const child = spawn(process.execPath, ['dist/server/main.js'], { stdio: 'inherit', env: { ...process.env, DATABASE_URL: url.toString(), PORT: process.env.E2E_PORT ?? '4103', NODE_ENV: 'production' } });
let stopping = false;
const stop = async () => { if (stopping) return; stopping = true; child.kill('SIGTERM'); await new Promise(r => child.once('exit', r)); await q(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => undefined); process.exit(0); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
child.on('exit', (code) => { if (!stopping) { console.error(`server exited with ${code}`); void q(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).finally(() => process.exit(1)); } });

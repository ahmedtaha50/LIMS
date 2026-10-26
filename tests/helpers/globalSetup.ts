/**
 * Builds the template database once per Vitest run.
 * The schema is applied through the product's own installer entry point (src/server/init-db.ts), so the tests start
 * from exactly what a fresh install produces: desktop/schema.sql, the append-only triggers, and a first administrator.
 * That administrator is then replaced by the fixed TEST_USERS.
 */
import { execFileSync } from 'child_process';
import path from 'path';
import pg from 'pg';
import { generatePasswordHash } from '../../src/db/utils';
import { TEST_PASSWORD, TEST_USERS, connectionConfig, createEmpty, dropDatabase, listLeftovers, sqlEnv, templateName, withAdmin } from './db';

export default async function setup() {
  const template = templateName();
  await withAdmin(async c => {
    for (const left of await listLeftovers(c)) await dropDatabase(c, left); // from a crashed earlier run
    await createEmpty(c, template);
  });

  const root = path.resolve(__dirname, '..', '..');
  execFileSync(process.execPath, ['--import', 'tsx', 'src/server/init-db.ts'], {
    cwd: root,
    stdio: ['ignore', 'ignore', 'inherit'],
    env: {
      ...process.env,
      ...sqlEnv(),
      SQL_DB_NAME: template,
      ADMIN_EMAIL: 'bootstrap@example.invalid', ADMIN_NAME: 'Bootstrap', ADMIN_PASSWORD: 'bootstrap-password-123',
    },
  });

  const c = new pg.Client(connectionConfig(template));
  await c.connect();
  try {
    await c.query('DELETE FROM users');
    for (const u of TEST_USERS) {
      await c.query(
        `INSERT INTO users (id, uid, name, role, email, password_hash, has_completed_software_training)
         VALUES ($1, $2, $3, $4, $5, $6, true)`,
        [u.id, u.uid, u.name, u.role, u.email, generatePasswordHash(TEST_PASSWORD)],
      );
    }
  } finally {
    await c.end();
  }

  return async () => {
    await withAdmin(async admin => {
      for (const left of await listLeftovers(admin)) await dropDatabase(admin, left);
      await dropDatabase(admin, template);
    });
  };
}

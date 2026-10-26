/**
 * Break-glass administration (roadmap M05), for the person at the PC when no Administrator can sign in: a forgotten password, a locked
 * account, a lost authenticator, the first install, a key rotation. It connects to the database with the same SQL_* settings as the
 * server, so it needs the machine and its stored credentials, not a login. Every action is an audited transaction whose actor is
 * `cli:<operating-system user>` and needs a stated reason. Passwords come from the environment, never from the command line.
 *
 *   admin-cli reset-password --email <address> --reason <text>   prints a temporary password once; the user must change it
 *   admin-cli unlock         --email <address> --reason <text>   clears the sign-in lock and the signing lock
 *   admin-cli reset-mfa      --email <address> --reason <text>   removes the authenticator and recovery codes
 *   admin-cli bootstrap-admin --reason <text>                    first Administrator from ADMIN_EMAIL, ADMIN_NAME, ADMIN_PASSWORD; refuses if one is active
 *   admin-cli rotate-keys    --reason <text>                     re-encrypts stored secrets to the current key generation (LIMS_KEYRING)
 */
import os from 'os';
import { sql } from 'drizzle-orm';
import { createPool, db } from '../db/index';
import { users } from '../db/schema';
import { bootstrapFirstAdmin } from './auth/bootstrap';
import { resetMfa, resetPassword, unlockUser } from './auth/users';
import { rotateStoredSecrets } from './crypto/rotate';
import { AppError } from './http/errors';

const USAGE = `Usage: admin-cli <command> [--email <address>] --reason <text>
Commands: reset-password, unlock, reset-mfa (need --email), bootstrap-admin, rotate-keys.
bootstrap-admin reads ADMIN_EMAIL, ADMIN_NAME and ADMIN_PASSWORD from the environment.`;

function parse(argv: string[]) {
  const [command, ...rest] = argv;
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!rest[i]?.startsWith('--') || rest[i + 1] === undefined) return null;
    flags[rest[i].slice(2)] = rest[i + 1];
  }
  return { command, flags };
}

async function userByEmail(email: string) {
  const [user] = await db.select().from(users).where(sql`lower(${users.email}) = ${email.trim().toLowerCase()}`).limit(1);
  if (!user) throw new Error(`No user has the e-mail address ${email}.`);
  return user;
}

async function main(): Promise<number> {
  const parsed = parse(process.argv.slice(2));
  const reason = parsed?.flags.reason?.trim();
  const needsEmail = ['reset-password', 'unlock', 'reset-mfa'].includes(parsed?.command ?? '');
  if (!parsed || !parsed.command || !['reset-password', 'unlock', 'reset-mfa', 'bootstrap-admin', 'rotate-keys'].includes(parsed.command)
      || !reason || reason.length < 3 || (needsEmail && !parsed.flags.email)) {
    console.error(USAGE);
    return 2;
  }
  const actor = `cli:${os.userInfo().username}`;
  const { command, flags } = parsed;

  if (command === 'rotate-keys') {
    const report = await rotateStoredSecrets(db, { actor, reason });
    console.log(`Key generation ${report.generation}: ${report.totpSecrets} authenticator secret(s), ${report.pendingSecrets} pending enrolment(s) and ${report.apiKeys} API key(s) re-encrypted.`);
    return 0;
  }

  if (command === 'bootstrap-admin') {
    const { ADMIN_EMAIL, ADMIN_NAME, ADMIN_PASSWORD } = process.env;
    if (!ADMIN_EMAIL || !ADMIN_NAME || !ADMIN_PASSWORD) throw new Error('Set ADMIN_EMAIL, ADMIN_NAME and ADMIN_PASSWORD in the environment.');
    const created = await bootstrapFirstAdmin(db, { actor, name: ADMIN_NAME, email: ADMIN_EMAIL, password: ADMIN_PASSWORD, reason });
    console.log(`Administrator ${created.user.email} created (${created.user.id}). The password must be changed at the first sign-in.`);
    return 0;
  }

  const target = await userByEmail(flags.email);
  const input = { reason };
  if (command === 'reset-password') {
    const result = await db.transaction(tx => resetPassword(tx, actor, target.id, input));
    console.log(`Temporary password: ${result.temporaryPassword}`);
    console.log('Give it to the user in person. It is shown only now, and must be changed at the next sign-in. All their sessions have ended.');
  } else if (command === 'unlock') {
    await db.transaction(tx => unlockUser(tx, actor, target.id, input));
    console.log(`${target.email} is unlocked (sign-in and signing).`);
  } else {
    await db.transaction(tx => resetMfa(tx, actor, target.id, input));
    console.log(`Multi-factor authentication removed for ${target.email}. Their sessions have ended.`);
  }
  return 0;
}

main()
  .then(code => createPool().end().then(() => process.exit(code)))
  .catch(err => {
    console.error(err instanceof AppError || err instanceof Error ? err.message : String(err));
    createPool().end().finally(() => process.exit(1));
  });

// Domain: directory (LDAP / Active Directory) sign-on administration (roadmap M41, r3-directory; migration 0310_directory).
// The sign-in itself is src/server/auth/ldap.ts; this file is how an installation is set up and kept under control:
//
//   GET  /directory/settings                  the connection (never the bind password)                              directory.view
//   PUT  /directory/settings                  change the connection / switch on or off; Administrator password,     directory.manage
//                                             reason, version; switching ON needs a working connection test, an
//                                             Approved mapping and a break-glass account with MFA
//   POST /directory/test                      connection test (TLS, service account, optional person look-up)       directory.manage
//   GET  /directory/mappings                  the group to role mapping                                             directory.view
//   POST /directory/mappings                  propose a mapping (Draft; the Administrator role cannot be mapped)    directory.manage
//   POST /directory/mappings/:id/approve      QA e-signature (DIRECTORY_MAPPING) on the version; not by the proposer directory.approve
//   POST /directory/mappings/:id/retire       QA e-signature; members lose the role at their next sign-in           directory.approve
//   GET  /directory/accounts                  directory and break-glass accounts                                    directory.view
//   POST /directory/accounts/:userId/break-glass   flag / unflag a local Administrator as break-glass              directory.manage
import { X509Certificate } from 'crypto';
import { randomBytes } from 'crypto';
import { desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { directoryAccounts, directoryGroupRoles, directorySettings, roles, users } from '../../db/schema';
import { writeAudit } from '../../db/utils';
import { signatureFields } from '../../lib/validations/signatures';
import { assertActorPassword } from '../auth/credentials';
import { recordSecurityEvent, securityEventContext } from '../auth/events';
import {
  loadDirectoryConfig, lookupPerson, mappedRole, normalizeDn, probeDirectory, sealBindPassword, type ConnectionSettings,
} from '../auth/ldap';
import type { UserRow } from '../auth/sessions';
import type { RouteContext } from '../core/context';
import { createRouter } from '../core/router';
import { lockRow, updateVersioned, withTransaction } from '../core/tx';
import { asSigned, registerSignable, signRecord } from '../esign';
import { AppError, ConflictError, NotFoundError } from '../http/errors';
import { validate } from '../http/validate';

export const DIRECTORY_MEANING = 'DIRECTORY_MAPPING';

const reason = z.string('A reason is required.').trim().min(5, 'Give the reason (at least 5 characters).').max(1000);
const actorPassword = z.string('Your password is required.').min(1, 'Your password is required.').max(1024);
const expectedVersion = z.number('expectedVersion is required.').int().min(0, 'Record version mismatch. Refresh required.');

/** PEM text that holds at least one certificate; every block must parse. */
const caPem = z.string().trim().max(20000).refine(v => {
  const blocks = v.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
  if (!blocks) return false;
  try { blocks.forEach(b => new X509Certificate(b)); return true; } catch { return false; }
}, 'The CA must be one or more PEM certificates (BEGIN CERTIFICATE ... END CERTIFICATE).');

export const directorySettingsSchema = z.object({
  enabled: z.boolean('enabled must be true or false.'),
  url: z.string().trim().min(8).max(300).regex(/^ldaps?:\/\/[^/\s]+$/, 'The URL is ldaps://host[:port] (or ldap://host[:port] with StartTLS), without a path.'),
  security: z.enum(['ldaps', 'starttls'], { error: 'security is ldaps or starttls.' }),
  caPem: caPem.nullable().optional(), // omitted = unchanged, null = use the operating system store
  bindDn: z.string().trim().min(3).max(500),
  bindPassword: z.string().min(1).max(512).optional(), // omitted = unchanged; never returned
  baseDn: z.string().trim().min(3).max(500),
  groupAttribute: z.string().trim().regex(/^[A-Za-z][A-Za-z0-9-]{0,63}$/, 'The group attribute is an LDAP attribute name.').optional(),
  timeoutMs: z.number().int().min(1000).max(60000).optional(),
  localAccountsAllowed: z.boolean().optional(),
  reason, expectedVersion, password: actorPassword,
}).strict().refine(v => (v.security === 'ldaps') === v.url.startsWith('ldaps://'), { message: 'ldaps needs an ldaps:// URL; StartTLS needs an ldap:// URL. Plain-text LDAP is not supported.', path: ['url'] });

export const directoryTestSchema = z.object({
  login: z.string().trim().min(1).max(254).optional(),
  password: actorPassword,
}).strict();

export const mappingCreateSchema = z.object({
  groupDn: z.string().trim().min(5).max(500).regex(/^[A-Za-z]+=[^,]+(,\s*[A-Za-z]+=[^,]+)*$/, 'The group is a distinguished name such as CN=LIMS-Analysts,OU=Groups,DC=corp,DC=example.'),
  role: z.string().trim().min(1).max(64),
  reason,
}).strict();

export const mappingDecisionSchema = z.object({
  expectedVersion: expectedVersion.min(1),
  reason: signatureFields.reason.unwrap().min(5, 'Give the reason (at least 5 characters).'),
  password: signatureFields.password,
  totpCode: signatureFields.totpCode,
}).strict();

export const breakGlassSchema = z.object({
  enabled: z.boolean('enabled must be true or false.'), reason, expectedVersion, password: actorPassword,
}).strict();

const settingsView = (r: typeof directorySettings.$inferSelect | undefined) => r ? {
  enabled: r.enabled, url: r.url, security: r.security, caPem: r.caPem, bindDn: r.bindDn, hasBindPassword: !!r.bindPasswordEnc,
  baseDn: r.baseDn, groupAttribute: r.groupAttribute, timeoutMs: r.timeoutMs, localAccountsAllowed: r.localAccountsAllowed, version: r.version, updatedBy: r.updatedBy, updatedAt: r.updatedAt,
} : {
  enabled: false, url: null, security: 'ldaps', caPem: null, bindDn: null, hasBindPassword: false, baseDn: null, groupAttribute: 'memberOf', timeoutMs: 5000, localAccountsAllowed: true, version: 0, updatedBy: null, updatedAt: null,
};

// A signature on a mapping covers the group, the role and the status as signed.
registerSignable({
  type: 'DirectoryGroupRole',
  async canonical(ex, { id, change }) {
    const [row] = await ex.select().from(directoryGroupRoles).where(eq(directoryGroupRoles.id, id)).limit(1);
    if (!row) return null;
    return { id: row.id, groupDn: row.groupDn, role: row.role, status: asSigned(change, ['status'], row.status) };
  },
});

export const directoryRoutes = ({ db, requireAuth }: RouteContext) => {
  const router = createRouter();
  const actorOf = (req: any): UserRow => req.user;

  router.get('/directory/settings', requireAuth, async (_req, res) => {
    const [row] = await db.select().from(directorySettings).where(eq(directorySettings.id, 'default')).limit(1);
    res.json(settingsView(row));
  });

  router.put('/directory/settings', requireAuth, validate(directorySettingsSchema), async (req, res) => {
    const actor = actorOf(req);
    const body = req.body as z.infer<typeof directorySettingsSchema>;
    await assertActorPassword(db, actor, body.password, { entity: 'DirectorySettings', entityId: 'default', what: 'a directory sign-on change' }, securityEventContext(req));

    const [current] = await db.select().from(directorySettings).where(eq(directorySettings.id, 'default')).limit(1);
    if ((current?.version ?? 0) !== body.expectedVersion) throw new ConflictError();
    const bindPasswordEnc = body.bindPassword ? sealBindPassword(body.bindPassword) : current?.bindPasswordEnc ?? null;
    if (!bindPasswordEnc) throw new AppError(400, 'BIND_PASSWORD_REQUIRED', 'Enter the password of the service account.');
    const next = {
      enabled: body.enabled, url: body.url, security: body.security, caPem: body.caPem === undefined ? current?.caPem ?? null : body.caPem,
      bindDn: body.bindDn, bindPasswordEnc, baseDn: body.baseDn, groupAttribute: body.groupAttribute ?? current?.groupAttribute ?? 'memberOf',
      timeoutMs: body.timeoutMs ?? current?.timeoutMs ?? 5000, localAccountsAllowed: body.localAccountsAllowed ?? current?.localAccountsAllowed ?? true,
    };

    if (body.enabled) {
      // Switching on must not be able to lock everybody out or to give nobody a role.
      const [approved] = (await db.execute(sql`select count(*)::int as n from directory_group_roles where status = 'Approved'`)).rows as Array<{ n: number }>;
      if (!approved.n) throw new AppError(409, 'MAPPING_REQUIRED', 'Approve at least one group to role mapping before switching directory sign-on on.');
      const [bg] = (await db.execute(sql`select count(*)::int as n from directory_accounts a join users u on u.id = a.user_id where a.kind = 'break-glass' and u.active and u.role = 'Admin' and u.totp_enabled`)).rows as Array<{ n: number }>;
      if (!bg.n) throw new AppError(409, 'BREAK_GLASS_REQUIRED', 'Flag at least one local Administrator with multi-factor authentication as break-glass before switching directory sign-on on.');
      const cfg: ConnectionSettings = { ...next, bindPassword: body.bindPassword ?? (await loadDirectoryConfig(db))?.bindPassword ?? '' };
      const probe = await probeDirectory(cfg);
      if (!probe.ok) throw new AppError(422, 'DIRECTORY_TEST_FAILED', `The directory connection test failed (${probe.reason}). Nothing was changed.`);
    }

    const view = (r: typeof directorySettings.$inferSelect | undefined) => { const v = settingsView(r); return { ...v, caPem: v.caPem ? `${v.caPem.length} characters` : null }; };
    const saved = await withTransaction(db, async tx => {
      let row: typeof directorySettings.$inferSelect;
      if (!current) {
        const inserted = await tx.insert(directorySettings).values({ id: 'default', ...next, updatedBy: actor.id }).onConflictDoNothing().returning();
        if (inserted.length !== 1) throw new ConflictError();
        row = inserted[0];
      } else {
        await lockRow(tx, directorySettings, 'default');
        row = await updateVersioned(tx, directorySettings, 'default', body.expectedVersion, { ...next, updatedBy: actor.id, updatedAt: new Date() });
      }
      await writeAudit(tx, actor.id, current ? 'Update' : 'Create', 'DirectorySettings', 'default', 'directory_sign_on',
        JSON.stringify(view(current)), JSON.stringify({ ...view(row), bindPasswordChanged: !!body.bindPassword }), body.reason);
      return row;
    });
    res.json(settingsView(saved));
  });

  router.post('/directory/test', requireAuth, validate(directoryTestSchema), async (req, res) => {
    const actor = actorOf(req);
    const { login, password } = req.body as z.infer<typeof directoryTestSchema>;
    await assertActorPassword(db, actor, password, { entity: 'DirectorySettings', entityId: 'default', what: 'a directory connection test' }, securityEventContext(req));
    const cfg = await loadDirectoryConfig(db);
    if (!cfg) throw new AppError(409, 'DIRECTORY_NOT_CONFIGURED', 'The directory connection is not configured yet.');
    const probe = await probeDirectory(cfg);
    let person: { dn: string; groups: string[]; mappedRole: string | null; accountState: string } | null = null;
    if (probe.ok && login) {
      const found = await lookupPerson(cfg, login);
      if (found.kind === 'found') {
        person = { dn: found.person.dn, groups: found.person.groups, mappedRole: (await mappedRole(db, found.person.groups)).role, accountState: found.refusal ?? 'enabled' };
      }
    }
    await recordSecurityEvent(db, { type: 'DIRECTORY_TEST', outcome: probe.ok ? 'success' : 'failure', actorId: actor.id, actorRole: actor.role, ...securityEventContext(req), detail: { url: cfg.url, security: cfg.security, reachable: probe.ok, reason: probe.ok ? null : probe.reason, lookedUpPerson: !!login } });
    res.json({ reachable: probe.ok, reason: probe.ok ? null : probe.reason, security: cfg.security, person });
  });

  // --- group to role mapping ----------------------------------------------------------------------------------------------

  router.get('/directory/mappings', requireAuth, async (_req, res) => {
    const rows = await db.select().from(directoryGroupRoles).orderBy(desc(directoryGroupRoles.createdAt), directoryGroupRoles.id);
    res.json(rows);
  });

  router.post('/directory/mappings', requireAuth, validate(mappingCreateSchema), async (req, res) => {
    const actor = actorOf(req);
    const { groupDn, role, reason: why } = req.body as z.infer<typeof mappingCreateSchema>;
    if (role === 'Admin') throw new AppError(400, 'ROLE_NOT_MAPPABLE', 'The Administrator role is never given by the directory: it is granted with the two-person role change.');
    const [known] = await db.select({ name: roles.name }).from(roles).where(sql`${roles.name} = ${role} and ${roles.active}`).limit(1);
    if (!known) throw new AppError(400, 'UNKNOWN_ROLE', `"${role}" is not an active role.`);
    const id = `dgr-${randomBytes(6).toString('hex')}`;
    try {
      const row = await withTransaction(db, async tx => {
        const [inserted] = await tx.insert(directoryGroupRoles).values({ id, groupDn, groupDnNorm: normalizeDn(groupDn), role, reason: why, createdBy: actor.id }).returning();
        await writeAudit(tx, actor.id, 'Create', 'DirectoryGroupRole', id, 'mapping', '', JSON.stringify({ groupDn, role, status: 'Draft' }), why);
        return inserted;
      });
      res.status(201).json(row);
    } catch (e: any) {
      if ((e?.cause?.code ?? e?.code) === '23505') throw new AppError(409, 'MAPPING_EXISTS', 'This group already has a Draft or Approved mapping. Retire it first.');
      throw e;
    }
  });

  const decide = (to: 'Approved' | 'Retired') => async (req: any, res: any) => {
    const user = actorOf(req);
    const id = String(req.params.id);
    const { expectedVersion: version, reason: why, password, totpCode } = req.body as z.infer<typeof mappingDecisionSchema>;
    const check = (row: typeof directoryGroupRoles.$inferSelect | undefined) => {
      if (!row) throw new NotFoundError(`Mapping ${id} was not found.`);
      if (row.version !== version) throw new ConflictError();
      const legal = to === 'Approved' ? row.status === 'Draft' : row.status !== 'Retired';
      if (!legal) throw new AppError(409, 'ILLEGAL_TRANSITION', `A ${row.status} mapping cannot be ${to === 'Approved' ? 'approved' : 'retired'}.`);
      if (to === 'Approved' && row.createdBy === user.id) throw new AppError(403, 'SELF_APPROVAL_FORBIDDEN', 'The person who proposed a mapping cannot approve it.');
    };
    const [found] = await db.select().from(directoryGroupRoles).where(eq(directoryGroupRoles.id, id)).limit(1);
    check(found); // decided before the signature is asked for: a refused change costs the signer no attempt

    const { result, signature } = await signRecord({
      db, user, meaningCode: DIRECTORY_MEANING, credentials: { password, totpCode }, reason: why,
      entityType: 'DirectoryGroupRole', entityId: id, context: securityEventContext(req),
      execute: async (tx) => {
        const [current] = await tx.select().from(directoryGroupRoles).where(eq(directoryGroupRoles.id, id)).for('update');
        check(current);
        const stamp = to === 'Approved' ? { approvedBy: user.id, approvedAt: new Date() } : { retiredBy: user.id, retiredAt: new Date() };
        const row = await updateVersioned(tx, directoryGroupRoles, id, version, { status: to, ...stamp });
        return {
          recordVersion: row.version, result: row,
          audit: { action: to === 'Approved' ? 'Approve' : 'Retire', field: 'status', oldValue: current.status, newValue: to, reason: why },
        };
      },
    });
    res.json({ mapping: result, signature });
  };
  router.post('/directory/mappings/:id/approve', requireAuth, validate(mappingDecisionSchema), decide('Approved'));
  router.post('/directory/mappings/:id/retire', requireAuth, validate(mappingDecisionSchema), decide('Retired'));

  // --- accounts and break-glass ---------------------------------------------------------------------------------------------

  router.get('/directory/accounts', requireAuth, async (_req, res) => {
    const rows = await db.select({
      userId: directoryAccounts.userId, kind: directoryAccounts.kind, dn: directoryAccounts.dn, groups: directoryAccounts.groups, syncedAt: directoryAccounts.syncedAt,
      version: directoryAccounts.version, email: users.email, name: users.name, role: users.role, active: users.active, mfaEnabled: users.totpEnabled,
    }).from(directoryAccounts).innerJoin(users, eq(users.id, directoryAccounts.userId)).orderBy(directoryAccounts.kind, users.email);
    res.json(rows);
  });

  router.post('/directory/accounts/:userId/break-glass', requireAuth, validate(breakGlassSchema), async (req, res) => {
    const actor = actorOf(req);
    const userId = String(req.params.userId);
    const { enabled, reason: why, expectedVersion: version, password } = req.body as z.infer<typeof breakGlassSchema>;
    await assertActorPassword(db, actor, password, { entity: 'DirectoryAccount', entityId: userId, what: 'a break-glass change' }, securityEventContext(req));
    const result = await withTransaction(db, async tx => {
      const target = await lockRow(tx, users, userId);
      const [acct] = await tx.select().from(directoryAccounts).where(eq(directoryAccounts.userId, userId)).for('update');
      if (acct?.kind === 'ldap') throw new AppError(409, 'DIRECTORY_ACCOUNT', 'A directory account cannot be a break-glass account: it is local by definition.');
      if ((acct?.version ?? 0) !== version) throw new ConflictError();
      if (enabled) {
        if (acct) throw new AppError(409, 'ILLEGAL_TRANSITION', 'This account is already a break-glass account.');
        if (!target.active || target.role !== 'Admin') throw new AppError(409, 'BREAK_GLASS_ROLE', 'A break-glass account is an active local Administrator.');
        if (!target.totpEnabled) throw new AppError(409, 'BREAK_GLASS_MFA', 'A break-glass account needs multi-factor authentication. The Administrator enrols an authenticator first.');
        await tx.insert(directoryAccounts).values({ userId, kind: 'break-glass', createdBy: actor.id });
        await writeAudit(tx, actor.id, 'Update', 'DirectoryAccount', userId, 'break_glass', 'false', 'true', why);
        return { userId, kind: 'break-glass', version: 1 };
      }
      if (!acct) throw new AppError(409, 'ILLEGAL_TRANSITION', 'This account is not a break-glass account.');
      const [cfg] = await tx.select({ enabled: directorySettings.enabled }).from(directorySettings).where(eq(directorySettings.id, 'default')).limit(1);
      if (cfg?.enabled) {
        const rest = await tx.execute(sql`select 1 from directory_accounts a join users u on u.id = a.user_id where a.kind = 'break-glass' and a.user_id <> ${userId} and u.active and u.role = 'Admin' and u.totp_enabled limit 1`);
        if (rest.rows.length === 0) throw new AppError(409, 'LAST_BREAK_GLASS', 'Directory sign-on is on: the last break-glass account cannot be removed.');
      }
      await tx.delete(directoryAccounts).where(sql`${directoryAccounts.userId} = ${userId} and ${directoryAccounts.version} = ${version}`);
      await writeAudit(tx, actor.id, 'Update', 'DirectoryAccount', userId, 'break_glass', 'true', 'false', why);
      return { userId, kind: null, version: 0 };
    });
    res.json(result);
  });

  return router;
};

// Domain: API clients of the machine integration API (roadmap M22). Owned by r2-api-v1.
//
//   GET  /api-clients              every client, newest first, with its status (Active, Expired, Revoked), and the scope catalog
//   POST /api-clients              create a client and its service account, e-signed (ADMIN_AUTHORISATION); answers the token ONCE
//   POST /api-clients/:id/revoke   revoke a client, e-signed, with the version the screen showed; its service account is deactivated
//
// Permissions (src/server/authz/routeTable.ts): admin.integrations.view and admin.integrations.manage, which only Admin holds.
// Only the SHA-256 of a token is stored: a lost token is replaced by revoking the client and creating a new one.
import { randomBytes } from 'crypto';
import { desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { instruments, users } from '../../db/schema';
import { apiClients } from '../../db/schema/api-clients';
import { writeAudit } from '../../db/utils';
import { signatureFields } from '../../lib/validations/signatures';
import { securityEventContext } from '../auth/events';
import { generateApiToken, SERVICE_ACCOUNT_ROLE, type ApiClientRow } from '../auth/principals/apiToken';
import type { RouteContext } from '../core/context';
import { createRouter } from '../core/router';
import { updateVersioned } from '../core/tx';
import { signRecord } from '../esign';
import { AppError, BadRequestError, ConflictError, NotFoundError } from '../http/errors';
import { validate } from '../http/validate';
import '../v1/entities';
import { API_SCOPE_NAMES, API_SCOPES } from '../v1/scopes';

const MEANING = 'ADMIN_AUTHORISATION';
/** Longest validity of a token. A machine credential that never expires is not attributable for long; a new one is a signed act. */
export const MAX_TOKEN_DAYS = 365;

const credentials = {
  password: signatureFields.password,
  totpCode: signatureFields.totpCode,
  reason: z.string('A reason is required.').trim().min(5, 'A reason of at least 5 characters is required.').max(500),
};

/** POST /api-clients. id, token, service account, status, version and the creator are the server's. */
export const apiClientCreateSchema = z.object({
  name: z.string('A name is required.').trim().min(3, 'The name needs at least 3 characters.').max(100),
  description: z.string().trim().max(500).optional(),
  scopes: z.array(z.enum(API_SCOPE_NAMES as [string, ...string[]], { error: `Scopes are: ${API_SCOPE_NAMES.join(', ')}.` }))
    .min(1, 'Choose at least one scope.')
    .refine(s => new Set(s).size === s.length, 'A scope is listed twice.'),
  expiresInDays: z.number().int().min(1).max(MAX_TOKEN_DAYS, `A token is valid for at most ${MAX_TOKEN_DAYS} days.`),
  instrumentId: z.string().trim().min(1).max(64).optional(),
  ...credentials,
}).strict();

/** POST /api-clients/:id/revoke */
export const apiClientRevokeSchema = z.object({
  expectedVersion: z.number().int().min(1),
  ...credentials,
}).strict();

export type ApiClientStatus = 'Active' | 'Expired' | 'Revoked';

/** What the screen shows of a client. Never the token hash. */
export function apiClientView(c: ApiClientRow, now = new Date()) {
  const status: ApiClientStatus = c.status === 'Revoked' ? 'Revoked' : c.expiresAt <= now ? 'Expired' : 'Active';
  return {
    id: c.id, name: c.name, description: c.description, userId: c.userId, tokenPrefix: c.tokenPrefix, scopes: c.scopes, instrumentId: c.instrumentId,
    status, expiresAt: c.expiresAt.toISOString(), createdBy: c.createdBy, createdAt: c.createdAt.toISOString(),
    lastUsedAt: c.lastUsedAt?.toISOString() ?? null, revokedAt: c.revokedAt?.toISOString() ?? null, revokedBy: c.revokedBy, revokedReason: c.revokedReason,
    version: c.version,
  };
}

const isUniqueViolation = (e: any) => e?.code === '23505' || e?.cause?.code === '23505';

export const apiClientsRoutes = ({ db, requireAuth }: RouteContext) => {
  const router = createRouter();

  router.get('/api-clients', requireAuth, async (_req, res) => {
    const rows = await db.select().from(apiClients).orderBy(desc(apiClients.createdAt), desc(apiClients.id));
    const now = new Date();
    res.json({ clients: rows.map(r => apiClientView(r, now)), scopes: API_SCOPES.map(s => ({ ...s })) });
  });

  router.post('/api-clients', requireAuth, validate(apiClientCreateSchema), async (req, res) => {
    const user = (req as any).user;
    const body = req.body as z.infer<typeof apiClientCreateSchema>;
    // Checked before the signature, so a refusal costs the signer no attempt; the unique index decides a race.
    const [taken] = await db.select({ id: apiClients.id }).from(apiClients).where(sql`lower(${apiClients.name}) = lower(${body.name})`).limit(1);
    if (taken) throw new ConflictError(`An API client named "${body.name}" already exists (${taken.id}). Names are unique, ignoring case.`);
    if (body.instrumentId) {
      const [inst] = await db.select({ id: instruments.id }).from(instruments).where(eq(instruments.id, body.instrumentId)).limit(1);
      if (!inst) throw new BadRequestError(`Instrument ${body.instrumentId} does not exist.`);
    }

    const clientId = `apic-${randomBytes(6).toString('hex')}`;
    const serviceUserId = `usr-api-${randomBytes(6).toString('hex')}`;
    const { token, prefix, hash } = generateApiToken();
    const expiresAt = new Date(Date.now() + body.expiresInDays * 86_400_000);
    try {
      const { result } = await signRecord({
        db, user, meaningCode: MEANING, credentials: { password: body.password, totpCode: body.totpCode }, reason: body.reason,
        entityType: 'ApiClient', entityId: clientId, context: securityEventContext(req),
        execute: async (tx) => {
          const account = {
            id: serviceUserId, uid: `api-client:${clientId}`, name: `API client: ${body.name}`, role: SERVICE_ACCOUNT_ROLE, active: true,
            email: null, passwordHash: null, hasCompletedSoftwareTraining: false, mustChangePassword: false,
          };
          await tx.insert(users).values(account);
          await writeAudit(tx, user.id, 'Create', 'User', serviceUserId, 'all', '',
            JSON.stringify({ name: account.name, role: account.role, active: true, apiClientId: clientId }), body.reason);
          const [row] = await tx.insert(apiClients).values({
            id: clientId, name: body.name, description: body.description ?? '', userId: serviceUserId, tokenPrefix: prefix, tokenHash: hash,
            scopes: body.scopes, instrumentId: body.instrumentId ?? null, status: 'Active', expiresAt, createdBy: user.id,
          }).returning();
          return {
            recordVersion: row.version,
            audit: {
              action: 'Create', field: 'status', oldValue: '',
              newValue: 'Active', reason: `${body.reason} [scopes: ${body.scopes.join(', ')}; expires ${expiresAt.toISOString()}; token ${prefix}...]`,
            },
            result: row,
          };
        },
      });
      res.status(201).json({ client: apiClientView(result), token });
    } catch (e) {
      if (isUniqueViolation(e)) throw new ConflictError(`An API client named "${body.name}" already exists. Names are unique, ignoring case.`);
      throw e;
    }
  });

  router.post('/api-clients/:id/revoke', requireAuth, validate(apiClientRevokeSchema), async (req, res) => {
    const user = (req as any).user;
    const id = String(req.params.id);
    const body = req.body as z.infer<typeof apiClientRevokeSchema>;
    const check = (c: ApiClientRow | undefined): ApiClientRow => {
      if (!c) throw new NotFoundError(`API client ${id} does not exist.`);
      if (c.status === 'Revoked') throw new AppError(423, 'RECORD_LOCKED', `RECORD_LOCKED: API client ${id} was revoked on ${c.revokedAt?.toISOString()}; a revoked client is never reactivated.`);
      if (c.version !== body.expectedVersion) throw new ConflictError();
      return c;
    };
    check((await db.select().from(apiClients).where(eq(apiClients.id, id)).limit(1))[0]);

    const { result } = await signRecord({
      db, user, meaningCode: MEANING, credentials: { password: body.password, totpCode: body.totpCode }, reason: body.reason,
      entityType: 'ApiClient', entityId: id, context: securityEventContext(req),
      execute: async (tx) => {
        const [locked] = await tx.select().from(apiClients).where(eq(apiClients.id, id)).for('update').limit(1);
        const current = check(locked);
        const row = await updateVersioned(tx, apiClients, id, body.expectedVersion, { status: 'Revoked', revokedAt: new Date(), revokedBy: user.id, revokedReason: body.reason });
        const [account] = await tx.select().from(users).where(eq(users.id, current.userId)).for('update').limit(1);
        if (account?.active) {
          await updateVersioned(tx, users, account.id, account.version, { active: false });
          await writeAudit(tx, user.id, 'Update', 'User', account.id, 'active', 'true', 'false', `API client ${id} revoked: ${body.reason}`);
        }
        return { recordVersion: row.version, audit: { action: 'Revoke', field: 'status', oldValue: 'Active', newValue: 'Revoked', reason: body.reason }, result: row };
      },
    });
    res.json(apiClientView(result));
  });

  return router;
};

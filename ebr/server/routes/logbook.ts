import type { Request, Response } from 'express';
import { z } from 'zod';
import type { Pool } from '../core/db.js';
import { withTx } from '../core/db.js';
import { route, type Actor } from '../core/route.js';
import { strict, version } from '../core/validate.js';
import { passwordCheck } from '../identity/index.js';
import { textPdf } from '../logbook/pdf.js';
import * as svc from '../logbook/service.js';

const password = z.string().min(1).max(200);
const reason = z.string().min(3).max(1000);
const settings = strict({ cleanHoldHours: z.number().min(0).max(24 * 365).optional() });
/** Runs a service call in one transaction with the context every write needs. */
const tx = <T>(pool: Pool, actor: Actor | null, res: Response, fn: (x: svc.Ctx) => Promise<T>) =>
  withTx(pool, (c) => fn({ c, pool, check: passwordCheck(pool), actor: actor as svc.Ctx['actor'], requestId: String(res.locals.requestId) }));
type P = Record<string, string>;
const p = (params: P, k: string) => params[k] as string;

export const routes = [
  // ----- types (E21)
  route({ method: 'GET', path: '/api/logbook-types', permission: 'logbook.read', summary: 'Logbook types with their versions', handler: ({ pool }) => svc.listTypes(pool) }),
  route({
    method: 'POST', path: '/api/logbook-types', permission: 'logbook.type.design', summary: 'Create a logbook type (version 1, draft)', status: 201,
    input: strict({ code: z.string().regex(/^[a-z][a-z0-9_-]{1,39}$/), name: z.string().min(1).max(100), description: z.string().max(1000).default(''), definition: z.unknown() }),
    handler: ({ pool, actor, res, input }) => tx(pool, actor, res, (x) => svc.createType(x, input)),
  }),
  route({
    method: 'PUT', path: '/api/logbook-types/:typeId/versions/:versionId', permission: 'logbook.type.design', summary: 'Change a draft version',
    input: strict({ rowVersion: version, definition: z.unknown() }),
    handler: ({ pool, actor, res, input, params }) => tx(pool, actor, res, (x) => svc.editDraft(x, p(params, 'typeId'), p(params, 'versionId'), input.rowVersion, input.definition)),
  }),
  route({
    method: 'POST', path: '/api/logbook-types/:typeId/versions', permission: 'logbook.type.design', summary: 'Start a new draft version from the effective one', status: 201,
    handler: ({ pool, actor, res, params }) => tx(pool, actor, res, (x) => svc.newDraft(x, p(params, 'typeId'))),
  }),
  route({
    method: 'POST', path: '/api/logbook-types/:typeId/versions/:versionId/submit', permission: 'logbook.type.design', summary: 'Sign a draft as its author and send it to QA',
    input: strict({ rowVersion: version, password }),
    handler: ({ pool, actor, res, input, params }) => tx(pool, actor, res, (x) => svc.submit(x, p(params, 'typeId'), p(params, 'versionId'), input.rowVersion, input.password)),
  }),
  route({
    method: 'POST', path: '/api/logbook-types/:typeId/versions/:versionId/approve', permission: 'logbook.type.approve', summary: 'QA approval: the version becomes effective',
    input: strict({ rowVersion: version, password, comment: z.string().max(1000).optional() }),
    handler: ({ pool, actor, res, input, params }) => tx(pool, actor, res, (x) => svc.approve(x, p(params, 'typeId'), p(params, 'versionId'), input.rowVersion, input.password, input.comment ?? null)),
  }),
  route({
    method: 'POST', path: '/api/logbook-types/:typeId/versions/:versionId/reject', permission: 'logbook.type.approve', summary: 'QA sends a version back to draft, with a reason',
    input: strict({ rowVersion: version, password, reason }),
    handler: ({ pool, actor, res, input, params }) => tx(pool, actor, res, (x) => svc.reject(x, p(params, 'typeId'), p(params, 'versionId'), input.rowVersion, input.password, input.reason)),
  }),
  // ----- logbooks (E06, E07)
  route({
    method: 'GET', path: '/api/logbooks', permission: 'logbook.read', summary: 'Logbooks with their derived status',
    input: strict({ objectKind: z.string().max(20).optional(), status: z.enum(['active', 'retired']).optional() }),
    handler: ({ pool, input }) => svc.listLogbooks(pool, input),
  }),
  route({
    method: 'POST', path: '/api/logbooks', permission: 'logbook.manage', summary: 'Create the logbook of an object from an effective type', status: 201,
    input: strict({ typeCode: z.string().min(1).max(40), objectKind: z.enum(['equipment', 'room', 'area', 'instrument', 'process', 'other']), objectCode: z.string().regex(/^[A-Za-z0-9._/-]{1,40}$/), name: z.string().min(1).max(120), location: z.string().max(120).default(''), settings: settings.default({}) }),
    handler: ({ pool, actor, res, input }) => tx(pool, actor, res, (x) => svc.createLogbook(x, input)),
  }),
  route({ method: 'GET', path: '/api/logbooks/:id', permission: 'logbook.read', summary: 'A logbook, its entries in time order, and its derived status', handler: ({ pool, params }) => svc.logbookDetail(pool, p(params, 'id')) }),
  route({
    method: 'PATCH', path: '/api/logbooks/:id', permission: 'logbook.manage', summary: 'Change the name, location or settings of a logbook (states the version read)',
    input: strict({ version, reason, name: z.string().min(1).max(120).optional(), location: z.string().max(120).optional(), settings: settings.optional() }),
    handler: ({ pool, actor, res, input, params }) => tx(pool, actor, res, (x) => svc.changeLogbook(x, p(params, 'id'), input)),
  }),
  route({
    method: 'POST', path: '/api/logbooks/:id/retire', permission: 'logbook.manage', summary: 'Retire a logbook (signed; it stays readable)',
    input: strict({ version, reason, password }),
    handler: ({ pool, actor, res, input, params }) => tx(pool, actor, res, (x) => svc.retireLogbook(x, p(params, 'id'), input.version, input.reason, input.password)),
  }),
  route({
    method: 'POST', path: '/api/logbooks/:id/entries', permission: 'logbook.write', summary: 'Write a signed entry', status: 201,
    input: strict({ kind: z.string().min(1).max(40), values: z.record(z.string(), z.unknown()), comment: z.string().max(2000).optional(), password }),
    handler: ({ pool, actor, res, input, params }) => tx(pool, actor, res, (x) => svc.writeEntry(x, p(params, 'id'), input)),
  }),
  route({
    method: 'POST', path: '/api/logbooks/:id/entries/:entryId/correct', permission: 'logbook.write', summary: 'Correct an entry with a new signed entry and a reason', status: 201,
    input: strict({ kind: z.string().min(1).max(40), values: z.record(z.string(), z.unknown()), comment: z.string().max(2000).optional(), reason, password }),
    handler: ({ pool, actor, res, input, params }) => tx(pool, actor, res, (x) => svc.writeEntry(x, p(params, 'id'), { ...input, correctsEntryId: p(params, 'entryId') })),
  }),
  route({
    method: 'GET', path: '/api/logbooks/:id/export', permission: 'logbook.read', summary: 'The logbook as a PDF with every entry, signer and meaning',
    handler: async ({ pool, params, res, actor }: { pool: Pool; params: P; res: Response; actor: Actor | null; req: Request }) => {
      const d = await svc.logbookDetail(pool, p(params, 'id'));
      const lines = [
        `${d.typeName}: ${d.objectKind} ${d.objectCode} - ${d.name}${d.location ? ' (' + d.location + ')' : ''}`,
        `Status (derived): ${d.derived.status}${d.derived.reasons.length ? ' - ' + d.derived.reasons.join('; ') : ''}${d.derived.calibrationDue ? '; calibration due ' + d.derived.calibrationDue.slice(0, 10) : ''}`,
        `Exported by ${actor?.username} at ${new Date().toISOString()} (server time, UTC). Entries: ${d.entries.length}.`, '',
        ...d.entries.flatMap(e => [
          `#${e.id}  ${e.recordedAt}  ${e.kindLabel} (type version ${e.typeVersion})${e.correctsEntryId ? `  CORRECTS #${e.correctsEntryId}: ${e.correctionReason}` : ''}${e.correctedBy ? `  [corrected by #${e.correctedBy}]` : ''}`,
          `    ${Object.entries(e.values).map(([k, v]) => `${k}: ${String(v)}`).join('; ') || '(no values)'}`,
          ...(e.flags.length ? [`    OUTSIDE LIMITS: ${e.flags.map(f => f.message).join('; ')}`] : []),
          ...(e.comment ? [`    Comment: ${e.comment}`] : []),
          `    Signed: ${e.signedBy}, meaning ${e.meaning}, ${e.signedAt}`,
        ]),
      ];
      const { pdf, sha256 } = textPdf(`Logbook ${d.objectCode}`, lines);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="logbook-${d.objectCode.replace(/[^A-Za-z0-9._-]/g, '_')}.pdf"`);
      res.setHeader('X-Export-SHA256', sha256);
      res.status(200).end(pdf);
    },
  }),
];

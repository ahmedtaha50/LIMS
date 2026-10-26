// Domain: backup (roadmap M14). Manual backup and verification by an Administrator who re-enters their password, the status the UI
// shows (last good backup, mirror, banners), and the restore drill as a queued job. Scheduled backups run through the job system
// (src/server/jobs/handlers/backup.ts), not through these routes.
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { writeAudit } from '../../db/utils';
import { assertActorPassword } from '../auth/credentials';
import { securityEventContext } from '../auth/events';
import { type RouteContext } from '../core/context';
import { createRouter } from '../core/router';
import { AppError, ForbiddenError } from '../http/errors';
import { validate } from '../http/validate';
import { verifyBackup } from '../backup';
import { backupSettings, backupStatus, runBackup } from '../jobs/backupService';
import { publishTask } from '../rabbitmq';
import { jobsRoutes } from './jobs';

const password = z.string().min(1, 'Your password is required.').max(1024);
const passphrase = z.string().min(12, 'Backup passphrase must be at least 12 characters').max(1024);

const backupSchema = z.object({ password, passphrase: passphrase.optional() }).strict();
const verifySchema = z.object({ password, passphrase: z.string().min(1).max(1024).optional(), file: z.string().min(1, 'file is required').max(255) }).strict();
const drillSchema = z.object({ password }).strict();

export const backupRoutes = (ctx: RouteContext) => {
  const { db, requireAuth } = ctx;
  const router = createRouter();

  /** Admin only, and the Administrator's own password again (counted toward the signing lock like any e-signature password). */
  async function adminWithPassword(req: any, what: string) {
    const actor = req.user;
    if (actor.role !== 'Admin') throw new ForbiddenError('Forbidden: Admin only.');
    await assertActorPassword(db, actor, req.body.password, { entity: 'System', entityId: 'backup', what }, securityEventContext(req));
    return actor;
  }

  router.post('/admin/backup', requireAuth, validate(backupSchema), async (req, res) => {
    const actor = await adminWithPassword(req, 'a backup');
    const settings = backupSettings();
    const typed: string | undefined = req.body.passphrase;
    if (!typed && !settings.passphrase) throw new AppError(400, 'NO_PASSPHRASE', 'No backup passphrase: type one, or configure BACKUP_PASSPHRASE.');
    let r;
    try { r = await runBackup({ db, settings, actorId: actor.id, kind: 'manual', reason: 'Manual backup', passphrase: typed }); }
    catch (e: any) { throw new AppError(500, 'BACKUP_FAILED', `The backup failed (the attempt is recorded): ${e.message}`); }
    res.json({ file: r.file, sha256: r.sha256, verified: r.verified, problems: r.problems, auditHead: r.auditHead, counts: r.counts, mirror: r.mirror, runId: r.runId });
  });

  router.post('/admin/backup/verify', requireAuth, validate(verifySchema), async (req, res) => {
    const actor = await adminWithPassword(req, 'a backup verification');
    const settings = backupSettings();
    const key = req.body.passphrase ?? settings.passphrase;
    if (!key) throw new AppError(400, 'NO_PASSPHRASE', 'No backup passphrase: type one, or configure BACKUP_PASSPHRASE.');
    const name = path.basename(req.body.file);
    const file = path.join(settings.dir, name);
    if (!fs.existsSync(file)) throw new AppError(400, 'BACKUP_NOT_FOUND', `Backup file ${name} was not found in the backup folder.`);
    let r;
    try { r = await verifyBackup(file, key); }
    catch (e: any) { throw new AppError(400, 'BACKUP_UNREADABLE', e.message); }
    await db.transaction(async (tx) => { await writeAudit(tx, actor.id, 'BACKUP_VERIFIED', 'System', name, 'backup', '', r.ok ? 'ok' : r.problems.join('; '), 'Backup verification'); });
    res.json({ ok: r.ok, problems: r.problems, corruptFrame: r.corruptFrame, auditHead: r.manifest.auditHead, schemaVersion: r.manifest.schemaVersion ?? null });
  });

  router.get('/admin/backup/status', requireAuth, async (req, res) => {
    if (!['Admin', 'QA'].includes((req as any).user.role)) throw new ForbiddenError('Unauthorized');
    res.json(await backupStatus(db, backupSettings()));
  });

  router.post('/admin/backup/drill', requireAuth, validate(drillSchema), async (req, res) => {
    const actor = await adminWithPassword(req, 'a restore drill');
    const jobId = await publishTask('backup.drill', {}, { createdBy: actor.id, dedupeKey: 'backup.drill:requested' });
    res.json({ jobId });
  });

  router.use(jobsRoutes(ctx));
  return router;
};

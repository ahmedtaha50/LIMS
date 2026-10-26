// Domain: instruments (roadmap M13, r1-quality-fixes). A calibration is an electronic signature (CALIBRATION) by QA or an
// Administrator, through signRecord: the new due date must be after today, an Out of Service instrument stays out of service, and
// every calibration is an append-only calibration_history row written in the signing transaction.
import { randomBytes } from 'crypto';
import { desc, eq } from 'drizzle-orm';
import { calibrationHistory, instruments } from '../../db/schema';
import { writeAudit } from '../../db/utils';
import { calibrateSchema, instrumentSchema, utcToday } from '../../lib/validations/instruments';
import { securityEventContext } from '../auth/events';
import { recordDenied } from '../authz/denied';
import { type RouteContext } from '../core/context';
import { createRouter } from '../core/router';
import { lockRow, updateVersioned, withTransaction } from '../core/tx';
import { signRecord } from '../esign';
import { AppError, NotFoundError, ValidationError } from '../http/errors';
import { validate } from '../http/validate';
import { assertEditable } from '../workflow/entityStates';

/** Who may sign a calibration (roadmap M13; conservative default, see docs/changes/r1-quality-fixes.md). */
export const CALIBRATION_ROLES = ['QA', 'Admin'];

export const instrumentsRoutes = ({ db, requireAuth }: RouteContext) => {
  const router = createRouter();

  router.post('/instruments', requireAuth, validate(instrumentSchema), async (req, res) => {
    const user = (req as any).user;
    const { name, type, calibrationDueDate, lastCalibrationDate } = req.body as import('zod').infer<typeof instrumentSchema>;
    if (lastCalibrationDate > utcToday()) throw new ValidationError('The last calibration date cannot be in the future.', [{ path: 'lastCalibrationDate', message: 'The last calibration date cannot be in the future.' }]);
    if (calibrationDueDate <= lastCalibrationDate) throw new ValidationError('The calibration due date must be after the last calibration date.', [{ path: 'calibrationDueDate', message: 'The calibration due date must be after the last calibration date.' }]);

    const record = await withTransaction(db, async (tx) => {
      const row = { id: `INST-${randomBytes(4).toString('hex')}`, name, type, status: 'Active', calibrationDueDate, lastCalibrationDate, version: 1 };
      await tx.insert(instruments).values(row);
      await writeAudit(tx, user.id, 'Create', 'Instrument', row.id, 'all', '', JSON.stringify(row), 'Instrument registered');
      return row;
    });
    res.json(record);
  });

  router.post('/instruments/:id/calibrate', requireAuth, validate(calibrateSchema), async (req, res) => {
    const user = (req as any).user;
    const id = String(req.params.id);
    const { newDueDate, password, totpCode } = req.body as import('zod').infer<typeof calibrateSchema>;

    // Refusals that need no password come first, so they are never counted as failed signatures.
    if (!CALIBRATION_ROLES.includes(user.role)) {
      await recordDenied(db, req, user, { rule: 'instrument.calibrate', roles: CALIBRATION_ROLES, entity: 'Instrument', entityId: id });
      throw new AppError(403, 'ROLE_NOT_ALLOWED', 'A calibration is signed by QA or an Administrator.');
    }
    const today = utcToday();
    if (newDueDate <= today) {
      throw new ValidationError(`The new due date must be after today (${today}): the calibration is recorded as performed today.`, [{ path: 'newDueDate', message: 'The new due date must be after today.' }]);
    }
    const [inst] = await db.select({ id: instruments.id, status: instruments.status }).from(instruments).where(eq(instruments.id, id)).limit(1);
    if (!inst) throw new NotFoundError('Instrument not found');
    assertEditable('instrument', inst.status);

    const reason = 'Calibration performed and recorded';
    const { result } = await signRecord({
      db, user, meaningCode: 'CALIBRATION',
      credentials: { password, totpCode },
      entityType: 'Instrument', entityId: id,
      context: securityEventContext(req),
      execute: async (tx) => {
        // Under the row lock: a second calibration waits and then sees this one (no lost update, no fork in the due dates).
        const current = await lockRow(tx, instruments, id);
        assertEditable('instrument', current.status);
        // Calibration does not return an instrument to service: Out of Service stays until someone decides otherwise.
        const statusAfter = current.status === 'In Calibration' ? 'Active' : current.status;
        const row = await updateVersioned(tx, instruments, id, current.version, {
          calibrationDueDate: newDueDate, lastCalibrationDate: new Date().toISOString(), status: statusAfter,
        });
        await tx.insert(calibrationHistory).values({
          id: `CAL-${randomBytes(6).toString('hex')}`, instrumentId: id, performedBy: user.id,
          previousDueDate: current.calibrationDueDate, newDueDate,
          statusBefore: current.status, statusAfter, instrumentVersion: row.version, reason,
        });
        const warnings = statusAfter === 'Out of Service'
          ? ['The instrument remains Out of Service: the calibration is recorded, but returning it to service is a separate decision.']
          : [];
        return {
          recordVersion: row.version,
          audit: { action: 'Calibrate', field: 'calibrationDueDate', oldValue: current.calibrationDueDate, newValue: newDueDate, reason },
          result: { ...row, warnings },
        };
      },
    });
    res.json(result);
  });

  router.get('/instruments', requireAuth, async (_req, res) => {
    const rows = await db.select().from(instruments);
    const history = await db.select().from(calibrationHistory).orderBy(desc(calibrationHistory.instrumentVersion));
    const byInstrument = new Map<string, typeof history>();
    for (const h of history) {
      const list = byInstrument.get(h.instrumentId) ?? [];
      list.push(h);
      byInstrument.set(h.instrumentId, list);
    }
    res.json(rows.map(r => ({ ...r, calibrations: byInstrument.get(r.id) ?? [] })));
  });

  return router;
};

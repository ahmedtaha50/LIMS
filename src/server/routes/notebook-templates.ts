// Domain: notebook-templates (roadmap M12, r1-quality-fixes). A template is controlled content that worksheets start from: QA or
// Admin create it, with a strict schema and an audit entry in the same transaction.
import { randomBytes } from 'crypto';
import { notebookTemplates } from '../../db/schema';
import { writeAudit } from '../../db/utils';
import { notebookTemplateSchema } from '../../lib/validations/eln';
import { recordDenied } from '../authz/denied';
import { type RouteContext } from '../core/context';
import { createRouter } from '../core/router';
import { withTransaction } from '../core/tx';
import { AppError } from '../http/errors';
import { validate } from '../http/validate';

/** Who may create a template (conservative default; see docs/changes/r1-quality-fixes.md). */
export const TEMPLATE_AUTHOR_ROLES = ['QA', 'Admin'];

export const notebookTemplatesRoutes = ({ db, requireAuth }: RouteContext) => {
  const router = createRouter();

  router.get('/notebook-templates', requireAuth, async (_req, res) => {
    res.json(await db.select().from(notebookTemplates));
  });

  router.post('/notebook-templates', requireAuth, validate(notebookTemplateSchema), async (req, res) => {
    const user = (req as any).user;
    if (!TEMPLATE_AUTHOR_ROLES.includes(user.role)) {
      await recordDenied(db, req, user, { rule: 'notebook-template.create', roles: TEMPLATE_AUTHOR_ROLES });
      throw new AppError(403, 'ROLE_NOT_ALLOWED', 'Notebook templates are controlled content: only QA or an Administrator can create one.');
    }
    const { title, content } = req.body as { title: string; content: string };
    const template = await withTransaction(db, async (tx) => {
      const record = { id: 'TPL-' + randomBytes(5).toString('hex').toUpperCase(), title, content, createdBy: user.id };
      await tx.insert(notebookTemplates).values(record);
      await writeAudit(tx, user.id, 'Create', 'NotebookTemplate', record.id, 'all', '', JSON.stringify(record), 'Notebook template created');
      return record;
    });
    res.json(template);
  });

  return router;
};

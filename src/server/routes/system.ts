// Domain: system information. The version record an auditor or support engineer needs: application build, schema version,
// the migration journal. New in r1-migrations; register it in src/server/routes/index.ts (see docs/migrations.md).
import { sql } from 'drizzle-orm';
import { type RouteContext } from '../core/context';
import { createRouter } from '../core/router';
import { appVersion } from '../boot/version';
import { loadMigrations } from '../migrate';

export const systemRoutes = ({ db, requireAuth }: RouteContext) => {
  const router = createRouter();

  router.get('/system/info', requireAuth, async (req, res) => {
    const user = (req as any).user;
    const journalExists = await db.execute(sql`select to_regclass('public.schema_migrations') as t`);
    const journal = (journalExists as any).rows[0].t
      ? ((await db.execute(sql`select id, sha256, applied_at, app_version from schema_migrations order by id`)) as any).rows
      : [];
    const zone = ((await db.execute(sql`show timezone`)) as any).rows[0].TimeZone;

    let latestAvailable: string | null = null;
    try { latestAvailable = loadMigrations().at(-1)?.id ?? null; } catch { /* the folder is only needed to say whether the schema is current */ }
    const schemaVersion: string | null = journal.length ? journal[journal.length - 1].id : null;

    const body: Record<string, unknown> = {
      appVersion: appVersion(),
      schemaVersion,
      latestAvailableSchemaVersion: latestAvailable,
      schemaCurrent: latestAvailable === null ? null : schemaVersion === latestAvailable,
      databaseTimeZone: zone,
      serverTime: new Date().toISOString(),
    };
    // The journal (ids and checksums) is validation evidence for Admin and QA.
    if (user.role === 'Admin' || user.role === 'QA') {
      body.migrations = journal.map((r: any) => ({ id: r.id, sha256: r.sha256, appliedAt: r.applied_at, appVersion: r.app_version }));
    }
    res.json(body);
  });

  return router;
};

/**
 * Prints the INSERT statements that install the default matrix, from the catalog in src/lib/permissions.ts. Used once, to write
 * drizzle/0040_authz.sql; a later change to the matrix is a new migration, and this prints the full current state to diff against.
 *
 *   npx tsx scripts/authz/generate-seed.ts
 *
 * Every statement ends with `WHERE EXISTS (SELECT 1 FROM schema_migrations)`: the rows are installed when the migration runner
 * executes the file (it has journaled the earlier files by then) and not when a restore builds an empty database from the same SQL
 * (src/server/boot/schemaSql.ts, an empty journal), because a restore then loads the backup's own rows and the seed would collide.
 */
import { DEFAULT_MATRIX, PERMISSIONS, ROLE_DESCRIPTIONS, ROLE_NAMES, ROLES_REQUIRING_APPROVAL, SOD_RULES } from '../../src/lib/permissions';

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const GUARD = 'WHERE EXISTS (SELECT 1 FROM "schema_migrations")';
const roleId = (name: string) => `role-${name.toLowerCase()}`;

const out: string[] = [];
out.push(`INSERT INTO "roles" ("id", "name", "description", "is_system", "requires_approval")
SELECT v.* FROM (VALUES
${ROLE_NAMES.map(n => `  (${q(roleId(n))}, ${q(n)}, ${q(ROLE_DESCRIPTIONS[n])}, true, ${ROLES_REQUIRING_APPROVAL.includes(n)})`).join(',\n')}
) AS v("id", "name", "description", "is_system", "requires_approval")
${GUARD};`);

out.push(`INSERT INTO "permissions" ("code", "category", "description", "position")
SELECT v.* FROM (VALUES
${PERMISSIONS.map((p, i) => `  (${q(p.code)}, ${q(p.category)}, ${q(p.description)}, ${i + 1})`).join(',\n')}
) AS v("code", "category", "description", "position")
${GUARD};`);

const grants = ROLE_NAMES.flatMap(r => DEFAULT_MATRIX[r].map(c => `  (${q(roleId(r))}, ${q(c)})`));
out.push(`INSERT INTO "role_permissions" ("id", "role_id", "permission_code")
SELECT v."role_id" || ':' || v."permission_code", v."role_id", v."permission_code" FROM (VALUES
${grants.join(',\n')}
) AS v("role_id", "permission_code")
${GUARD};`);

out.push(`INSERT INTO "sod_rules" ("code", "description", "entity", "author_actions")
SELECT v.* FROM (VALUES
${SOD_RULES.map(r => `  (${q(r.code)}, ${q(r.description)}, ${q(r.entity)}, ARRAY[${r.authorActions.map(q).join(', ')}]::text[])`).join(',\n')}
) AS v("code", "description", "entity", "author_actions")
${GUARD};`);

console.log(out.join('\n\n'));

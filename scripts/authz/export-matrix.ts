/**
 * Writes docs/permission-matrix.csv, the permission matrix for access review (Annex 11 s.12): every permission, the roles that
 * hold it, and the routes it unlocks. Generated from src/lib/permissions.ts and the route table, no database needed.
 *
 *   npx tsx scripts/authz/export-matrix.ts           # rewrite the file
 *   npx tsx scripts/authz/export-matrix.ts --check   # exit 1 when the committed file is stale (CI)
 *
 * tests/api/route-contract.test.ts fails when the committed file differs from this output.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { matrixCsvFromCatalog } from '../../src/server/authz/csv';

const target = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'permission-matrix.csv');
const csv = matrixCsvFromCatalog();

if (process.argv.includes('--check')) {
  const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
  if (current !== csv) { console.error('docs/permission-matrix.csv is stale. Run: npx tsx scripts/authz/export-matrix.ts'); process.exit(1); }
  console.log('docs/permission-matrix.csv is current.');
} else {
  fs.writeFileSync(target, csv);
  console.log(`Wrote ${target} (${csv.trim().split('\n').length - 1} permissions).`);
}

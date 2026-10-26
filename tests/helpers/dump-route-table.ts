/**
 * Regenerates tests/route-table.json from the live application.
 *   npx tsx tests/helpers/dump-route-table.ts            # write tests/route-table.json
 *   npx tsx tests/helpers/dump-route-table.ts --stdout   # print only
 * Changing the file is a change-control event: the diff is the list of API surface changes.
 * No database connection is opened; the pool is created lazily.
 */
import fs from 'fs';
import path from 'path';
import { createApp } from '../../src/server/app';
import { db } from '../../src/db/index';
import { extractRouteTable, sortRouteTable } from './routeTable';

const routes = sortRouteTable(extractRouteTable(createApp({ db, rateLimit: false })));
const json = JSON.stringify({ routes }, null, 2) + '\n';
if (process.argv.includes('--stdout')) process.stdout.write(json);
else fs.writeFileSync(path.join(__dirname, '..', 'route-table.json'), json);

/**
 * Roadmap M43 acceptance 1: the first load is at most 700 KB of JavaScript, and the PDF stack, the scanner decoder and the charts are
 * not part of it. Reads dist/ (run `npx vite build` first); skipped when there is no build.
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { analyse, BUDGET_BYTES } = require('./bundle.cjs');

const dist = path.resolve(__dirname, '..', '..', 'dist');

describe.skipIf(!fs.existsSync(path.join(dist, 'index.html')))('the production bundle', () => {
  // Analysed inside the tests: the body of a skipped describe still runs while vitest collects, and dist/ is absent in CI.
  it('loads at most 700 KB of JavaScript for the first screen', () => {
    const r = analyse(dist);
    console.log(`first load ${(r.firstLoadBytes / 1024).toFixed(1)} KB, entry ${(r.entryBytes / 1024).toFixed(1)} KB, all JS ${(r.totalBytes / 1024).toFixed(1)} KB`);
    expect(r.firstLoadBytes).toBeLessThanOrEqual(BUDGET_BYTES);
  });
  it('keeps the PDF stack, the QR decoder and the charts out of the first load', () => {
    const r = analyse(dist);
    const first = r.firstLoad.map((f: { file: string }) => f.file).join(' ');
    for (const lazy of ['vendor-pdf', 'vendor-scanner', 'vendor-charts', 'Reports-', 'Dashboard-']) expect(first, lazy).not.toContain(lazy);
  });
});

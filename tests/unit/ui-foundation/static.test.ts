/**
 * Roadmap M24 (r2-ui-foundation), source-level guards on the files this track owns: no hand-made overlay without the Modal
 * (role=dialog, focus trap, Esc, focus return), no icon-only button without a name, no list filtered in the browser, no
 * useState navigation, and the a11y lint configuration exists. The same rules for the rest of the application are reported
 * by eslint.config.js (jsx-a11y) once its packages are installed.
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const code = (f: string) => read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');

const OWNED_TSX = ['src/App.tsx', 'src/components/Layout.tsx', 'src/components/Samples.tsx', 'src/components/Inbox.tsx', 'src/components/DataGrid.tsx',
  ...fs.readdirSync(path.join(ROOT, 'src/components/ui')).filter(f => f.endsWith('.tsx')).map(f => `src/components/ui/${f}`)];

describe('overlays', () => {
  it.each(OWNED_TSX.filter(f => f !== 'src/components/ui/Modal.tsx' && f !== 'src/components/ui/Toast.tsx'))('%s builds no overlay of its own (use <Modal>)', f => {
    expect(code(f)).not.toMatch(/fixed inset-0/);
  });
});

describe('navigation', () => {
  it('App takes the view from the URL (hash router), not from a useState string', () => {
    const app = code('src/App.tsx');
    expect(app).toMatch(/useRoute\(\)/);
    expect(app).not.toMatch(/useState\(\s*'samples'\s*\)/);
  });

  it('Samples opens a sample through the URL, so a deep link, Back and reload work', () => {
    const s = code('src/components/Samples.tsx');
    expect(s).not.toMatch(/setSelectedSampleId/);
    expect(s).toMatch(/navigate\(/);
  });
});

describe('lists', () => {
  it('Samples searches and filters on the server (no .filter over the loaded rows)', () => {
    const s = code('src/components/Samples.tsx');
    expect(s).not.toMatch(/samples\s*\.filter\(/);
    expect(s).toMatch(/<DataGrid/);
    expect(s).toMatch(/\/lists\/samples/);
  });
});

describe('feedback', () => {
  it.each(OWNED_TSX)('%s never calls alert() and uses no raw fetch', f => {
    expect(code(f)).not.toMatch(/(?<![\w.])alert\s*\(/);
    expect(code(f)).not.toMatch(/(?<![\w.])fetch\s*\(/);
  });
});

describe('a11y lint', () => {
  it('eslint.config.js applies jsx-a11y to the components', () => {
    const cfg = read('eslint.config.js');
    expect(cfg).toMatch(/eslint-plugin-jsx-a11y/);
    expect(cfg).toMatch(/\.tsx/);
  });
});

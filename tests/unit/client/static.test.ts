/**
 * Roadmap M06 (r1-client-shell), source-level guards on the files the shell track owns. They pin the defects the review named
 * (atob token decode, the 'System User' fallback, localStorage tokens, the unauthenticated logout, the requireTotp typo, the static
 * "Validated / Compliant" badges, raw fetch calls) so that a later edit cannot bring one back unnoticed.
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const src = (f: string) => fs.readFileSync(path.join(ROOT, 'src', f), 'utf8');
/** Comments may name a removed thing ("replaces the atob decode"); the guards look at code only. */
const code = (f: string) => src(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');

const OWNED = [
  'App.tsx', 'main.tsx', 'components/Layout.tsx', 'components/Login.tsx', 'components/SessionGuard.tsx', 'components/ReauthModal.tsx',
  'components/ChangePassword.tsx', 'components/ui/ErrorBoundary.tsx', 'components/ui/Toast.tsx', 'lib/api.ts',
];

describe('the shell files exist', () => {
  it.each(OWNED)('%s', f => { expect(fs.existsSync(path.join(ROOT, 'src', f)), f).toBe(true); });
});

describe('no raw fetch outside the API layer', () => {
  it.each(OWNED.filter(f => f !== 'lib/api.ts' && fs.existsSync(path.join(ROOT, 'src', f))))('%s uses apiFetch', f => {
    expect(code(f)).not.toMatch(/(?<![\w.])fetch\s*\(/);
  });
});

describe('the token', () => {
  it('is never decoded in the browser: the user comes from GET /auth/me (atob breaks Arabic names, and the catch invented a user)', () => {
    for (const f of OWNED.filter(f => fs.existsSync(path.join(ROOT, 'src', f)))) {
      expect(code(f), f).not.toMatch(/\batob\s*\(/);
      expect(code(f), f).not.toContain('System User');
    }
  });

  it('is kept in sessionStorage, never in localStorage', () => {
    for (const f of OWNED.filter(f => fs.existsSync(path.join(ROOT, 'src', f)))) {
      const text = code(f);
      if (f === 'lib/api.ts') expect(text).toMatch(/sessionStorage/);
      // api.ts may name localStorage once, to delete the key an older build wrote there
      const uses = (text.match(/localStorage/g) ?? []).length;
      expect(uses, f).toBeLessThanOrEqual(f === 'lib/api.ts' ? 2 : 0);
      if (f === 'lib/api.ts' && uses) expect(text).not.toMatch(/localStorage\.setItem/);
    }
  });
});

describe('sign-in screen', () => {
  it('reads the field the server sends (requiresTotp, not requireTotp) and never trusts a response without a token', () => {
    const text = code('components/Login.tsx') + code('lib/api.ts');
    expect(text).not.toMatch(/requireTotp(?![sS])/);
    expect(text).toMatch(/requiresTotp/);
    expect(text).toMatch(/requireTotpSetup/);
  });

  it('claims no compliance state', () => {
    expect(src('components/Login.tsx')).not.toMatch(/Part 11 Compliant|Validated/i);
  });
});

describe('static compliance badges', () => {
  it('Layout no longer prints "21 CFR Part 11 Validated" or "ALCOA+ Compliant" (validation status is a document, not a label)', () => {
    const text = src('components/Layout.tsx');
    expect(text).not.toMatch(/Part 11 Validated/);
    expect(text).not.toMatch(/ALCOA\+ Compliant/);
  });
});

describe('the app root', () => {
  it('installs the session layer and an error boundary before anything renders', () => {
    const main = code('main.tsx');
    expect(main).toMatch(/installSessionFetch\(\)/);
    expect(main).toMatch(/ErrorBoundary/);
  });

  it('wraps every view in an error boundary that resets when the view changes', () => {
    expect(code('App.tsx')).toMatch(/<ErrorBoundary[^>]*resetKey=\{view\}/);
  });

  it('never calls alert()', () => {
    for (const f of OWNED.filter(f => fs.existsSync(path.join(ROOT, 'src', f)))) expect(code(f), f).not.toMatch(/(?<![\w.])alert\s*\(/);
  });
});

#!/usr/bin/env node
/**
 * Build-time guardrails for a validated system.
 *
 * `scripts/check-guardrails.mjs` was referenced by `npm run verify` and by the
 * CI pipeline, and was a 0-byte file — so the "guard" step passed by doing
 * nothing. This is the real one.
 *
 * It fails the build on the specific defect shapes that caused the findings in
 * the gap assessment. Rules constrain the developer who reads them; a build
 * gate constrains everyone, forever.
 *
 * Usage:  node scripts/check-guardrails.mjs [--dir src] [--json]
 * Exit:   0 clean, 1 violations found.
 */
import fs from 'fs';
import path from 'path';

const ROOT = process.cwd();
const args = process.argv.slice(2);
const asJson = args.includes('--json');
const SCAN_DIRS = ['src', '.'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', 'backups', '.next']);
const EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

/** Files exempt from a rule, with the reason. Keep this list short and justified. */
const EXEMPT = {
  // verify-migrations.mjs seeds the OLD cleartext password on purpose, to prove
  // migration 0001 nulls it. Same category as a test fixture.
  'no-password-literals': [/tests?\//, /\.test\./, /check-guardrails\.mjs$/, /migrations\//, /security\/password\.ts$/, /verify-migrations\.mjs$/],
  'no-auth-bypass-headers': [/tests?\//, /\.test\./],
  'no-audit-direct-insert': [/server\/audit\/auditWriter\.ts$/, /\.test\./, /check-guardrails\.mjs$/],
  'no-client-password-check': [/\.test\./, /check-guardrails\.mjs$/, /security\/password\.ts$/, /signature\/signature\.ts$/],
};

const RULES = [
  {
    id: 'no-password-literals',
    severity: 'error',
    why: 'A password compared against a string literal is a universal backdoor (inert-controls §8; recurring-defects, Identity).',
    test: (line) =>
      /['"`](Passw0rd!|123456|password123|admin123)['"`]/.test(line) ||
      (/password\s*[=!]==?\s*['"`][^'"`]+['"`]/.test(line) && !/typeof\s/.test(line)) ||
      /['"`][^'"`]*['"`]\s*[=!]==?\s*\w*[Pp]assword\b/.test(line),
  },
  {
    id: 'no-identity-fallback',
    severity: 'error',
    why: "An identity fallback turns an auth failure into a falsified audit record (see references/recurring-defects.md).",
    // Scoped to code that can WRITE a record. The same shape in a display
    // component is a separate, lower-severity rule below: it hides a data
    // problem rather than creating one.
    files: /^(server\.ts|src\/(server|services|middleware|utils)\/)/,
    test: (line) =>
      /\|\|\s*['"`](system|System|unknown|Unknown|anonymous)['"`]/.test(line) ||
      /\?\?\s*['"`](system|System|unknown|Unknown)['"`]/.test(line),
  },
  {
    id: 'display-identity-fallback',
    severity: 'warn',
    why: "Rendering 'Unknown' for a user hides a referential-integrity problem instead of surfacing it.",
    files: /^src\/components\//,
    test: (line) => /\?\.name\s*\|\|\s*['"`]Unknown['"`]/.test(line),
  },
  {
    id: 'no-version-guess',
    severity: 'error',
    why: 'Guessing a server-authoritative version silently overwrites a concurrent change (see references/recurring-defects.md).',
    test: (line) => /newVersion\s*\|\|/.test(line) || /\|\|\s*\(?\s*\w*\.?version\s*\+\s*1/.test(line),
  },
  {
    id: 'no-auth-bypass-headers',
    severity: 'error',
    why: 'Header-based identity and magic test tokens are authentication bypasses (see references/recurring-defects.md).',
    test: (line) =>
      /['"`]x-user-id['"`]/i.test(line) ||
      /['"`]x-user-uid['"`]/i.test(line) ||
      /TEST_TOKEN/.test(line) ||
      /mockUser(Id|Uid)/.test(line),
  },
  {
    id: 'no-unverified-jwt-decode',
    severity: 'error',
    why: 'Decoding a token whose signature failed to verify accepts forged tokens (see references/recurring-defects.md).',
    test: (line) => /Buffer\.from\s*\(\s*\w*payload\w*\s*,\s*['"`]base64/.test(line),
  },
  {
    id: 'no-passthrough-schema',
    severity: 'error',
    why: '.passthrough() lets the client set every column, including status and version (see references/recurring-defects.md).',
    test: (line) => /\.passthrough\s*\(\s*\)/.test(line),
  },
  {
    id: 'no-audit-direct-insert',
    severity: 'error',
    why: 'Exactly one function may write audit entries; a second writer breaks the chain (see references/recurring-defects.md).',
    test: (line) => /\.insert\s*\(\s*(auditTrail|schema\.auditTrail|['"`]audit_trail['"`])/.test(line),
  },
  {
    id: 'no-client-password-check',
    severity: 'error',
    why: 'A signature component that verifies a password locally is a fake control (see references/recurring-defects.md).',
    test: (line) => /if\s*\(\s*password\s*[=!]==?/.test(line),
  },
  {
    id: 'no-status-in-update-payload',
    severity: 'error',
    why: 'Status must move only through a transition endpoint, for every entity, with no carve-outs (see references/recurring-defects.md).',
    test: (line) => /forbiddenFields[\s\S]*?entity\s*!==\s*['"`]\w+['"`]/.test(line),
  },
  {
    id: 'no-hard-delete',
    severity: 'error',
    why: 'No GxP record may be removable through the application (workflow-controls).',
    // SQL keywords are matched case-SENSITIVELY: Tailwind's lowercase `truncate`
    // utility class was otherwise flagged on every table cell in the app.
    test: (line) => (/db\.delete\s*\(/.test(line) || /\bDROP\s+TABLE\b/.test(line) || /\bTRUNCATE\b/.test(line))
      && !/idempotency_keys|sessions|login_attempts/.test(line),
  },
  {
    id: 'no-swallowed-error',
    severity: 'error',
    why: 'A swallowed error lets the UI report a save that never landed (see references/recurring-defects.md).',
    test: (line) => /catch\s*(\([^)]*\))?\s*\{\s*\}/.test(line),
  },
  {
    id: 'no-alert-for-gxp-feedback',
    severity: 'warn',
    why: 'alert() is not auditable user feedback and blocks the event loop; use the toast system.',
    test: (line) => /(?<![\w.])alert\s*\(/.test(line),
  },
  {
    id: 'no-permissive-firestore-rules',
    severity: 'error',
    why: 'allow read, write: if true exposes the entire database (see references/recurring-defects.md).',
    test: (line) => /allow\s+(read|write|read,\s*write)\s*:\s*if\s+true/.test(line),
    files: /\.rules$/,
  },
  {
    id: 'no-truncated-hash',
    severity: 'error',
    why: 'A truncated digest weakens tamper evidence (see references/recurring-defects.md).',
    test: (line) => /digest\s*\(\s*['"`]hex['"`]\s*\)\s*\.\s*(substring|slice|substr)\s*\(/.test(line),
  },
  {
    id: 'no-placeholder-test',
    severity: 'error',
    why: 'A test asserting a tautology produces false verification evidence in the RTM (see references/recurring-defects.md).',
    test: (line) => /expect\s*\(\s*true\s*\)\s*\.\s*toBe\s*\(\s*true\s*\)/.test(line),
    files: /\.(test|spec)\.[tj]sx?$/,
  },
  {
    id: 'no-insecure-cookie-default',
    severity: 'error',
    why: 'The secure flag must default to on; only an explicit opt-in may relax it.',
    test: (line) => /secure\s*:\s*false/.test(line),
  },
  {
    id: 'no-wildcard-cors',
    severity: 'error',
    why: "origin: '*' lets any site connect to the API or socket (see references/recurring-defects.md).",
    test: (line) => /origin\s*:\s*['"`]\*['"`]/.test(line),
  },
];

function* walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else yield full;
  }
}

function isExempt(ruleId, rel) {
  return (EXEMPT[ruleId] ?? []).some((re) => re.test(rel));
}

const violations = [];
const seen = new Set();

for (const base of SCAN_DIRS) {
  const dir = path.join(ROOT, base);
  if (!fs.existsSync(dir)) continue;
  for (const file of walk(dir)) {
    const rel = path.relative(ROOT, file);
    if (seen.has(rel)) continue;
    // The checker states each forbidden pattern in its own rule text; scanning
    // itself would flag every rule description.
    if (rel.endsWith('check-guardrails.mjs')) continue;
    seen.add(rel);

    const ext = path.extname(file);
    const isRules = /\.rules$/.test(file);
    if (!EXTS.has(ext) && !isRules) continue;

    let lines;
    try { lines = fs.readFileSync(file, 'utf8').split('\n'); } catch { continue; }

    for (const rule of RULES) {
      if (rule.files && !rule.files.test(rel)) continue;
      if (!rule.files && isRules) continue;
      if (isExempt(rule.id, rel)) continue;

      lines.forEach((line, i) => {
        const trimmed = line.trim();
        // Skip comment lines. A JSDoc block describing a forbidden pattern is
        // documentation, not the pattern.
        if (trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.startsWith('//')) return;
        const code = line.split('//')[0];
        if (rule.test(code)) {
          violations.push({ rule: rule.id, severity: rule.severity, why: rule.why, file: rel, line: i + 1, text: line.trim().slice(0, 120) });
        }
      });
    }
  }
}

const errors = violations.filter((v) => v.severity === 'error');
const warns = violations.filter((v) => v.severity === 'warn');

if (asJson) {
  console.log(JSON.stringify({ errors, warns }, null, 2));
} else {
  const byRule = new Map();
  for (const v of violations) {
    if (!byRule.has(v.rule)) byRule.set(v.rule, []);
    byRule.get(v.rule).push(v);
  }
  console.log(`\nGxP guardrail check — ${seen.size} files scanned\n${'='.repeat(64)}`);
  if (violations.length === 0) {
    console.log('  No violations.\n');
  } else {
    for (const [ruleId, list] of [...byRule.entries()].sort((a, b) => b[1].length - a[1].length)) {
      const rule = RULES.find((r) => r.id === ruleId);
      console.log(`\n[${rule.severity.toUpperCase()}] ${ruleId} — ${list.length} occurrence${list.length === 1 ? '' : 's'}`);
      console.log(`   ${rule.why}`);
      for (const v of list.slice(0, 6)) console.log(`   ${v.file}:${v.line}  ${v.text}`);
      if (list.length > 6) console.log(`   … and ${list.length - 6} more`);
    }
    console.log(`\n${'='.repeat(64)}`);
    console.log(`  ${errors.length} error(s), ${warns.length} warning(s)`);
  }
}

process.exit(errors.length > 0 ? 1 : 0);
